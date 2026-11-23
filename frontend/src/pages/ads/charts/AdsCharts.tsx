import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api/client';
import { fmt, longDate, weekday } from '../util';
import { C, CAMP_COLORS, Legend, MultiPanel, PanelSpec } from './chartKit';

// Графики над таблицей товара: динамика по дням, кластеры (заказы и оценка остатка FBO), куда и откуда отгружали.
// Период — тот же, что в настройках аналитики (from/to).

interface Day {
  date: string; orders: number; fbo: number; fbs: number; loc: number; local: number | null;
  views: number; toCart: number; adViews: number; adClicks: number; adCart: number; adOrders: number;
  orgViews: number; orgCart: number; spend: number; cpc: number | null; cpcBy: Record<string, number | null>;
  spp: number | null; buyerPrice: number | null;
}
interface Cluster {
  name: string; total: number; local: number; supplied: number; stockEst: number | null; stockNow: number | null;
  days: { own: number; other: number; ship: number; stock: number | null; sup: number }[];
}
interface Charts {
  today: string; series: Day[]; campaigns: { id: string; title: string; clicks: number; spend: number; cpc: number }[];
  clusters: Cluster[]; shippedFrom: { scheme: string; cluster: string; qty: number }[];
  stock: { method: 'anchor' | 'snapshot' | null; anchor: string | null; manual: boolean; auto: string | null; snapshot: boolean };
}

const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const head = (d: string) => <div className="font-ui font-semibold text-slate-900 mb-0.5">{longDate(d)}, {weekday(d)}</div>;

export default function AdsCharts({ sku, from, to, version }: { sku: string; from: string; to: string; version: number }) {
  const [data, setData] = useState<Charts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const req = useRef(0);

  async function load(silent = false) {
    const id = ++req.current;
    if (!silent) setLoading(true);
    setError('');
    try { const r = await api.adsCharts(sku, from, to); if (id === req.current) setData(r); } catch (e: any) { if (id === req.current) setError(e.message); }
    if (id === req.current) setLoading(false);
  }
  useEffect(() => { load(); }, [sku, from, to]);
  useEffect(() => { if (version) load(true); }, [version]);

  if (!data) {
    return (
      <section className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">
        {error ? <span className="text-red-600">{error}</span> : loading ? 'Строю графики… Первый раз загружаю отправления и поставки из Ozon за 5 месяцев — это может занять пару минут.' : 'Нет данных'}
      </section>
    );
  }
  return (
    <div className={loading ? 'opacity-60 transition-opacity space-y-4' : 'space-y-4'}>
      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{error}</p>}
      <Dynamics d={data} />
      <Clusters d={data} sku={sku} onChanged={() => load(true)} />
      <Flows d={data} />
    </div>
  );
}

// ───────────── Динамика товара ─────────────

