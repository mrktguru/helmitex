import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { btnPrimary, btnSecondary, fmtMoney, fmtQty } from './common';
import { PageHeader } from './StockLayout';

// Отправки Ozon FBS: все текущие заказы → сборка группами (квант по лимиту / заказы по N шт / вручную) → этикетки → поставка

const PASSED = ['delivering', 'driver_pickup', 'delivered', 'not_accepted'];
const ST: Record<string, [string, string]> = {
  awaiting_packaging: ['Ждёт сборки', 'bg-amber-100 text-amber-800'],
  awaiting_deliver: ['Собрано', 'bg-blue-100 text-blue-800'],
  carriage: ['В поставке', 'bg-indigo-100 text-indigo-800'],
  delivering: ['Передано', 'bg-emerald-100 text-emerald-800'],
  driver_pickup: ['У водителя', 'bg-emerald-100 text-emerald-800'],
  delivered: ['Доставлено', 'bg-emerald-200 text-emerald-900'],
  not_accepted: ['Не принято', 'bg-rose-100 text-rose-700'],
  cancelled: ['Отменено', 'bg-slate-100 text-slate-500'],
};
const pill = (k: string) => <span className={clsx('text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', ST[k]?.[1] ?? 'bg-slate-100 text-slate-600')}>{ST[k]?.[0] ?? k}</span>;
const TABS = [['wait', 'Ждут сборки'], ['packed', 'Собрано'], ['carriage', 'В поставке'], ['gone', 'Передано'], ['cancelled', 'Отменены']] as const;
type Tab = typeof TABS[number][0];
const KIND: Record<string, string> = { quant: 'Квант', multi: 'По N шт', manual: 'Вручную', bag: 'Пакеты' };
const dd = (d: string) => d.split('-').reverse().slice(0, 2).join('.');
const dt = (iso: string | null) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
const short = (name: string) => name.replace(/^Шпатлёвка |^Краска Helmitex /, '');
const units = (p: any) => p.products.reduce((s: number, x: any) => s + x.qty, 0);
const MAX_AT_ONCE = 300; // за один раз — иначе Ozon/браузер не дождутся
const chip = 'text-xs font-semibold px-2.5 py-1 rounded-full border whitespace-nowrap';

type Mode = 'single' | 'multi' | 'manual';
const PACK_BAG = 'bag', PACK_NONE = 'none';

