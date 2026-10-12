import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile, uploadForm } from '../../api/client';
import { btnPrimary, btnSecondary, fmtDate, fmtQty, inputCls } from './common';
import { PageHeader } from './StockLayout';

const STEPS = ['Задания', 'Поставка', 'Честный знак', 'Грузоместа', 'Печать', 'Передать в доставку'];

type State = { supply: any; orders: any[]; items: any[] };

// Мастер сборки поставки WB FBS
export default function WbWizard() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  async function load(sync = false) {
    setSyncing(sync);
    try { setData(await api.wbSupply(id!, sync)); setError(''); } catch (e: any) { setError(e.message); }
    setSyncing(false);
  }
  useEffect(() => { load(); }, [id]);

  const active = data?.orders.filter((o) => !o.canceled) ?? [];
  const cz = active.filter((o) => o.needCz);
  const czAssigned = cz.filter((o) => o.kiz || o.kizPending).length;
  const wbKiz = active.filter((o) => o.wbKiz);
  const czSent = wbKiz.filter((o) => o.kizSentAt && !KIZ_BAD(o.kizDecision)).length;
  const done = !!data?.supply.done;

  const auto = !data ? 0 : done ? 5 : active.length === 0 ? 0 : czAssigned < cz.length || czSent < wbKiz.length ? 2 : 4;
  const step = params.has('step') ? Number(params.get('step')) : auto;
  const go = (s: number) => setParams({ step: String(s) });
  const stepDone = [active.length > 0, active.length > 0 && !!data?.supply.shippingPointId, czAssigned === cz.length && czSent === wbKiz.length && active.length > 0, false, false, done];

  if (!data) return <div><Link to="/stock/wb" className="text-sm text-brand-700">← Отправки WB</Link>{error ? <p className="text-red-600 mt-3">{error}</p> : <p className="text-sm text-slate-500 mt-3">Загрузка поставки из WB…</p>}</div>;

  return (
    <div>
      <Link to="/stock/wb" className="text-sm text-brand-700 hover:underline">← Отправки WB</Link>
      <PageHeader title={<span>Поставка <span className="font-mono">{data.supply.id}</span></span>}
        hint={`${data.supply.name} · создана ${fmtDate(data.supply.createdAt)} · ${active.length} заданий${done ? ' · передана в доставку' : ''}`}>
        <button className={btnSecondary} disabled={syncing} onClick={() => load(true)}>{syncing ? 'Обновление…' : '↻ Обновить из WB'}</button>
      </PageHeader>

      <ol className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-6">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button onClick={() => go(i)} className={clsx('w-full text-left rounded-lg px-3 py-2.5 text-sm border transition',
              i === step ? 'bg-white border-brand-600 ring-2 ring-brand-600/20 font-semibold'
                : stepDone[i] ? 'bg-brand-50 border-brand-200 text-brand-800' : 'bg-white/60 border-slate-200 text-slate-500 hover:bg-white')}>
              <div className={clsx('text-[11px]', (i === step || stepDone[i]) && 'text-brand-600')}>{stepDone[i] ? '✓ ' : ''}Шаг {i + 1}</div>{s}
              {i === 2 && wbKiz.length > 0 && <div className="text-[11px] font-normal text-slate-500">{czSent}/{wbKiz.length} принято WB</div>}
            </button>
          </li>
        ))}
      </ol>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {step === 0 && <StepOrders data={data} reload={load} done={done} />}
      {step === 1 && <StepSupply data={data} reload={load} done={done} />}
      {step === 2 && <StepCz data={data} reload={load} done={done} assigned={czAssigned} total={cz.length} accepted={czSent} wbTotal={wbKiz.length} />}
      {step === 3 && <StepBoxes id={data.supply.id} done={done} />}
      {step === 4 && <StepPrint data={data} reload={load} />}
      {step === 5 && <StepDeliver data={data} reload={load} czLeft={wbKiz.length - czSent} />}

      <div className="flex justify-between mt-6">
        {step > 0 ? <button className={btnSecondary} onClick={() => go(step - 1)}>← {STEPS[step - 1]}</button> : <span />}
        {step < 5 && <button className={btnPrimary} onClick={() => go(step + 1)}>Дальше: {STEPS[step + 1].toLowerCase()} →</button>}
      </div>
    </div>
  );
}