function Dynamics({ d }: { d: Charts }) {
  const s = d.series;
  const dates = s.map((x) => x.date);
  const hasFbs = s.some((x) => x.fbs > 0);
  const camps = d.campaigns.slice(0, CAMP_COLORS.length);
  const multi = camps.length > 1;

  const panels: PanelSpec[] = [
    { title: `Заказы, шт (без отмен) · FBO${hasFbs ? ' + FBS' : ''}`, short: 'Заказы, шт', h: 140,
      stack: [{ values: s.map((x) => x.fbo), color: C.fbo }, { values: s.map((x) => x.fbs), color: C.fbs }] },
    { title: 'Показы органические, шт', short: 'Показы орг., шт', h: 120, lines: [{ values: s.map((x) => x.orgViews), color: C.org }] },
    { title: 'Добавления в корзину органические, шт', short: 'Корзины орг., шт', h: 100, stack: [{ values: s.map((x) => x.orgCart), color: C.org }] },
    { title: 'Показы по рекламе, шт', short: 'Показы рекл., шт', h: 120, lines: [{ values: s.map((x) => x.adViews), color: C.ad }] },
    { title: 'Добавления в корзину по рекламе, шт', short: 'Корзины рекл., шт', h: 100, stack: [{ values: s.map((x) => x.adCart), color: C.ad }] },
    { title: multi ? 'Цена клика, ₽ · средняя по всем кампаниям (расход ÷ клики) и по каждой' : 'Цена клика, ₽', short: 'Цена клика, ₽', h: 130, zero: false,
      lines: [
        ...(multi ? camps.map((c, k) => ({ values: s.map((x) => x.cpcBy[c.id] ?? null), color: CAMP_COLORS[k], width: 1.3, dash: '5 3', dots: false })) : []),
        { values: s.map((x) => x.cpc), color: C.fg2, width: 2 },
      ] },
    { title: 'СПП, % (линия, левая шкала) · цена для покупателя, ₽ (столбцы, правая шкала)', short: 'СПП % · цена покупателя ₽', h: 140, zero: false, unit: '%',
      lines: [{ values: s.map((x) => x.spp), color: C.fg2, bridge: true }],
      right: { bars: { values: s.map((x) => x.buyerPrice), color: C.fbo }, unit: '₽' } },
    { title: 'Локальные заказы, % (скользящее за 5 дней)', short: 'Локальные, %', h: 90, range: [0, 100], unit: '%',
      lines: [{ values: s.map((x) => x.local), color: C.fbo }] },
  ];

  const tip = (i: number) => {
    const x = s[i];
    return (
      <>
        {head(x.date)}
        {x.date === d.today && <div className="text-amber-700 font-ui">день ещё не закончился</div>}
        <div>Заказы без отмен: <b>{x.fbo + x.fbs}</b>{hasFbs && <> (FBO {x.fbo} · FBS {x.fbs})</>}</div>
        <div className="text-slate-500">Заказано по аналитике Ozon: {x.orders}</div>
        <div><span style={{ color: C.org }}>●</span> Органика: показы {fmt(x.orgViews)} · корзины {fmt(x.orgCart)}</div>
        <div><span style={{ color: C.ad }}>●</span> Реклама: показы {fmt(x.adViews)} · клики {fmt(x.adClicks)} · корзины {fmt(x.adCart)} · заказы {fmt(x.adOrders)}</div>
        <div>Цена клика: {x.cpc != null ? `${fmt(x.cpc, 1)} ₽` : '—'} · расход {fmt(x.spend)} ₽</div>
        {multi && camps.map((c, k) => x.cpcBy[c.id] != null && (
          <div key={c.id} className="pl-3"><span style={{ color: CAMP_COLORS[k] }}>━</span> {c.title.slice(0, 28)}: {fmt(x.cpcBy[c.id], 1)} ₽</div>
        ))}
        <div>Локальные заказы (5 дн.): {x.local != null ? `${fmt(x.local)}%` : '—'}</div>
        <div>СПП: {x.spp != null ? `${fmt(x.spp, 1)}%` : '—'} · цена для покупателя: {x.buyerPrice != null ? `${fmt(x.buyerPrice)} ₽` : '—'}</div>
      </>
    );
  };

  return (
    <section className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold">Динамика по дням</h2>
        <Legend items={[
          { color: C.fbo, label: 'FBO' }, ...(hasFbs ? [{ color: C.fbs, label: 'FBS' }] : []),
          { color: C.org, label: 'органика' }, { color: C.ad, label: 'реклама' },
          ...(multi ? camps.map((c, k) => ({ color: CAMP_COLORS[k], label: c.title, kind: 'dash' as const })) : []),
        ]} />
      </div>
      <MultiPanel dates={dates} panels={panels} tooltip={tip} today={d.today} gap={18} />
      <p className="mt-1 text-[11px] text-slate-500 leading-4">
        Органика = всего по аналитике Ozon − реклама (может быть занижена: Ozon засчитывает рекламе заказы и корзины несколько дней после клика).
        СПП — скидка за счёт Ozon от цены продавца, по начислениям дня: FBO попадает в них после выкупа, пустые дни соединены пунктиром.
        {multi && ' Средняя цена клика взвешена по кликам: расход всех кампаний ÷ все клики.'}
      </p>
    </section>
  );
}

