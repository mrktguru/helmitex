import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api/client';
import { fmt, longDate, weekday } from '../util';
import { C, CAMP_COLORS, Legend, MultiPanel, PanelSpec } from './chartKit';

// Графики над таблицей товара: динамика по дням, кластеры (заказы и оценка остатка FBO), куда и откуда отгружали.
// Период — тот же, что в настройках аналитики (from/to).

interface Day {
  date: string; orders: number; fbo: number; fbs: number; loc: number; local: number | null;
  views: number; toCart: number; adViews: number; adClicks: number; adCart: number; adOrders: number;
  orgViews: number; orgCart: number; spend: number; spendCpo: number; cpc: number | null; cpcBy: Record<string, number | null>;
  spp: number | null; buyerPrice: number | null; revenue: number;
  by: Record<string, { spend: number; clicks: number; views: number; carts: number; orders: number }>;
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
    <div className={loading ? 'opacity-60 transition-opacity space-y-6' : 'space-y-6'}>
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
  // рекламные — по атрибуции Ozon (могут превышать все заказы дня), органика — остальное
  const adOrd = (x: Day) => Math.min(x.adOrders, x.fbo + x.fbs);
  const orgOrd = (x: Day) => Math.max(0, x.fbo + x.fbs - x.adOrders);
  const camps = d.campaigns.slice(0, CAMP_COLORS.length);
  const multi = camps.length > 1;

  const panels: PanelSpec[] = [
    { title: 'Заказы, шт (без отмен) · реклама + органика', short: 'Заказы: реклама + органика', h: 190,
      stack: [{ values: s.map((x) => adOrd(x)), color: C.ad }, { values: s.map((x) => orgOrd(x)), color: C.org }] },
    { title: 'Показы органические, шт', short: 'Показы орг., шт', h: 150, lines: [{ values: s.map((x) => x.orgViews), color: C.org }] },
    { title: 'Добавления в корзину органические, шт', short: 'Корзины орг., шт', h: 140, stack: [{ values: s.map((x) => x.orgCart), color: C.org }] },
    { title: 'Показы по рекламе, шт', short: 'Показы рекл., шт', h: 150, lines: [{ values: s.map((x) => x.adViews), color: C.ad }] },
    { title: 'Добавления в корзину по рекламе, шт', short: 'Корзины рекл., шт', h: 140, stack: [{ values: s.map((x) => x.adCart), color: C.ad }] },
    { title: `Цена клика, ₽ (линия, левая шкала${multi ? '; средняя по всем кампаниям и по каждой' : ''}) · расход на рекламу, ₽ (столбцы, правая шкала)`, short: 'Цена клика ₽ · расход ₽', h: 170, zero: false,
      right: { bars: { values: s.map((x) => x.spend + (x.spendCpo ?? 0)), color: C.ad, opacity: 0.22 }, unit: '₽' },
      lines: [
        ...(multi ? camps.map((c, k) => ({ values: s.map((x) => x.cpcBy[c.id] ?? null), color: CAMP_COLORS[k], width: 1.3, dash: '5 3', dots: false })) : []),
        { values: s.map((x) => x.cpc), color: C.fg2, width: 2 },
      ] },
    { title: 'СПП, % (линия, левая шкала) · цена для покупателя, ₽ (столбцы, правая шкала)', short: 'СПП % · цена покупателя ₽', h: 170, zero: false, unit: '%',
      lines: [{ values: s.map((x) => x.spp), color: C.fg2, bridge: true }],
      right: { bars: { values: s.map((x) => x.buyerPrice), color: C.fbo }, unit: '₽' } },
    { title: 'Локальные заказы, % (скользящее за 5 дней)', short: 'Локальные, %', h: 120, range: [0, 100], unit: '%',
      lines: [{ values: s.map((x) => x.local), color: C.fbo }] },
  ];

  const tip = (i: number) => <DayCard x={s[i]} today={d.today} hasFbs={hasFbs} campaigns={d.campaigns} />;