function Panel({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
        <div><h2 className="font-semibold">{title}</h2>{hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}</div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

// YYYY-MM-DD по местному времени (toISOString дал бы дату по UTC — после полуночи по Москве это вчера)
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Проверка КИЗ в WB (metaDetails.decision)
const KIZ_OK = new Set(['sgtinIntroduced', 'sgtinSoldB2B']);
const KIZ_BAD = (d: string | null) => !!d && (d === 'required' || (d.startsWith('sgtin') && !KIZ_OK.has(d)));
const KIZ_LABEL: Record<string, string> = {
  filled: 'принят', sgtinIntroduced: 'в обороте ✓', sgtinSoldB2B: 'в обороте ✓', pending: 'проверяется', deadlineExceeded: 'проверяется',
  sgtinEmitted: 'эмитирован — не введён в оборот', sgtinApplied: 'нанесён — ввод в оборот не завершён', sgtinNotFound: 'не найден в ЧЗ',
  sgtinAppliedNotPaid: 'не оплачен', sgtinWrittenOff: 'списан', sgtinRetired: 'выбыл', sgtinWithdrawn: 'выведен из оборота',
  sgtinNoGS: 'нет разделителя GS', sgtinInvalidFormat: 'неверный формат', sgtinInvalidPattern: 'неверная структура', required: 'не указан',
};

const Badge = ({ cls, children }: { cls: string; children: React.ReactNode }) =>
  <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', cls)}>{children}</span>;

function useProducts() {
  const [p, setP] = useState<any[]>([]);
  useEffect(() => { api.getItems('PRODUCT').then(setP).catch(() => {}); }, []);
  return p;
}

// Сопоставление артикула WB с SKU портала
function MapArticle({ article, onDone }: { article: string; onDone: () => void }) {
  const products = useProducts();
  const [err, setErr] = useState('');
  return (
    <span className="inline-flex items-center gap-2">
      <select className={clsx(inputCls, 'w-64')} defaultValue="" onChange={async (e) => {
        if (!e.target.value) return;
        try { await api.wbMapArticle(article, e.target.value); onDone(); } catch (x: any) { setErr(x.message); }
      }}>
        <option value="">Какой это SKU портала?</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </span>
  );
}

// ───────────── 1. Задания ─────────────

function StepOrders({ data, reload, done }: { data: State; reload: (sync?: boolean) => void; done: boolean }) {
  const [fresh, setFresh] = useState<any[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadNew = () => api.wbNewOrders().then((r) => { setFresh(r); setPick(new Set(r.map((o) => o.id))); }).catch((e) => setError(e.message));
  useEffect(() => { if (!done) loadNew(); }, []);

  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const o of fresh ?? []) m.set(o.article, [...(m.get(o.article) ?? []), o]);
    return [...m.entries()];
  }, [fresh]);

  async function add() {
    setBusy(true); setError('');
    try { await api.wbAddOrders(data.supply.id, [...pick]); await loadNew(); reload(); } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="space-y-5">
      <Panel title="В поставке" hint="Задания, которые уже добавлены в эту поставку в WB">
        {data.items.length === 0 ? <p className="text-sm text-slate-500">Пока пусто — добавьте задания ниже.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="pb-2">Товар</th><th>Артикул WB</th><th className="text-right">Заданий</th><th className="text-right">ЧЗ</th></tr></thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.itemId ?? it.article} className="border-t border-slate-100">
                  <td className="py-2">{it.name ?? <MapArticle article={it.article} onDone={() => reload()} />}</td>
                  <td className="font-mono text-xs">{it.article}</td>
                  <td className="text-right font-semibold">{it.count}</td>
                  <td className="text-right">{it.requiresCz ? <Badge cls="bg-sky-100 text-sky-800">нужен</Badge> : <span className="text-slate-400 text-xs">нет</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {!done && (
        <Panel title="Новые задания WB" hint="Ещё не в поставке. Отметьте и добавьте — WB переведёт их «на сборку»."
          right={<button className="text-sm text-brand-700 hover:underline" onClick={loadNew}>↻ обновить</button>}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          {!fresh ? <p className="text-sm text-slate-500">Загрузка…</p> : fresh.length === 0 ? <p className="text-sm text-slate-500">Новых заданий нет.</p> : (
            <>
              <div className="space-y-2 mb-4">
                {groups.map(([article, list]) => {
                  const all = list.every((o) => pick.has(o.id));
                  return (
                    <label key={article} className="flex flex-wrap items-center gap-3 border border-slate-200 rounded-lg px-3 py-2.5 text-sm cursor-pointer hover:bg-slate-50">
                      <input type="checkbox" checked={all} onChange={() => {
                        const n = new Set(pick);
                        list.forEach((o) => (all ? n.delete(o.id) : n.add(o.id)));
                        setPick(n);
                      }} />
                      <span className="flex-1 min-w-[200px]">{list[0].item?.name ?? <span className="text-amber-700">артикул {article} не сопоставлен</span>}</span>
                      {!list[0].item && <MapArticle article={article} onDone={loadNew} />}
                      <span className="font-mono text-xs text-slate-500">{article}</span>
                      <b>{list.length} шт.</b>
                    </label>
                  );
                })}
              </div>
              <button className={btnPrimary} disabled={!pick.size || busy} onClick={add}>{busy ? 'Добавление…' : `Добавить в поставку (${pick.size})`}</button>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}

// ───────────── 2. Поставка ─────────────

function StepSupply({ data, reload, done }: { data: State; reload: (sync?: boolean) => void; done: boolean }) {
  const s = data.supply;
  const active = data.orders.filter((o) => !o.canceled);
  const withSticker = active.filter((o) => o.stickerB).length;
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadPickList(f: File) {
    setMsg('');
    try {
      const r = await uploadForm<{ matched: number }>(`/stock/wb/supplies/${encodeURIComponent(s.id)}/picklist`, f);
      setMsg(`Номера стикеров взяты из листа подбора: ${r.matched}`);
      reload();
    } catch (e: any) { setMsg(e.message); }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_380px] gap-5">
      <div className="space-y-5">
        <Panel title="Состав и остатки" hint="Хватит ли товара на складе портала и кодов ЧЗ">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="pb-2">Товар</th><th className="text-right">Заданий</th><th className="text-right">Без ЧЗ</th><th className="text-right">С ЧЗ</th><th className="text-right">Свободных кодов</th></tr></thead>
            <tbody>
              {data.items.map((it) => {
                const stock = it.unlabeled + it.labeled;
                return (
                  <tr key={it.itemId ?? it.article} className="border-t border-slate-100">
                    <td className="py-2">{it.name ?? <span className="text-amber-700">артикул {it.article} — сопоставьте на шаге 1</span>}</td>
                    <td className="text-right font-semibold">{it.count}</td>
                    <td className={clsx('text-right', stock < it.count && 'text-red-600')}>{fmtQty(it.unlabeled)}</td>
                    <td className="text-right">{fmtQty(it.labeled)}</td>
                    <td className={clsx('text-right', it.requiresCz && it.freeCodes + it.labeled < it.count && 'text-red-600')}>{it.requiresCz ? it.freeCodes : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
        <Panel title="Стикеры заданий" hint="Номера стикеров нужны, чтобы печатать объединённые стикеры в порядке листа подбора">
          <p className="text-sm">Получено из WB: <b>{active.filter((o) => o.hasSticker).length}</b> из {active.length} · номера известны у {withSticker}</p>
          {s.stickerError && (
            <div className="mt-3 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
              <p className="text-amber-900">WB не отдаёт стикеры по API: <span className="text-xs">{s.stickerError}</span></p>
              <p className="text-amber-900">Скачайте в кабинете WB «Лист подбора» этой поставки (PDF) и загрузите сюда — номера стикеров возьмутся из него. Сами стикеры печатайте из кабинета.</p>
              <button className={btnSecondary} onClick={() => fileRef.current?.click()}>Загрузить лист подбора</button>
              <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && uploadPickList(e.target.files[0])} />
            </div>
          )}
          {msg && <p className="text-sm mt-2 text-slate-700">{msg}</p>}
        </Panel>
      </div>
      <Shipping supply={s} done={done} onSaved={() => reload()} />
    </div>
  );
}

function Shipping({ supply, done, onSaved }: { supply: any; done: boolean; onSaved: () => void }) {
  const [city, setCity] = useState('');
  const [points, setPoints] = useState<any[]>([]);
  const [pointId, setPointId] = useState<string>(supply.shippingPointId ? String(supply.shippingPointId) : '');
  const [pointName, setPointName] = useState('');
  const [type, setType] = useState(supply.shippingType ?? 'selfShipping');
  const today = localDate();
  // Сохранённая дата могла уже пройти — WB принимает только сегодня и позже
  const [date, setDate] = useState(supply.shippingDt && supply.shippingDt >= today ? supply.shippingDt : today);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.wbShippingDefaults().then((d) => {
      if (!d) return;
      setCity(d.city ?? '');
      if (!supply.shippingPointId) { setPointId(String(d.shippingPointId)); setType(d.shippingType); }
      setPointName(d.pointName ?? '');
    }).catch(() => {});
  }, []);

  async function search() {
    try { setPoints(await api.wbShippingPoints(city, supply.cargoType ?? 1)); } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  }
  async function save() {
    setMsg(null);
    try {
      const p = points.find((x) => String(x.id) === pointId);
      await api.wbSetShipping(supply.id, { shippingType: type, shippingPointId: Number(pointId), shippingDt: date, pointName: p ? `${p.name}, ${p.address}` : pointName, city });
      setMsg({ ok: true, text: 'Способ отгрузки передан в WB' });
      onSaved();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  }

  return (
    <Panel title="Отгрузка" hint="WB требует указать до передачи в доставку">
      <div className="space-y-3 text-sm">
        <label className="block"><span className="text-xs text-slate-500">Способ</span>
          <select className={clsx(inputCls, 'w-full mt-0.5')} value={type} disabled={done} onChange={(e) => setType(e.target.value)}>
            <option value="selfShipping">Сам отвожу</option>
            <option value="transportCompany">Транспортная компания</option>
          </select>
        </label>
        <label className="block"><span className="text-xs text-slate-500">Дата отгрузки</span>
          <input type="date" min={today} className={clsx(inputCls, 'w-full mt-0.5')} value={date} disabled={done} onChange={(e) => setDate(e.target.value)} />
        </label>
        <div>
          <span className="text-xs text-slate-500">Пункт приёма</span>
          <div className="flex gap-2 mt-0.5">
            <input className={clsx(inputCls, 'flex-1')} placeholder="Город" value={city} disabled={done} onChange={(e) => setCity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
            <button className={btnSecondary} disabled={done || city.length < 2} onClick={search}>Найти</button>
          </div>
          {points.length > 0 ? (
            <select className={clsx(inputCls, 'w-full mt-2')} value={pointId} onChange={(e) => setPointId(e.target.value)}>
              <option value="">Выберите пункт…</option>
              {points.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.address}</option>)}
            </select>
          ) : pointId ? <p className="text-xs text-slate-600 mt-2">Пункт №{pointId}{pointName ? `: ${pointName}` : ''}</p> : null}
        </div>
        {!done && <button className={btnPrimary} disabled={!pointId || !date} onClick={save}>Сохранить в WB</button>}
        {supply.shippingPointId && <p className="text-xs text-green-700">В WB: {supply.shippingType === 'selfShipping' ? 'сам' : 'ТК'} · пункт {supply.shippingPointId} · {supply.shippingDt}</p>}
        {msg && <p className={clsx('text-sm', msg.ok ? 'text-green-700' : 'text-red-600')}>{msg.text}</p>}
      </div>
    </Panel>
  );
}

// ───────────── 3. Честный знак ─────────────

function StepCz({ data, reload, done, assigned, total, accepted, wbTotal }: { data: State; reload: () => void; done: boolean; assigned: number; total: number; accepted: number; wbTotal: number }) {
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [progress, setProgress] = useState('');
  const orders = data.orders.filter((o) => !o.canceled && (o.needCz || o.needExpiration));
  const czOrders = orders.filter((o) => o.needCz);
  const errors = orders.filter((o) => o.kizError || o.expirationError);
  const rejected = orders.filter((o) => o.wbKiz && o.kizSentAt && KIZ_BAD(o.kizDecision));
  const expNeeded = data.orders.filter((o) => !o.canceled && o.needExpiration);

  async function assign(mode: 'fresh' | 'loose') {
    const text = mode === 'fresh'
      ? `Взять ${total - assigned} новых кодов из базы и напечатать объединённые стикеры?\nБанки перейдут из «без ЧЗ» в «с ЧЗ» (документ «Маркировка»).`
      : 'Взять коды с уже промаркированных банок (россыпь «с ЧЗ»)? Ничего не печатается.';
    if (!confirm(text)) return;
    setBusy(mode); setNotes([]);
    try {
      const r = await api.wbAssign(data.supply.id, mode);
      setNotes([...(r.printed ? [`Напечатано кодов: ${r.printed} — стикеры генерируются, они появятся на шаге «Печать»`] : []), ...r.notes]);
      reload();
    } catch (e: any) { setNotes([e.message]); }
    setBusy('');
  }

  async function doScan() {
    const code = scan.trim();
    if (!code) return;
    setScan('');
    try {
      const r = await api.wbScan(data.supply.id, code);
      setScanMsg({ ok: true, text: `Код привязан к заданию ${r.orderId}` });
      reload();
    } catch (e: any) { setScanMsg({ ok: false, text: e.message }); }
  }

  async function send() {
    setBusy('send'); setNotes([]);
    const errs: string[] = [];
    try {
      for (let i = 0; i < 40; i++) {
        const r = await api.wbSendMeta(data.supply.id);
        errs.push(...r.errors);
        setProgress(r.remaining ? `осталось ${r.remaining}…` : '');
        if (!r.remaining) break;
      }
      setNotes(errs.length ? [`Ошибок: ${errs.length}`, ...errs.slice(0, 5)] : ['Отправлено в WB']);
    } catch (e: any) { setNotes([e.message]); }
    setProgress(''); setBusy('');
    reload();
  }

  async function resend() {
    setBusy('resend'); setNotes([]);
    try {
      const r = await api.wbResendRejected(data.supply.id);
      setNotes([`Отправлено повторно: ${r.sent} из ${r.reset}. Проверка в WB занимает несколько минут — нажмите «Обновить из WB».`, ...r.errors.slice(0, 5)]);
    } catch (e: any) { setNotes([e.message]); }
    setBusy('');
    reload();
  }

  async function detach(o: any) {
    if (!confirm(`Отвязать код от задания ${o.id}? Код останется на банке («с ЧЗ»).${o.kizSentAt ? '\nВ WB код тоже будет удалён.' : ''}`)) return;
    try { await api.wbDetach(data.supply.id, o.id); reload(); } catch (e: any) { setNotes([e.message]); }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-5">
      <Panel title="Привяжите коды Честного знака" hint="Коды берутся из базы раздела «Маркировка». Срок годности отправляется из партии.">
        <div className="flex items-center gap-3 mb-1 text-sm"><span className="w-28 text-slate-500">Назначено</span><Bar v={assigned} t={total} /><b>{assigned} / {total}</b></div>
        {wbTotal > 0 && <div className="flex items-center gap-3 mb-4 text-sm"><span className="w-28 text-slate-500">Принято WB</span><Bar v={accepted} t={wbTotal} /><b>{accepted} / {wbTotal}</b></div>}
        {total > wbTotal && <p className="text-xs text-slate-500 mb-3">{total - wbTotal} заданий маркируются, но WB не принимает для них КИЗ (у товара на WB нет поля ЧЗ) — коды остаются в портале.</p>}
        {rejected.length > 0 && (
          <div className="text-sm bg-red-50 border border-red-200 rounded-lg p-3 mb-4 space-y-2">
            <p className="text-red-800"><b>WB отклонил {rejected.length} КИЗ</b>: {KIZ_LABEL[rejected[0].kizDecision] ?? rejected[0].kizDecision}.</p>
            <p className="text-red-800">Коды нужно ввести в оборот в личном кабинете Честного знака (документ «Ввод в оборот»), затем нажать «Отправить отклонённые повторно».</p>
            <div className="flex flex-wrap gap-2">
              <button className={btnSecondary} onClick={() => downloadFile(`/stock/wb/supplies/${encodeURIComponent(data.supply.id)}/ki.csv`, `КИ ${data.supply.id}.csv`).catch((e) => setNotes([e.message]))}>⇩ Коды для ввода в оборот (.csv)</button>
              <button className={btnPrimary} disabled={!!busy} onClick={resend}>{busy === 'resend' ? 'Отправка…' : 'Отправить отклонённые повторно'}</button>
            </div>
          </div>
        )}

        {!done && (
          <>
            <label className="block text-sm text-slate-600 mb-1">Сканер: DataMatrix с банки — код встанет в следующее задание этого товара</label>
            <input className="w-full border-2 border-brand-500 rounded-lg px-4 py-3 font-mono text-sm mb-1 focus:outline-none" placeholder="Отсканируйте код ЧЗ…" value={scan}
              onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doScan()} />
            {scanMsg && <p className={clsx('text-sm mb-2', scanMsg.ok ? 'text-green-700' : 'text-red-600')}>{scanMsg.text}</p>}
            <div className="flex flex-wrap gap-2 my-4">
              <button className={btnPrimary} disabled={!!busy || assigned >= total} onClick={() => assign('fresh')}>{busy === 'fresh' ? 'Назначение…' : `Напечатать новые ЧЗ (${total - assigned})`}</button>
              <button className={btnSecondary} disabled={!!busy || assigned >= total} onClick={() => assign('loose')}>Взять с промаркированных банок</button>
              <button className={btnSecondary} disabled={!!busy} onClick={send}>{busy === 'send' ? `Отправка… ${progress}` : 'Отправить в WB'}</button>
              {errors.length > 0 && <button className="text-sm text-brand-700 hover:underline" onClick={async () => { await api.wbResetErrors(data.supply.id); reload(); }}>Повторить с ошибками ({errors.length})</button>}
            </div>
          </>
        )}
        {notes.length > 0 && <div className="text-sm bg-slate-50 rounded-lg p-3 mb-4 space-y-1">{notes.map((n, i) => <p key={i}>{n}</p>)}</div>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-1.5">Задание</th><th>Стикер</th><th>Товар</th><th>Партия / годен до</th><th>КИЗ</th><th>WB</th><th /></tr></thead>
            <tbody>
              {czOrders.map((o) => (
                <tr key={o.id} className={clsx('border-t border-slate-100', !o.kiz && !o.kizPending && 'bg-red-50/50')}>
                  <td className="py-1.5 font-mono">{o.id}</td>
                  <td className="font-mono">{o.stickerA} <span className="text-fuchsia-600">{o.stickerB}</span></td>
                  <td>{o.itemName ?? o.article}</td>
                  <td className="text-xs">{o.lot ? <>{o.lot.number} · {fmtDate(o.lot.expiresAt)}</> : '—'}</td>
                  <td className="font-mono text-xs">{o.kiz ? `${o.kiz.slice(0, 24)}…` : o.kizPending ? <span className="text-amber-700">распознаётся…</span> : <span className="text-red-600">нет кода</span>}</td>
                  <td className="text-xs">{!o.wbKiz ? <span className="text-slate-400">не нужен</span>
                    : o.kizError ? <span className="text-red-600" title={o.kizError}>ошибка</span>
                    : o.kizSentAt ? <span className={KIZ_BAD(o.kizDecision) ? 'text-red-600' : 'text-green-700'}>{KIZ_LABEL[o.kizDecision] ?? o.kizDecision ?? 'отправлен'}</span> : '—'}</td>
                  <td className="text-right">{(o.kiz || o.kizPending) && !done && <button className="text-xs text-slate-500 hover:text-red-600" onClick={() => detach(o)}>отвязать</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {czOrders.length === 0 && <p className="text-sm text-slate-500">В поставке нет товаров с обязательной маркировкой.</p>}
        </div>
      </Panel>
      <aside className="space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-sm space-y-2">
          <div className="font-semibold">Как это работает</div>
          <p><b>Напечатать новые ЧЗ</b> — коды из базы SKU, партии по FEFO из «без ЧЗ». Объединённые стикеры (EAN-13 + ЧЗ + партия + годен до) — на шаге «Печать».</p>
          <p><b>С промаркированных банок</b> — если банки уже оклеены в «Маркировке».</p>
          <p><b>Сканер</b> — привязать код конкретной банки.</p>
        </div>
        {expNeeded.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-sm">
            <div className="font-semibold mb-1">Срок годности в WB</div>
            <p>Нужен у {expNeeded.length} заданий · отправлено {expNeeded.filter((o) => o.expirationSent).length}</p>
            <p className="text-xs text-slate-500 mt-1">Берётся из партии; уходит вместе с ЧЗ кнопкой «Отправить в WB».</p>
          </div>
        )}
      </aside>
    </div>
  );
}

const Bar = ({ v, t }: { v: number; t: number }) => (
  <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${t ? (v / t) * 100 : 0}%` }} /></div>
);

// ───────────── 4. Грузоместа ─────────────

function StepBoxes({ id, done }: { id: string; done: boolean }) {
  const [boxes, setBoxes] = useState<{ id: string }[] | null>(null);
  const [amount, setAmount] = useState('1');
  const [error, setError] = useState('');
  const load = () => api.wbTrbx(id).then(setBoxes).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  async function add() {
    setError('');
    try { await api.wbAddTrbx(id, Number(amount)); load(); } catch (e: any) { setError(e.message); }
  }
  async function remove(ids: string[]) {
    if (!confirm(`Удалить ${ids.length === 1 ? `грузоместо ${ids[0]}` : `${ids.length} грузомест`}?`)) return;
    try { await api.wbDeleteTrbx(id, ids); load(); } catch (e: any) { setError(e.message); }
  }

  return (
    <Panel title="Грузоместа" hint="Короба или пакеты поставки — нужны при отгрузке в пункт приёма. Стикеры — QR WB."
      right={boxes && boxes.length > 0 ? <button className="text-sm text-brand-700 hover:underline" onClick={() => downloadFile(`/stock/wb/supplies/${encodeURIComponent(id)}/pdf/trbx`, `Грузоместа ${id}.pdf`).catch((e) => setError(e.message))}>🖨 Стикеры грузомест</button> : undefined}>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {!boxes ? <p className="text-sm text-slate-500">Загрузка…</p> : (
        <div className="flex flex-wrap gap-3 mb-4">
          {boxes.map((b, i) => (
            <div key={b.id} className="border border-slate-200 rounded-lg px-4 py-3 text-sm">
              <div className="text-xs text-slate-500">Место {i + 1}</div>
              <div className="font-mono font-semibold">{b.id}</div>
              {!done && <button className="text-xs text-slate-500 hover:text-red-600 mt-1" onClick={() => remove([b.id])}>удалить</button>}
            </div>
          ))}
          {boxes.length === 0 && <p className="text-sm text-slate-500">Грузомест нет.</p>}
        </div>
      )}
      {!done && (
        <div className="flex items-center gap-2">
          <input className={clsx(inputCls, 'w-20 text-center')} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
          <button className={btnPrimary} disabled={!Number(amount)} onClick={add}>Добавить грузоместа</button>
        </div>
      )}
    </Panel>
  );
}

// ───────────── 5. Печать ─────────────

function StepPrint({ data, reload }: { data: State; reload: () => void }) {
  const id = data.supply.id;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [upl, setUpl] = useState<string[]>([]);
  const stickersRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const active = data.orders.filter((o) => !o.canceled);
  const withSticker = active.filter((o) => o.hasSticker).length;
  const withNumber = active.filter((o) => o.stickerB).length;
  const noSticker = active.filter((o) => !o.hasSticker);
  const combo = active.filter((o) => o.labelBatch).length;
  const generating = active.some((o) => o.labelBatch && o.labelBatch.jobStatus !== 'done');

  async function dl(kind: string, name: string) {
    setBusy(kind); setError('');
    try { await downloadFile(`/stock/wb/supplies/${encodeURIComponent(id)}/${kind}`, name); } catch (e: any) { setError(e.message); }
    setBusy('');
  }

  async function uploadPick(f: File) {
    setBusy('pick'); setError(''); setUpl([]);
    try {
      const r = await uploadForm<{ matched: number }>(`/stock/wb/supplies/${encodeURIComponent(id)}/picklist`, f);
      setUpl([`Лист подбора: номера стикеров у ${r.matched} заданий`]);
      reload();
    } catch (e: any) { setError(e.message); }
    setBusy('');
  }

  async function uploadStickers(f: File) {
    setBusy('st'); setError(''); setUpl([]);
    try {
      const r = await uploadForm<{ pages: number; matched: number; unmatched: string[]; unreadable: number[]; missing: number }>(`/stock/wb/supplies/${encodeURIComponent(id)}/stickers`, f);
      setUpl([
        `Стикеров в файле: ${r.pages} · сопоставлено с заданиями: ${r.matched}`,
        ...(r.unmatched.length ? [`Не из этой поставки: ${r.unmatched.length} (${r.unmatched.slice(0, 5).join(', ')}${r.unmatched.length > 5 ? '…' : ''})`] : []),
        ...(r.unreadable.length ? [`Не прочитаны страницы: ${r.unreadable.slice(0, 10).join(', ')}`] : []),
        ...(r.missing ? [`Без стикера осталось заданий: ${r.missing}`] : []),
      ]);
      reload();
    } catch (e: any) { setError(e.message); }
    setBusy('');
  }

  const rows: [string, string, string, string, boolean][] = [
    ['pdf/combo', 'Объединённые стикеры (EAN-13 + ЧЗ)', `${combo} шт. · макет этикетки SKU с партией и сроком годности · номер стикера WB в углу${generating ? ' · ещё генерируются' : ''}`, `Стикеры ЧЗ ${id}.pdf`, combo > 0],
    ['pdf/pairs', 'Попарно: стикер WB → стикер ЧЗ', `Один рулон: на каждую банку два стикера подряд, стикер WB вписан в размер этикетки${noSticker.length ? ` · без стикера WB: ${noSticker.map((o) => o.id).slice(0, 3).join(', ')}${noSticker.length > 3 ? '…' : ''} — только стикер ЧЗ` : ''}`, `Стикеры WB + ЧЗ ${id}.pdf`, withSticker > 0 && combo > 0],
    ['pdf/trbx', 'Стикеры грузомест', 'QR WB, по одному на место', `Грузоместа ${id}.pdf`, true],
    ['pdf/qr', 'Стикер поставки (QR)', data.supply.done ? 'QR WB' : 'Доступен после передачи в доставку', `QR поставки ${id}.pdf`, !!data.supply.done],
  ];

  return (
    <Panel title="Печать и выгрузки" hint="Все PDF — в одном порядке, как лист подбора WB">
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      <div className="divide-y divide-slate-100">
        <div className="py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[240px]">
              <div className="font-medium">Стикеры заданий WB</div>
              <div className="text-sm text-slate-500">Есть у {withSticker} из {active.length} заданий · номера стикеров известны у {withNumber}</div>
            </div>
            <button className={btnSecondary} disabled={!!busy} onClick={() => pickRef.current?.click()}>{busy === 'pick' ? 'Загрузка…' : 'Лист подбора (PDF)'}</button>
            <button className={btnSecondary} disabled={!!busy || !withNumber} title={withNumber ? '' : 'Сначала загрузите лист подбора'} onClick={() => stickersRef.current?.click()}>{busy === 'st' ? 'Проверка…' : 'Загрузить стикеры (PDF)'}</button>
            <button className={withSticker ? btnPrimary : btnSecondary} disabled={!withSticker || !!busy} onClick={() => dl('pdf/stickers', `Стикеры заданий ${id}.pdf`)}>{busy === 'pdf/stickers' ? 'Готовлю…' : '⇩ PDF'}</button>
            <input ref={pickRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadPick(f); }} />
            <input ref={stickersRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadStickers(f); }} />
          </div>
          {withSticker < active.length && (
            <p className="text-xs text-slate-500 mt-2">WB не отдаёт стикеры по API — скачайте в кабинете WB «Лист подбора» и «Стикеры» этой поставки и загрузите сюда: портал сверит номер каждого стикера с заданием.</p>
          )}
          {upl.length > 0 && <div className="text-sm bg-slate-50 rounded-lg p-3 mt-2 space-y-0.5">{upl.map((t, i) => <p key={i}>{t}</p>)}</div>}
        </div>
        {rows.map(([kind, title, hint, name, ok]) => (
          <div key={kind} className="flex flex-wrap items-center gap-3 py-3">
            <div className="flex-1 min-w-[240px]"><div className="font-medium">{title}</div><div className="text-sm text-slate-500">{hint}</div></div>
            <button className={ok ? btnPrimary : btnSecondary} disabled={!ok || !!busy} onClick={() => dl(kind, name)}>{busy === kind ? 'Готовлю…' : '⇩ PDF'}</button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 py-3">
          <div className="flex-1 min-w-[240px]"><div className="font-medium">Таблица использованных ЧЗ</div><div className="text-sm text-slate-500">Формат шаблона WB: № задания, Стикер, КИЗ, Бренд, Наименование, Артикул (+ партия)</div></div>
          <button className={btnSecondary} disabled={!!busy} onClick={() => downloadFile(`/stock/wb/cz.xlsx?supplies=${encodeURIComponent(id)}`, `ЧЗ ${id}.xlsx`).catch((e) => setError(e.message))}>⇩ .xlsx</button>
        </div>
      </div>
    </Panel>
  );
}

// ───────────── 6. Передать в доставку ─────────────

function StepDeliver({ data, reload, czLeft }: { data: State; reload: () => void; czLeft: number }) {
  const s = data.supply;
  const [writeOff, setWriteOff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const active = data.orders.filter((o) => !o.canceled);
  const checks: [string, boolean][] = [
    ['Есть задания в поставке', active.length > 0],
    ['Все артикулы сопоставлены с SKU', active.every((o) => o.itemId)],
    ['КИЗ приняты WB (коды в обороте)', czLeft === 0],
    ['Способ отгрузки указан', !!s.shippingPointId],
  ];
  const ready = checks.every(([, ok]) => ok);

  async function deliver() {
    if (!confirm(`Передать поставку ${s.id} в доставку? После этого в неё нельзя добавить задания.${writeOff ? `\nСо склада спишется ${active.length} шт.` : ''}`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.wbDeliver(s.id, writeOff);
      setMsg(r.stockError ? { ok: false, text: `Поставка передана, но списание не выполнено: ${r.stockError}` } : { ok: true, text: 'Поставка передана в доставку' });
      reload();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }
  async function retryWriteOff() {
    try { await api.wbWriteOff(s.id); setMsg({ ok: true, text: 'Списано со склада' }); reload(); } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  }

  return (
    <Panel title={s.done ? 'Поставка передана в доставку' : 'Передать в доставку'} hint="WB закроет поставку и переведёт задания в «в доставке»">
      <div className="space-y-1.5 mb-4">
        {checks.map(([t, ok]) => <div key={t} className="flex gap-2 text-sm"><span className={ok ? 'text-green-600' : 'text-slate-300'}>{ok ? '✓' : '○'}</span>{t}</div>)}
      </div>
      {!s.done ? (
        <>
          <label className="flex items-center gap-2 text-sm mb-4"><input type="checkbox" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} />Списать {active.length} шт. со склада портала (с ЧЗ — из «с ЧЗ» своей партии, без ЧЗ — из «без ЧЗ»)</label>
          <button className="px-4 py-2 rounded-lg text-sm font-medium bg-fuchsia-600 hover:bg-fuchsia-700 text-white disabled:opacity-50" disabled={!ready || busy} onClick={deliver}>{busy ? 'Передача…' : 'Передать в доставку'}</button>
        </>
      ) : (
        <div className="flex flex-wrap gap-2 items-center">
          <button className={btnPrimary} onClick={() => downloadFile(`/stock/wb/supplies/${encodeURIComponent(s.id)}/pdf/qr`, `QR поставки ${s.id}.pdf`).catch((e) => setMsg({ ok: false, text: e.message }))}>⇩ QR поставки</button>
          {s.stockDocId ? <span className="text-sm text-green-700">Списано со склада</span> : <button className={btnSecondary} onClick={retryWriteOff}>Списать со склада</button>}
        </div>
      )}
      {msg && <p className={clsx('text-sm mt-3', msg.ok ? 'text-green-700' : 'text-red-600')}>{msg.text}</p>}
    </Panel>
  );
}