// ───────────── Кластеры ─────────────

function Clusters({ d, sku, onChanged }: { d: Charts; sku: string; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const dates = d.series.map((x) => x.date);
  const list = d.clusters.filter((c) => c.total > 0 || c.days.some((x) => (x.stock ?? 0) > 0 || x.sup > 0));
  const shown = all ? list : list.slice(0, 6);
  const st = d.stock;

  async function setAnchor(date: string | null) {
    setBusy(true);
    try { await api.adsStockAnchor(sku, date); onChanged(); } finally { setBusy(false); }
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-semibold">Кластеры: заказы покупателей и остаток FBO</h2>
        <Legend items={[
          { color: C.fbo, label: 'из своего кластера' }, { color: C.fbs, label: 'привезено из другого' },
          { color: C.stock, label: 'остаток FBO, оценка', kind: 'line' }, { color: C.sup, label: 'поставка', kind: 'tri' }, { color: C.band, label: 'нет стока', kind: 'band' },
        ]} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 mb-3">
        {st.method === 'anchor' && <span>Остаток считается от <b>{dm(st.anchor!)}</b>{st.manual ? ' (задано вручную)' : ' (найдено автоматически: последний день, когда FBO-отгрузок почти не было)'} — в этот день FBO = 0, дальше + поставки − отгрузки.{st.snapshot && ' Сегодняшнее значение сверено с остатком Ozon.'}</span>}
        {st.method === 'snapshot' && <span>Точка отсчёта не найдена — остаток восстановлен назад от текущего остатка Ozon.</span>}
        {st.method == null && <span className="text-amber-700">Нет точки отсчёта и текущего остатка — укажите день, когда FBO был 0 во всех кластерах.</span>}
        <label className="flex items-center gap-1.5">FBO = 0 на
          <input type="date" disabled={busy} value={st.manual ? st.anchor ?? '' : ''} max={d.today} onChange={(e) => e.target.value && setAnchor(e.target.value)}
            className="border border-slate-300 rounded-md h-7 px-1.5 text-xs bg-white" />
        </label>
        {st.manual && <button disabled={busy} onClick={() => setAnchor(null)} className="text-brand-700 hover:underline">определять автоматически{st.auto ? ` (${dm(st.auto)})` : ''}</button>}
      </div>
      {list.length === 0 ? <p className="text-sm text-slate-500 py-4">Нет отправлений за период.</p> : (
        <div className="grid gap-x-6 gap-y-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))' }}>
          {shown.map((c) => <ClusterChart key={c.name} c={c} dates={dates} today={d.today} />)}
        </div>
      )}
      {list.length > 6 && (
        <button onClick={() => setAll(!all)} className="mt-3 text-sm text-brand-700 hover:underline">{all ? 'Свернуть' : `Показать все кластеры (${list.length})`}</button>
      )}
      <p className="mt-2 text-[11px] text-slate-500 leading-4">
        Остаток — оценка: истории остатков в Ozon нет. Приход поставки ставится на день, когда завершена приёмка, или раньше — когда со складов кластера начали отгружать больше, чем было.
        Если со складов кластера ничего не отгрузили, а его покупатели заказывали, — стока не было, оценка обнуляется. Расхождение с текущим остатком Ozon (в основном возвраты покупателей)
        распределяется по дням пропорционально отгрузкам, поэтому сегодня оценка совпадает с Ozon.
      </p>
    </section>
  );
}

function ClusterChart({ c, dates, today }: { c: Cluster; dates: string[]; today: string }) {
  const panel: PanelSpec = {
    title: c.name, h: 110,
    stack: [{ values: c.days.map((x) => x.own), color: C.fbo }, { values: c.days.map((x) => x.other), color: C.fbs }],
    right: { area: { values: c.days.map((x) => x.stock), color: C.stock }, unit: 'шт' },
    band: c.days.map((x) => x.stock === 0),
    marks: c.days.map((x, i) => ({ i, text: String(x.sup), v: x.sup })).filter((m) => m.v > 0),
  };
  const tip = (i: number) => {
    const x = c.days[i];
    return (
      <>
        <div className="font-ui font-semibold text-slate-900 mb-0.5">{longDate(dates[i])} · {c.name}</div>
        <div>Заказы из своего кластера: {x.own}</div>
        <div>Привезено из другого кластера: {x.other}</div>
        <div>Отгружено со складов кластера (FBO): {x.ship}</div>
        <div>Остаток FBO, оценка: {x.stock == null ? '—' : x.stock === 0 ? 'нет' : `${x.stock} шт`}</div>
        {x.sup > 0 && <div style={{ color: C.sup }}>Пришла поставка: {x.sup} шт</div>}
      </>
    );
  };
  const pctLocal = c.total ? Math.round((c.local / c.total) * 100) : null;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-slate-600 mb-0.5">
        <span><b className="text-slate-900 text-sm">{c.name}</b> · заказов {c.total}{pctLocal != null && ` · ${pctLocal}% локально`}{c.supplied > 0 && ` · поставлено ${c.supplied} шт`}</span>
        <span className="font-mono">остаток: оценка {c.stockEst ?? '—'}{c.stockNow != null && ` · Ozon ${c.stockNow}`}</span>
      </div>
      <MultiPanel dates={dates} panels={[{ ...panel, title: '' }]} tooltip={tip} today={today} />
    </div>
  );
}