export default function OzonFbs() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  // фильтры списка (общие со сборкой)
  const [tab, setTab] = useState<Tab>('wait');
  const [product, setProduct] = useState<string>('');
  const [qty, setQty] = useState<string>('1');
  const [ship, setShip] = useState<string>('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(100);
  // сборка
  const [mode, setMode] = useState<Mode>('single');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<number | null>(42);
  const [pack, setPack] = useState<string>('');
  const [withLabels, setWithLabels] = useState(true);
  const [withCarriage, setWithCarriage] = useState(true);
  const [carSel, setCarSel] = useState<Set<string>>(new Set());

  async function run(key: string, fn: () => Promise<any>, ok?: (r: any) => string) {
    setBusy(key); setError(''); setMsg('');
    try { const r = await fn(); if (ok) setMsg(ok(r)); } catch (e: any) { setError(e.message); }
    setBusy('');
  }
  useEffect(() => { run('sync', async () => setData(await api.ozonFbsSync().catch(() => api.ozonFbsState()))); }, []);

  const P: any[] = data?.postings ?? [];
  const batches: any[] = data?.batches ?? [];
  const batchOf = useMemo(() => new Map(batches.map((b) => [b.id, b])), [data]);
  const now = data ? Date.parse(data.now) : Date.now();
  const waiting = P.filter((p) => p.status === 'awaiting_packaging');
  const isCarr = (p: any) => p.status === 'awaiting_deliver' && !!batchOf.get(p.batchId)?.carriageId;
  const inTab = (p: any, t: Tab) => t === 'wait' ? p.status === 'awaiting_packaging'
    : t === 'packed' ? p.status === 'awaiting_deliver' && !isCarr(p)
    : t === 'carriage' ? isCarr(p) : t === 'gone' ? PASSED.includes(p.status) : p.status === 'cancelled';

  // товар по умолчанию — с наибольшим числом ждущих заказов
  const products = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const p of waiting) for (const x of p.products) if (x.item) { const g = m.get(x.item.id) ?? { id: x.item.id, name: x.item.name, n: 0 }; g.n++; m.set(x.item.id, g); }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [data]);
  const prod = product || products[0]?.id || '';
  const ofProd = (p: any) => !prod || p.products.some((x: any) => x.item?.id === prod);
  const mapped = (p: any) => p.products.every((x: any) => x.item);
  const qtys = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of waiting) if (ofProd(p)) m.set(units(p), (m.get(units(p)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [data, prod]);

  const types: any[] = (data?.quantTypes ?? []).filter((t: any) => t.productItemId === prod);
  const type = types.find((t) => t.id === pack) ?? null;
  // упаковка по умолчанию: заказы по 1 шт — квант товара (короб), по 2+ шт — пакеты
  useEffect(() => {
    if (mode === 'single') { setPack(types[0]?.id ?? PACK_NONE); setLimit(types[0]?.units ?? 42); }
    else if (mode === 'multi') setPack(PACK_BAG);
  }, [mode, prod, data?.quantTypes?.length]);
  useEffect(() => { setMode(qty === '1' ? 'single' : qty === 'all' ? 'manual' : 'multi'); }, [qty]);

  const shipFilter = (p: any) => ship === 'all' ? true : ship === 'late' ? Date.parse(p.shipmentDate) < now : p.shipDay === ship;
  const filtered = P.filter((p) => inTab(p, tab) && ofProd(p) && (tab !== 'wait' || qty === 'all' || units(p) === +qty) && shipFilter(p)
    && (!q || p.postingNumber.includes(q.trim())));

  // что соберём
  const plan: any[] = useMemo(() => {
    const base = waiting.filter((p) => ofProd(p) && mapped(p) && shipFilter(p));
    if (mode === 'single') { const one = base.filter((p) => units(p) === 1); return limit ? one.slice(0, limit) : one; }
    if (mode === 'multi') return base.filter((p) => units(p) === +qty);
    return waiting.filter((p) => sel.has(p.postingNumber));
  }, [data, mode, limit, qty, sel, prod, ship]);
  const planUnits = plan.reduce((t, p) => t + units(p), 0);
  const planSet = new Set(plan.map((p) => p.postingNumber));
  const nextNo = (batches.filter((b) => b.day === new Date(now + 3 * 3600_000).toISOString().slice(0, 10)).reduce((m, b) => Math.max(m, b.no), 0)) + 1;
  const singles = waiting.filter((p) => ofProd(p) && units(p) === 1).length;

  const item = (data?.items ?? []).find((i: any) => i.id === prod);
  const have = item ? item.labeled + item.unlabeled : 0;
  const waitUnits = waiting.filter(ofProd).reduce((t, p) => t + units(p), 0);
  const late = waiting.filter((p) => Date.parse(p.shipmentDate) < now);
  const open = batches.filter((b) => !b.carriageId && P.some((p) => p.batchId === b.id && p.status === 'awaiting_deliver'));

  const packLine = type ? `+ 1 ${type.boxName}` : pack === PACK_BAG ? (data?.bag ? `+ ${plan.length} × ${data.bag.name}` : '· пакеты (SKU «Пакет» не заведён — без списания)') : '';
  const kind = mode === 'single' ? 'quant' : pack === PACK_BAG ? 'bag' : mode === 'multi' ? 'multi' : 'manual';
  const tooMany = plan.length > MAX_AT_ONCE;

  const labelsPdf = (b: any) => downloadFile(`/stock/ozon-fbs/batches/${b.id}/labels.pdf`, `OZON_FBS_${b.no}.pdf`).catch((e) => setError(e.message));
  const actPdf = (b: any) => downloadFile(`/stock/ozon-fbs/batches/${b.id}/act.pdf`, `OZON_FBS_ACT_${b.carriageId}.pdf`).catch((e) => setError(e.message));

  function doShip() {
    return run('ship', () => api.ozonFbsShip({
      postingNumbers: plan.map((p) => p.postingNumber), kind,
      quantTypeId: type?.id ?? null, limit: mode === 'single' ? limit : null, labels: withLabels, carriage: withCarriage,
    }), (r) => {
      setData(r.state); setSel(new Set());
      if (r.batch && withLabels && !r.labelError) labelsPdf({ id: r.batch.id, no: r.batch.no });
      return [
        r.batch ? `Группа №${r.batch.no}: собрано ${r.shipped}` : `Собрано ${r.shipped}`,
        r.failed.length && `ошибок ${r.failed.length} (${r.failed[0].error})`,
        r.doc && `списано ${r.doc.number}`, r.writeOffError && `НЕ списано: ${r.writeOffError}`,
        withLabels && (r.labelError ? `этикетки не сформированы: ${r.labelError}` : r.batch && 'этикетки скачиваются'),
        withCarriage && (r.carriageError ? `поставка не создана: ${r.carriageError}` : r.batch && 'поставка сформирована'),
      ].filter(Boolean).join(' · ');
    });
  }

  const limitBtn = (n: number | null, label: string) => (
    <button key={label} onClick={() => setLimit(n)} className={clsx(chip, limit === n ? (n ? 'bg-brand-600 border-brand-600 text-white' : 'bg-amber-500 border-amber-500 text-white') : n ? 'bg-white border-slate-300' : 'bg-white border-amber-300 text-amber-800')}>{label}</button>
  );
  const modeCard = (m: Mode, title: string, body: React.ReactNode) => (
    <div onClick={() => {
      if (m === 'single') setQty('1');
      else if (m === 'multi' && !(+qty > 1)) { const n = qtys.find(([k]) => k > 1); if (!n) return; setQty(String(n[0])); }
      setMode(m);
    }} className={clsx('rounded-xl border-2 p-3 sm:p-4 cursor-pointer', mode === m ? (m === 'multi' ? 'border-amber-500 bg-amber-50' : 'border-brand-500 bg-brand-50') : 'border-slate-200 bg-white hover:border-slate-300')}>
      <div className="font-bold">{title}</div>{body}
    </div>
  );

  if (!data) return <div><PageHeader title="Отправки Ozon FBS" />{error ? <p className="text-red-600">{error}</p> : <p className="text-slate-500">Загрузка заказов из Ozon…</p>}</div>;

  return (
    <div className="space-y-4 pb-28 lg:pb-0">
      <PageHeader title="Отправки Ozon FBS" hint="Все текущие заказы склада «Рощино». Статусы обновляются из Ozon каждые 15 минут.">
        <button disabled={!!busy} onClick={() => run('sync', async () => setData(await api.ozonFbsSync()))} className={btnSecondary + ' flex-1 sm:flex-none'}>{busy === 'sync' ? 'Обновляю…' : '↻ Обновить из Ozon'}</button>
      </PageHeader>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">{error}</div>}
      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-2.5 text-sm">{msg}</div>}

      {/* Плитки */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 sm:gap-3">
        <div className={clsx('rounded-xl border p-3 sm:p-4', late.length ? 'bg-rose-50 border-rose-200' : 'bg-white border-slate-200')}>
          <div className={clsx('text-xs', late.length ? 'text-rose-700' : 'text-slate-500')}>Просрочено</div>
          <div className={clsx('text-2xl sm:text-3xl font-extrabold tabular-nums', late.length && 'text-rose-700')}>{late.length}</div>
          <div className="text-xs text-slate-500">срок отгрузки прошёл</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <div className="text-xs text-slate-500">Ждут сборки</div>
          <div className="text-2xl sm:text-3xl font-extrabold tabular-nums">{waiting.length}</div>
          <div className="text-xs text-slate-500">{fmtQty(waiting.reduce((t, p) => t + units(p), 0), 0)} шт</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <div className="text-xs text-slate-500">Собрано, без поставки</div>
          <div className="text-2xl sm:text-3xl font-extrabold tabular-nums">{P.filter((p) => inTab(p, 'packed')).length}</div>
          <div className="text-xs text-slate-500">{open.length} групп</div>
        </div>
        <div className={clsx('rounded-xl border p-3 sm:p-4', have < waitUnits ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200')}>
          <div className="text-xs text-slate-500 truncate">{item ? short(item.name) : 'Товар'} на складе</div>
          <div className="text-2xl sm:text-3xl font-extrabold tabular-nums">{fmtQty(have, 0)}</div>
          <div className={clsx('text-xs', have < waitUnits ? 'text-amber-800' : 'text-slate-500')}>с ЧЗ {fmtQty(item?.labeled ?? 0, 0)} · нужно {fmtQty(waitUnits, 0)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4 col-span-2 lg:col-span-1">
          <div className="text-xs text-slate-500 truncate">{type?.boxName ?? 'Упаковка'}</div>
          <div className="text-2xl sm:text-3xl font-extrabold tabular-nums">{type ? fmtQty(type.boxStock ?? 0, 0) : data.bag ? fmtQty(data.bag.stock, 0) : '—'}</div>
          <div className="text-xs text-slate-500">{type ? 'на складе' : data.bag ? `${data.bag.name} на складе` : 'SKU «Пакет» не заведён'}</div>
        </div>
      </div>

      {data.unmapped.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-2.5 text-sm">
          Артикулы Ozon без SKU портала: <b>{data.unmapped.join(', ')}</b> — такие заказы нельзя собрать со списанием. Укажите артикул в <Link to="/stock/catalog?type=PRODUCT" className="underline">карточке SKU</Link>.
        </div>
      )}
      {data.notWritten > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm text-amber-800">
          {data.notWritten} собранных отправлений не списаны со склада (например, собраны в кабинете Ozon).
          <button disabled={!!busy} className={btnSecondary + ' ml-auto'} onClick={() => run('wo', () => api.ozonFbsWriteOff(), (r) => { setData(r.state); return r.doc ? `Списано документом ${r.doc.number}` : 'Нечего списывать'; })}>{busy === 'wo' ? 'Списываю…' : 'Списать'}</button>
        </div>
      )}

      {/* Собрать квант */}
      <section className="bg-white rounded-xl border border-slate-200 p-3 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-3">
          <h2 className="font-bold text-lg mr-1">Собрать квант</h2>
          {products.length > 1 && (
            <select value={prod} onChange={(e) => setProduct(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white">
              {products.map((x) => <option key={x.id} value={x.id}>{short(x.name)} · {x.n}</option>)}
            </select>
          )}
          <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1 sm:pb-0 w-full sm:w-auto">
            <span className="text-xs text-slate-500 self-center whitespace-nowrap">Штук в заказе:</span>
            {qtys.map(([n, c]) => (
              <button key={n} onClick={() => { setQty(String(n)); setTab('wait'); }} className={clsx(chip, qty === String(n) ? 'bg-brand-600 border-brand-600 text-white' : n > 1 ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-white border-slate-300')}>
                {n} шт <span className="opacity-70">{c}</span></button>
            ))}
            <button onClick={() => setQty('all')} className={clsx(chip, qty === 'all' ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-slate-300')}>все</button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-2 sm:gap-3">
          {modeCard('single', 'По 1 шт — квант по лимиту', <>
            <div className="text-xs text-slate-500">{singles} заказов · старые первыми</div>
            <div className="flex flex-wrap items-center gap-1.5 mt-2" onClick={(e) => e.stopPropagation()}>
              <span className="text-xs text-slate-500">Лимит:</span>
              {[...new Set([type?.units ?? 42, 24, 10])].map((n) => limitBtn(n, `${n} шт`))}
              <input type="number" min={1} inputMode="numeric" placeholder="своё" value={limit && ![type?.units ?? 42, 24, 10].includes(limit) ? limit : ''}
                onChange={(e) => setLimit(Math.max(1, +e.target.value || 1))} className="w-16 border border-slate-300 rounded-lg px-2 py-0.5 text-sm" />
              {limitBtn(null, 'без лимита')}
            </div>
            <div className="text-sm mt-2">{limit ? `= ${Math.floor(singles / limit)} квантов по ${limit}${singles % limit ? ` + ${singles % limit}` : ''}` : `один квант на все ${singles}`}</div>
          </>)}
          {modeCard('multi', `По ${mode === 'multi' ? qty : '2+'} шт — все отфильтрованные`, <>
            <div className="text-xs text-slate-500">{mode === 'multi' ? `${plan.length} заказов = ${planUnits} шт` : qtys.filter(([n]) => n > 1).map(([n, c]) => `${n} шт: ${c}`).join(' · ') || 'нет заказов по 2+ шт'}</div>
            <div className="text-sm mt-2">лимит не нужен — в квант идут все заказы фильтра</div>
            {mode !== 'multi' && qtys.some(([n]) => n > 1) && <div className="text-xs text-amber-800 mt-1">выберите «2 шт», «3 шт»… выше</div>}
          </>)}
          {modeCard('manual', 'Вручную', <>
            <div className="text-xs text-slate-500">отметьте любые заказы в таблице</div>
            <div className="text-2xl font-extrabold mt-1 tabular-nums">{sel.size ? `${sel.size} отпр` : '—'}</div>
          </>)}
        </div>

        <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="text-sm flex items-center gap-2">Упаковка
            <select value={pack} onChange={(e) => setPack(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white max-w-[260px]">
              {types.map((t) => <option key={t.id} value={t.id}>{t.name} → {t.boxName ?? 'без короба'}</option>)}
              <option value={PACK_BAG}>Пакеты — по одному на заказ</option>
              <option value={PACK_NONE}>Без списания упаковки</option>
            </select>
          </label>
          <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={withLabels} onChange={(e) => setWithLabels(e.target.checked)} /> этикетки 58×40</label>
          <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={withCarriage} onChange={(e) => setWithCarriage(e.target.checked)} /> + поставка</label>
        </div>
        <div className="hidden lg:flex mt-3 items-center gap-3">
          <span className="text-sm">Будет: <b>группа №{nextNo} · {plan.length} отпр · {planUnits} шт</b> · спишем {planUnits} шт {item ? short(item.name) : ''} {packLine}</span>
          {tooMany && <span className="text-sm text-red-600">не больше {MAX_AT_ONCE} заказов за раз — поставьте лимит</span>}
          <button disabled={!!busy || !plan.length || tooMany} onClick={doShip} className={btnPrimary + ' ml-auto'}>{busy === 'ship' ? `Собираю ${plan.length}…` : `Собрать ${planUnits} шт →`}</button>
        </div>
      </section>

      {/* Заказы */}
      <section className="bg-white rounded-xl border border-slate-200">
        <div className="px-3 sm:px-4 py-3 border-b flex gap-1.5 overflow-x-auto">
          {TABS.map(([k, t]) => (
            <button key={k} onClick={() => { setTab(k); setShown(100); }} className={clsx(chip, tab === k ? 'bg-brand-600 border-brand-600 text-white' : 'bg-slate-100 border-slate-100 text-slate-700')}>
              {t} {P.filter((p) => inTab(p, k) && ofProd(p)).length}</button>
          ))}
        </div>
        <div className="px-3 sm:px-4 py-2 border-b bg-slate-50 flex flex-wrap items-center gap-2 text-sm">
          <select value={ship} onChange={(e) => setShip(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1 bg-white">
            <option value="all">Отгрузка: все</option><option value="late">просроченные</option>
            {[...new Set(P.map((p) => p.shipDay))].sort().map((d) => <option key={d} value={d}>{dd(d)}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="№ отправления" inputMode="numeric" className="border border-slate-300 rounded-lg px-2 py-1 bg-white w-40 flex-1 sm:flex-none" />
          {tab === 'wait' && mode === 'manual' && <span className="text-xs text-slate-500 ml-auto">отмечено {sel.size}</span>}
          {tab === 'wait' && mode !== 'manual' && <span className="text-xs text-slate-500 ml-auto">подсвечены заказы, которые войдут в группу №{nextNo}</span>}
        </div>

        {/* телефон — карточки */}
        <div className="sm:hidden divide-y">
          {filtered.slice(0, shown).map((p) => (
            <label key={p.postingNumber} className={clsx('flex items-start gap-3 px-3 py-2.5', planSet.has(p.postingNumber) && 'bg-brand-50')}>
              {tab === 'wait' && <input type="checkbox" className="mt-1 w-5 h-5" checked={mode === 'manual' ? sel.has(p.postingNumber) : planSet.has(p.postingNumber)} disabled={mode !== 'manual'}
                onChange={() => setSel((s) => { const x = new Set(s); x.has(p.postingNumber) ? x.delete(p.postingNumber) : x.add(p.postingNumber); return x; })} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="font-mono text-xs">{p.postingNumber}</span>{batchOf.get(p.batchId) && <span className="text-[11px] text-brand-700">№{batchOf.get(p.batchId).no}</span>}</div>
                <div className="text-xs text-slate-500 truncate">{p.products.map((x: any) => x.item ? short(x.item.name) : x.offerId).join(', ')}</div>
                {p.shipError && <div className="text-xs text-red-600">{p.shipError}</div>}
              </div>
              <div className="text-right">
                <div className={clsx('text-lg font-extrabold tabular-nums', units(p) > 1 && 'text-amber-700')}>×{units(p)}</div>
                {p.status === 'awaiting_packaging' && Date.parse(p.shipmentDate) < now ? <span className="text-[11px] text-rose-700">просрочено</span> : <span className="text-[11px] text-slate-500">{dd(p.shipDay)}</span>}
              </div>
            </label>
          ))}
        </div>
        {/* компьютер — таблица */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b">
              {tab === 'wait' && <th className="pl-4 w-8">{mode === 'manual' && <input type="checkbox" checked={filtered.length > 0 && filtered.every((p) => sel.has(p.postingNumber))}
                onChange={(e) => setSel(e.target.checked ? new Set(filtered.slice(0, MAX_AT_ONCE).map((p) => p.postingNumber)) : new Set())} />}</th>}
              <th className="px-3 py-2 font-medium">Отправление</th><th className="px-3 py-2 font-medium">Товар</th><th className="px-3 py-2 font-medium text-right">Шт</th>
              <th className="px-3 py-2 font-medium">Отгрузить до</th><th className="px-3 py-2 font-medium hidden md:table-cell">Принят</th>
              <th className="px-3 py-2 font-medium text-right hidden md:table-cell">Сумма</th><th className="px-3 py-2 font-medium">Группа</th><th className="px-3 py-2 font-medium">Статус</th>
            </tr></thead>
            <tbody>
              {filtered.slice(0, shown).map((p) => {
                const b = batchOf.get(p.batchId);
                return (
                  <tr key={p.postingNumber} className={clsx('border-b border-slate-100 last:border-0', planSet.has(p.postingNumber) && 'bg-brand-50/70')}>
                    {tab === 'wait' && <td className="pl-4"><input type="checkbox" checked={mode === 'manual' ? sel.has(p.postingNumber) : planSet.has(p.postingNumber)} disabled={mode !== 'manual'}
                      onChange={() => setSel((s) => { const x = new Set(s); x.has(p.postingNumber) ? x.delete(p.postingNumber) : x.add(p.postingNumber); return x; })} /></td>}
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{p.postingNumber}{p.shipError && <div className="text-xs text-red-600 font-sans max-w-xs whitespace-normal">{p.shipError}</div>}</td>
                    <td className="px-3 py-2">{p.products.map((x: any) => <span key={x.offerId} className={clsx('mr-1', !x.item && 'text-rose-700')} title={x.name}>{x.item ? short(x.item.name) : `${x.offerId} (не привязан)`}</span>)}</td>
                    <td className={clsx('px-3 py-2 text-right', units(p) > 1 && 'font-extrabold text-amber-700')}>{units(p)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{p.status === 'awaiting_packaging' && Date.parse(p.shipmentDate) < now ? <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">просрочено</span> : `${dd(p.shipDay)} ${new Date(p.shipmentDate).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}`}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap hidden md:table-cell">{dt(p.inProcessAt)}</td>
                    <td className="px-3 py-2 text-right hidden md:table-cell">{fmtMoney(p.products.reduce((s: number, x: any) => s + x.qty * x.price, 0))}</td>
                    <td className="px-3 py-2">{b ? <span className="text-xs font-medium text-brand-700 whitespace-nowrap">№{b.no} · {dd(b.day)}</span> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2">{pill(isCarr(p) ? 'carriage' : p.status)}{p.stockDocId && <span className="ml-1 text-[11px] text-slate-400" title="списано со склада">✓</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="px-4 py-6 text-sm text-slate-500">Нет заказов.</div>}
        {filtered.length > shown && <button onClick={() => setShown((n) => n + 200)} className="w-full px-4 py-2.5 text-sm text-brand-700 border-t hover:bg-slate-50">Показать ещё · всего {filtered.length}</button>}
      </section>

      {/* Группы и поставки */}
      <section className="bg-white rounded-xl border border-slate-200">
        <div className="px-3 sm:px-4 py-3 border-b flex flex-wrap items-center gap-2">
          <h2 className="font-bold">Группы и поставки</h2><span className="text-xs text-slate-500">{open.length} без поставки</span>
          <button disabled={!!busy || !(carSel.size || open.length)} className={btnPrimary + ' ml-auto !py-1.5'}
            onClick={() => run('car', () => api.ozonFbsCarriage(carSel.size ? [...carSel] : open.map((b) => b.id)), (r) => { setData(r.state); setCarSel(new Set()); return `Поставка ${r.carriageId} сформирована в Ozon`; })}>
            {busy === 'car' ? 'Формирую…' : carSel.size ? `Поставка на выбранные ${carSel.size}` : `Поставка на все ${open.length}`}</button>
        </div>
        <div className="divide-y text-sm">
          {batches.slice(0, 30).map((b) => {
            const canCar = !b.carriageId && open.some((o) => o.id === b.id);
            return (
              <div key={b.id} className="px-3 sm:px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {canCar ? <input type="checkbox" className="w-4 h-4" checked={carSel.has(b.id)} onChange={() => setCarSel((s) => { const x = new Set(s); x.has(b.id) ? x.delete(b.id) : x.add(b.id); return x; })} /> : <span className="w-4" />}
                <b className="w-10">№{b.no}</b><span className="text-xs text-slate-500 w-10">{dd(b.day)}</span>
                <span className={clsx('text-[11px] font-medium px-2 py-0.5 rounded-full', b.kind === 'quant' ? 'bg-brand-50 text-brand-700' : 'bg-amber-50 text-amber-800')}>{b.quantTypeName ?? KIND[b.kind] ?? b.kind}</span>
                <span className="w-28">
                  {b.limit && <span className="block h-1.5 rounded bg-slate-200 overflow-hidden"><span className="block h-full bg-brand-500" style={{ width: `${Math.min(100, b.units / b.limit * 100)}%` }} /></span>}
                  <span className="text-xs text-slate-500">{b.postings} отпр · {b.units}{b.limit ? `/${b.limit}` : ''} шт</span>
                </span>
                <span className="basis-full sm:basis-auto sm:ml-auto flex flex-wrap items-center gap-3 text-xs pl-7 sm:pl-0">
                  {b.carriageId
                    ? <><span className="text-indigo-700">поставка {b.carriageId}{b.carriageStatus === 'formed' ? ' · сформирована' : b.carriageStatus ? ` · ${b.carriageStatus}` : ''}</span><button className="text-brand-700 hover:underline" onClick={() => actPdf(b)}>⇩ акт</button></>
                    : canCar && <button disabled={!!busy} className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 font-medium hover:bg-blue-100"
                        onClick={() => run(`car${b.id}`, () => api.ozonFbsCarriage([b.id]), (r) => { setData(r.state); return `Поставка ${r.carriageId} сформирована в Ozon: группа №${b.no}`; })}>{busy === `car${b.id}` ? 'Формирую…' : 'Сформировать поставку'}</button>}
                  {b.labels && <button className="text-brand-700 hover:underline font-medium" onClick={() => labelsPdf(b)}>⇩ этикетки ({b.postings})</button>}
                  <button disabled={!!busy} className={b.labels ? 'text-slate-500 hover:underline' : 'text-brand-700 hover:underline'}
                    onClick={() => run(`bl${b.id}`, () => api.ozonFbsBatchLabels(b.id), (r) => { setData(r); labelsPdf(b); return `Этикетки группы №${b.no} готовы`; })}>
                    {busy === `bl${b.id}` ? 'Ozon формирует…' : b.labels ? 'заново' : 'сформировать этикетки'}</button>
                </span>
              </div>
            );
          })}
          {batches.length === 0 && <div className="px-4 py-6 text-sm text-slate-500">Групп ещё нет — соберите первую выше.</div>}
        </div>
      </section>

      {/* Телефон/планшет: итог и кнопка всегда под рукой */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 shadow-[0_-4px_16px_rgba(0,0,0,.06)] px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-sm leading-tight">
            <div className="font-bold truncate">Группа №{nextNo} · {planUnits} шт</div>
            <div className="text-xs text-slate-500 truncate">{plan.length} отпр{type ? ` · ${type.boxName}` : pack === PACK_BAG ? ' · пакеты' : ''}{withLabels ? ' · этикетки' : ''}{withCarriage ? ' · поставка' : ''}</div>
            {tooMany && <div className="text-xs text-red-600">не больше {MAX_AT_ONCE} за раз</div>}
          </div>
          <button disabled={!!busy || !plan.length || tooMany} onClick={doShip} className={btnPrimary + ' shrink-0'}>{busy === 'ship' ? 'Собираю…' : 'Собрать →'}</button>
        </div>
      </div>
    </div>
  );
}