  return (
    <section className="bg-white rounded-xl border border-slate-200 px-3 sm:px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold">Динамика по дням <span className="font-normal text-sm text-slate-500">· сегодня слева</span></h2>
        <Legend items={[
          { color: C.org, label: 'органика' }, { color: C.ad, label: 'реклама' },
          ...(multi ? camps.map((c, k) => ({ color: CAMP_COLORS[k], label: c.title, kind: 'dash' as const })) : []),
        ]} />
      </div>
      <MultiPanel dates={dates} panels={panels} tooltip={tip} today={d.today} gap={36} card={340} />
      <p className="mt-1 text-[11px] text-slate-500 leading-4">
        Органика = всего − реклама (заказы: без отмен − рекламные по атрибуции Ozon; показы и корзины: аналитика Ozon − реклама) (может быть занижена: Ozon засчитывает рекламе заказы и корзины несколько дней после клика).
        СПП — скидка за счёт Ozon от цены продавца, по начислениям дня: FBO попадает в них после выкупа, пустые дни соединены пунктиром.
        {multi && ' Средняя цена клика взвешена по кликам: расход всех кампаний ÷ все клики.'} Расход — за клики и оплата за заказ (списания из начислений, по дате начисления).
      </p>
    </section>
  );
}

// ───────────── Подсказка дня (вариант 1 «Секции») ─────────────

const H4 = ({ children }: { children: React.ReactNode }) => <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[.06em] text-slate-400">{children}</h4>;
const N = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => <span className={`font-mono tabular-nums whitespace-nowrap ${className}`}>{children}</span>;
const Dot = ({ color }: { color: string }) => <i className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />;