// ───────────── Куда и откуда отгружали ─────────────

function Flows({ d }: { d: Charts }) {
  const rows = useMemo(() => {
    const r = d.clusters.filter((c) => c.total > 0);
    const top = r.slice(0, 8); const rest = r.slice(8);
    if (rest.length) top.push({ name: `Другие (${rest.length})`, total: rest.reduce((t, c) => t + c.total, 0), local: rest.reduce((t, c) => t + c.local, 0) } as Cluster);
    return top;
  }, [d]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const total = rows.reduce((t, r) => t + r.total, 0);
  if (!total) return null;
  return (
    <section className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold">Куда и откуда отгружали <span className="font-normal text-sm text-slate-500">· {total} шт без отмен</span></h2>
        <Legend items={[{ color: C.fbo, label: 'со склада своего кластера' }, { color: C.fbs, label: 'привезено из другого' }]} />
      </div>
      <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <div className="space-y-1.5">
          <div className="text-xs text-slate-500">Кластер покупателя</div>
          {rows.map((r) => (
            <div key={r.name} className="grid items-center gap-2 text-sm" style={{ gridTemplateColumns: 'minmax(80px, 150px) 1fr 76px' }}>
              <span className="truncate" title={r.name}>{r.name}</span>
              <div className="flex h-3.5 gap-0.5">
                {r.local > 0 && <i className="h-full rounded-sm" style={{ width: `${(r.local / max) * 100}%`, background: C.fbo }} />}
                {r.total - r.local > 0 && <i className="h-full rounded-sm" style={{ width: `${((r.total - r.local) / max) * 100}%`, background: C.fbs }} />}
              </div>
              <span className="text-right font-mono text-xs tabular-nums">{r.total} · {Math.round((r.local / r.total) * 100)}%</span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1.5">Откуда отгружали</div>
          <table className="w-full text-sm">
            <tbody>
              {d.shippedFrom.map((f) => (
                <tr key={f.scheme + f.cluster} className="border-t border-slate-100">
                  <td className="py-1 pr-2 text-xs"><span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: f.scheme === 'FBO' ? 'rgba(42,120,214,.12)' : 'rgba(224,162,27,.18)' }}>{f.scheme}</span></td>
                  <td className="py-1 pr-2">{f.cluster}</td>
                  <td className="py-1 text-right font-mono tabular-nums">{f.qty} шт</td>
                  <td className="py-1 pl-2 text-right font-mono text-xs text-slate-500 tabular-nums w-12">{Math.round((f.qty / total) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