function DayCard({ x, today, hasFbs, campaigns }: { x: Day; today: string; hasFbs: boolean; campaigns: Charts['campaigns'] }) {
  const total = x.fbo + x.fbs;
  const ad = Math.min(x.adOrders, total); const org = Math.max(0, total - x.adOrders);
  const spendAll = x.spend + (x.spendCpo ?? 0);
  const drr = x.revenue > 0 && spendAll > 0 ? spendAll / x.revenue * 100 : null;
  // кампании дня: цвет — как у линии кампании на графике цены клика
  const color = (id: string) => { const k = campaigns.findIndex((c) => c.id === id); return k >= 0 && k < CAMP_COLORS.length ? CAMP_COLORS[k] : '#94a3b8'; };
  const title = (id: string) => campaigns.find((c) => c.id === id)?.title ?? `Кампания ${id}`;
  const rows = Object.entries(x.by ?? {}).filter(([, v]) => v.spend > 0 || v.clicks > 0).sort((a, b) => b[1].spend - a[1].spend);
  const share = (v: number) => (spendAll > 0 ? Math.round(v / spendAll * 100) : 0);
  return (
    <div className="bg-white border border-slate-200 rounded-xl text-[13px] text-slate-800 shadow-[0_12px_32px_-8px_rgba(15,23,42,.18),0_2px_6px_rgba(15,23,42,.06)]">
      <div className="flex items-center justify-between gap-2 px-3.5 pt-3 pb-2.5 border-b border-slate-100">
        <b className="text-sm">{longDate(x.date)}, {weekday(x.date)}</b>
        {x.date === today && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap">● день не закончился</span>}
      </div>

      <div className="px-3.5 py-2.5 border-b border-slate-100">
        <H4>Заказы без отмен</H4>
        <div className="flex items-baseline gap-2 mb-1.5">
          <N className="text-[22px] font-semibold">{fmt(total)}</N>
          <span className="text-xs text-slate-500">аналитика Ozon: {fmt(x.orders)}{x.fbs > 0 ? ` · FBO ${x.fbo} · FBS ${x.fbs}` : ''}</span>
        </div>
        {total > 0 && (
          <>
            <div className="flex h-1.5 gap-0.5 rounded-full overflow-hidden bg-slate-100">
              {ad > 0 && <i style={{ width: `${ad / total * 100}%`, background: C.ad }} />}
              {org > 0 && <i style={{ width: `${org / total * 100}%`, background: C.org }} />}
            </div>
            <div className="flex justify-between mt-1.5 text-xs">
              <span className="flex items-center gap-1.5"><Dot color={C.ad} />реклама <N className="font-semibold">{fmt(x.adOrders)}</N></span>
              <span className="flex items-center gap-1.5">органика <N className="font-semibold">{fmt(org)}</N><Dot color={C.org} /></span>
            </div>
            {x.adOrders > total && <div className="mt-1 text-[11px] text-amber-700">рекламных по атрибуции Ozon больше, чем всех заказов дня</div>}
          </>
        )}
      </div>

      <div className="px-3.5 py-2.5 border-b border-slate-100">
        <H4>Трафик</H4>
        <table className="w-full">
          <thead><tr className="text-[11px] text-slate-400"><th /><th className="font-medium text-right pb-0.5">показы</th><th className="font-medium text-right pb-0.5">корзины</th></tr></thead>
          <tbody>
            <tr><td className="py-0.5"><span className="flex items-center gap-1.5"><Dot color={C.ad} />Реклама</span></td><td className="text-right"><N>{fmt(x.adViews)}</N></td><td className="text-right"><N>{fmt(x.adCart)}</N></td></tr>
            <tr><td className="py-0.5"><span className="flex items-center gap-1.5"><Dot color={C.org} />Органика</span></td><td className="text-right"><N>{fmt(x.orgViews)}</N></td><td className="text-right"><N>{fmt(x.orgCart)}</N></td></tr>
          </tbody>
        </table>
      </div>

      <div className="px-3.5 py-2.5 border-b border-slate-100">
        <H4>Расход на рекламу · <N className="text-slate-900 text-xs normal-case tracking-normal">{fmt(spendAll)} ₽</N>{drr != null && <> · ДРР {fmt(drr, 1)}%</>}</H4>
        {rows.length === 0 && !(x.spendCpo > 0) ? <div className="text-xs text-slate-500">расхода не было</div> : (
          <div className="divide-y divide-slate-100">
            {rows.map(([id, v]) => (
              <div key={id} className="flex gap-2 py-1.5 first:pt-0">
                <span className="pt-1.5"><Dot color={color(id)} /></span>
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 leading-[1.3]" title={title(id)}>{title(id)}</div>
                  <N className="text-[11.5px] text-slate-500">{fmt(v.clicks)} кл. · {v.clicks ? fmt(v.spend / v.clicks, 1) : '—'} ₽ · {fmt(v.orders)} зак.</N>
                </div>
                <div className="text-right">
                  <N className="font-semibold block">{fmt(v.spend)} ₽</N>
                  <N className="text-[11.5px] text-slate-500">{share(v.spend)}%</N>
                </div>
              </div>
            ))}
            {x.spendCpo > 0 && (
              <div className="flex gap-2 py-1.5">
                <span className="pt-1.5"><Dot color="#94a3b8" /></span>
                <div className="min-w-0 flex-1">Оплата за заказ<div className="text-[11.5px] text-slate-500">по начислениям дня</div></div>
                <div className="text-right"><N className="font-semibold block">{fmt(x.spendCpo)} ₽</N><N className="text-[11.5px] text-slate-500">{share(x.spendCpo)}%</N></div>
              </div>
            )}
          </div>
        )}
        {x.adClicks > 0 && <div className="mt-1 text-[11.5px] text-slate-500">Средняя цена клика <N>{fmt(x.cpc, 1)} ₽</N> · {fmt(x.adClicks)} кликов</div>}
      </div>

      <div className="px-3.5 py-2.5 grid grid-cols-[1fr_auto] gap-y-1">
        <span className="text-slate-500">СПП</span><N>{x.spp != null ? `${fmt(x.spp, 1)}%` : '—'}</N>
        <span className="text-slate-500">Цена для покупателя</span><N>{x.buyerPrice != null ? `${fmt(x.buyerPrice)} ₽` : '—'}</N>
        <span className="text-slate-500">Локальные заказы (5 дн.)</span><N>{x.local != null ? `${fmt(x.local)}%` : '—'}</N>
      </div>
    </div>
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
    <section className="bg-white rounded-xl border border-slate-200 px-3 sm:px-4 py-4">
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
        <div className="grid gap-x-8 gap-y-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(560px, 100%), 1fr))' }}>
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
    title: c.name, h: 150,
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
    <section className="bg-white rounded-xl border border-slate-200 px-3 sm:px-4 py-4">
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
