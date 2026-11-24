import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { PageHeader } from '../stock/StockLayout';
import { AD, addDays, fmt, longDate, pct, weekday } from './util';
import { C, Legend, MultiPanel, PanelSpec, niceStep, useChartWidth } from './charts/chartKit';

// «Отложенные корзины» (рабочий инструмент, позже переедет в «Аналитику рекламы»):
// через сколько после корзины приходит заказ — три независимые оценки и сколько заказов ещё «в пути» от сделанных корзин.

const ALL = '#2a78d6'; // все корзины (модель 1)
const TAIL = '#6250d6'; // хвосты остановленных кампаний
const BASE = '#cbd5e1';
const INK = '#1e293b';

interface Fit { k: number; w: number[]; p0: number; r: number; base: number[]; r2: number; n: number; fromCarts: number; mean: number; median: number }
interface Pend { days: { date: string; carts: number; expected: number; arrived: number; pending: number }[]; pending: number }
interface Lag {
  sku: string; from: string; to: string; today: string; matureFrom: string;
  total: Fit | null; ad: Fit | null;
  tails: { events: { campaignId: string; stop: string; avgClicks: number; avgOrders: number; tail: number[] }[]; curve: { day: number; share: number | null; events: number }[] };
  series: { date: string; orders: number | null; carts: number | null; adCarts: number | null; adOrders: number | null; adClicks: number | null; base: number | null; fromSame: number | null; fromPrev: number | null; fitted: number | null; fresh: boolean }[];
  pending: { total: Pend | null; ad: Pend | null };
  hourly: {
    collectedDays: number; collectingSince: string | null; campaigns: string[]; ad: Fit | null; postingsWithTime: number;
    profile: { adCart: (number | null)[]; adOrders: (number | null)[]; orders: (number | null)[]; carts: (number | null)[]; ordersN: number; adCartN: number; cartsN: number };
    maturation: { days: number; points: { hours: number; carts: number | null; orders: number | null }[] };
  };
}

const cum = (w: number[], n: number) => w.slice(0, n + 1).reduce((t, v) => t + v, 0);
const reliability = (r2: number | null | undefined) => (r2 == null ? '—' : r2 >= 0.7 ? 'высокая' : r2 >= 0.4 ? 'средняя' : 'низкая');
const head = (d: string) => <div className="font-ui font-semibold text-slate-900 mb-0.5">{longDate(d)}, {weekday(d)}</div>;

export default function DeferredCarts() {
  const [params, setParams] = useSearchParams();
  const [products, setProducts] = useState<{ sku: string; name: string }[] | null>(null);
  const [data, setData] = useState<Lag | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const req = useRef(0);
  const days = Number(params.get('days')) || 180;
  const sku = params.get('sku') ?? products?.[0]?.sku ?? null;
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n, { replace: true }); };

  useEffect(() => {
    api.adsStatus().then((s) => api.adsProducts(addDays(s.lastDay, -27), s.lastDay)).then((r) => setProducts(r.products)).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!sku) return;
    const id = ++req.current;
    setLoading(true); setError('');
    api.adsCartLag(sku, days).then((r) => { if (id === req.current) setData(r); }).catch((e) => { if (id === req.current) setError(e.message); }).finally(() => { if (id === req.current) setLoading(false); });
  }, [sku, days]);

  return (
    <div className="space-y-5">
      <PageHeader title="Отложенные корзины"
        hint="Через сколько после добавления в корзину приходит заказ. Ozon не связывает корзину и заказ одного покупателя, поэтому лаг оценивается тремя независимыми способами — если они сходятся, оценке можно верить." />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600">Товар
          <select value={sku ?? ''} onChange={(e) => set('sku', e.target.value)} className="border border-slate-300 rounded-lg h-9 px-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 max-w-[28rem]">
            {(products ?? []).map((p) => <option key={p.sku} value={p.sku}>{p.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">История для модели
          <select value={days} onChange={(e) => set('days', e.target.value)} className="border border-slate-300 rounded-lg h-9 px-2.5 text-sm bg-white">
            {[90, 180, 365].map((d) => <option key={d} value={d}>{d} дней</option>)}
          </select>
        </label>
        {loading && <span className="text-xs text-slate-500">Считаю…</span>}
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{error}</p>}
      {!data ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">{loading ? 'Считаю модели…' : 'Выберите товар.'}</div>
      ) : (
        <div className={loading ? 'opacity-60 transition-opacity space-y-5' : 'space-y-5'}>
          <Summary d={data} />
          <Methods d={data} />
          <CumulativeChart d={data} />
          <Composition d={data} />
          <Pending d={data} />
          <Hourly d={data} />
          <Tails d={data} />
        </div>
      )}
    </div>
  );
}

function Card({ title, hint, children, legend }: { title: string; hint?: ReactNode; children: ReactNode; legend?: ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {legend}
      </div>
      {hint && <p className="text-xs text-slate-500 max-w-4xl">{hint}</p>}
      {children}
    </section>
  );
}

// ───────────── Итог ─────────────

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Summary({ d }: { d: Lag }) {
  const t = d.total;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Tile label="Заказов в день корзины" value={t ? pct(t.w[0], 0) : '—'} sub={t ? `остальные ${pct(1 - t.w[0], 0)} — в следующие дни` : 'мало данных'} />
      <Tile label="Средняя задержка" value={t ? `${fmt(t.mean, 1)} дн.` : '—'} sub={t ? `за 3 дня приходит ${pct(cum(t.w, 3), 0)}, за неделю ${pct(cum(t.w, 7), 0)}` : undefined} />
      <Tile label="Заказов на 100 корзин" value={t ? fmt(t.k * 100, 1) : '—'} sub={t ? `корзины объясняют ${pct(t.fromCarts, 0)} заказов` : undefined} />
      <Tile label="Ещё придёт заказов" value={d.pending.total ? fmt(d.pending.total.pending) : '—'}
        sub={d.pending.ad ? `от корзин прошлых дней; по рекламе — ${fmt(d.pending.ad.pending)}` : 'от корзин прошлых дней'} />
    </div>
  );
}

// ───────────── Сравнение способов ─────────────

function Methods({ d }: { d: Lag }) {
  const tailCum = (n: number) => { const s = d.tails.curve.find((c) => c.day === n + 1)?.share; return s == null ? null : Math.max(0, Math.min(1, 1 - s)); };
  const rows: { name: string; color: string; what: string; day0: number | null; d3: number | null; mean: string; rel: string; n: string }[] = [
    { name: '1. Все корзины → все заказы', color: ALL, what: 'аналитика продавца по дням',
      day0: d.total?.w[0] ?? null, d3: d.total ? cum(d.total.w, 3) : null, mean: d.total ? `${fmt(d.total.mean, 1)} дн.` : '—',
      rel: d.total ? `${reliability(d.total.r2)} (R² ${fmt(d.total.r2, 2)})` : '—', n: d.total ? `${d.total.n} дн.` : '—' },
    { name: '2. Рекламные корзины → рекламные заказы', color: AD, what: 'атрибуция Ozon, заказ — по дню заказа',
      day0: d.ad?.w[0] ?? null, d3: d.ad ? cum(d.ad.w, 3) : null, mean: d.ad ? `${fmt(d.ad.mean, 1)} дн.` : '—',
      rel: d.ad ? `${reliability(d.ad.r2)} (R² ${fmt(d.ad.r2, 2)})` : '—', n: d.ad ? `${d.ad.n} дн.` : '—' },
    { name: '2б. Хвосты остановленных кампаний', color: TAIL, what: 'заказы после последнего клика',
      day0: tailCum(0), d3: tailCum(3), mean: '—', rel: d.tails.events.length ? `${d.tails.events.length} ${d.tails.events.length === 1 ? 'остановка' : 'остановок'}` : 'остановок не было', n: '' },
    { name: '3. Рекламные корзины по часам', color: '#0d6b66', what: 'снимки рекламы каждые 30 мин',
      day0: d.hourly.ad ? cum(d.hourly.ad.w, 23) : null, d3: null, mean: d.hourly.ad ? `${fmt(d.hourly.ad.mean, 1)} ч` : '—',
      rel: d.hourly.ad ? `${reliability(d.hourly.ad.r2)} (R² ${fmt(d.hourly.ad.r2, 2)})` : '—', n: `${fmt(d.hourly.collectedDays, 0)} дн. снимков` },
  ];
  return (
    <Card title="Три способа оценки"
      hint={<>«В день корзины» — доля заказов, пришедших в тот же день (для почасового способа — в первые 24 часа). Надёжность — насколько модель объясняет колебания заказов (R²): высокая ≥ 0,7, средняя ≥ 0,4. Модель 1 строится без последних {3} дней: Ozon дозаполняет корзины в аналитике ещё ~3 дня.</>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
              <th className="py-1.5 font-medium">Способ</th><th className="py-1.5 font-medium text-right">В день корзины</th>
              <th className="py-1.5 font-medium text-right">За 3 дня</th><th className="py-1.5 font-medium text-right">Средняя задержка</th>
              <th className="py-1.5 font-medium pl-4">Надёжность</th><th className="py-1.5 font-medium text-right">Данных</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b last:border-0">
                <td className="py-1.5"><span className="flex items-center gap-2"><i className="w-3 h-3 rounded-sm shrink-0" style={{ background: r.color }} />
                  <span>{r.name}<span className="block text-xs text-slate-500">{r.what}</span></span></span></td>
                <td className="py-1.5 text-right">{pct(r.day0, 0)}</td>
                <td className="py-1.5 text-right">{pct(r.d3, 0)}</td>
                <td className="py-1.5 text-right">{r.mean}</td>
                <td className="py-1.5 pl-4">{r.rel}</td>
                <td className="py-1.5 text-right text-slate-500">{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────── Простой график по категориям (дни лага, часы) ─────────────

interface CatSeries { label: string; color: string; values: (number | null)[]; kind: 'bar' | 'line' }
function CatChart({ cats, series, h = 220, unit = '', percent = false, tip }: {
  cats: string[]; series: CatSeries[]; h?: number; unit?: string; percent?: boolean; tip: (i: number) => ReactNode;
}) {
  const [ref, W] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);
  const L = 46; const R = 10; const T = 8; const B = 24;
  const pw = W - L - R; const N = cats.length; const step = pw / Math.max(1, N);
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const mx = Math.max(percent ? 0.05 : 1, ...vals);
  const st = niceStep(mx, 4); const hi = Math.ceil(mx / st) * st;
  const Y = (v: number) => T + h - (v / hi) * h;
  const X = (i: number) => L + step * i + step / 2;
  const bars = series.filter((s) => s.kind === 'bar');
  const bw = Math.max(2, Math.min(18, (step * 0.8) / Math.max(1, bars.length) - 2));
  const ticks: number[] = []; for (let v = 0; v <= hi + st / 1e6; v += st) ticks.push(v);
  const every = Math.ceil(N / Math.max(1, Math.floor(pw / 34)));
  const label = (v: number) => (percent ? `${fmt(v * 100, 0)}%` : `${fmt(v, 1)}${unit}`);
  return (
    <div ref={ref} className="relative w-full select-none">
      <svg viewBox={`0 0 ${W} ${T + h + B}`} width="100%" style={{ height: 'auto', display: 'block', overflow: 'visible' }}
        onPointerMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const x = ((e.clientX - r.left) * W) / r.width; const i = Math.floor((x - L) / step); setHover(i >= 0 && i < N ? i : null); }}
        onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={C.line} />
            <text x={L - 6} y={Y(v) + 3.5} fontSize={11} textAnchor="end" fill="#64748b" className="font-mono">{label(v)}</text>
          </g>
        ))}
        {hover != null && <rect x={L + step * hover} y={T} width={step} height={h} fill="#f1f5f9" />}
        {bars.map((s, si) => s.values.map((v, i) => v != null && v > 0 && (
          <rect key={`${si}-${i}`} x={X(i) - (bars.length * (bw + 2)) / 2 + si * (bw + 2) + 1} y={Y(v)} width={bw} height={Math.max(0.5, T + h - Y(v))} rx={Math.min(2, bw / 3)} fill={s.color} />
        )))}
        {series.filter((s) => s.kind === 'line').map((s) => {
          let d = ''; let pen = false;
          s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              {step >= 10 && s.values.map((v, i) => v != null && <circle key={i} cx={X(i)} cy={Y(v)} r={hover === i ? 4 : 2.5} fill={s.color} />)}
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={T + h} y2={T + h} stroke="#cbd5e1" />
        {cats.map((c, i) => i % every === 0 && <text key={c} x={X(i)} y={T + h + 15} fontSize={11} textAnchor="middle" fill={C.muted} className="font-mono">{c}</text>)}
      </svg>
      {hover != null && (
        <div className="absolute z-20 pointer-events-none bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs font-mono leading-5 text-slate-700 whitespace-nowrap"
          style={{ top: 0, ...(X(hover) > W / 2 ? { right: `calc(100% - ${(X(hover) / W) * 100}% + 14px)` } : { left: `calc(${(X(hover) / W) * 100}% + 14px)` }) }}>
          {tip(hover)}
        </div>
      )}
    </div>
  );
}

// ───────────── Накопленная доля заказов по дням задержки ─────────────

function CumulativeChart({ d }: { d: Lag }) {
  const N = 15;
  const cats = Array.from({ length: N }, (_, i) => String(i));
  const line = (f: Fit | null) => cats.map((_, i) => (f && i < f.w.length ? cum(f.w, i) : null));
  const tail = cats.map((_, i) => { const s = d.tails.curve.find((c) => c.day === i + 1)?.share; return s == null ? null : Math.max(0, Math.min(1, 1 - s)); });
  const series: CatSeries[] = [
    { label: 'Все корзины', color: ALL, values: line(d.total), kind: 'line' },
    { label: 'Реклама', color: AD, values: line(d.ad), kind: 'line' },
    ...(tail.some((v) => v != null) ? [{ label: 'Хвосты остановок', color: TAIL, values: tail, kind: 'line' as const }] : []),
  ];
  const share = (f: Fit | null, i: number) => (f && i < f.w.length ? f.w[i] : null);
  return (
    <Card title="Какая доля заказов пришла к N-му дню после корзины"
      hint="День 0 — день добавления в корзину. Чем круче линия в начале, тем быстрее корзины превращаются в заказы. Хвосты остановок: 1 − (заказы на N+1-й день после последнего клика ÷ обычные заказы в день)."
      legend={<Legend items={series.map((s) => ({ color: s.color, label: s.label, kind: 'line' }))} />}>
      <CatChart cats={cats} series={series} percent h={220}
        tip={(i) => (
          <>
            <div className="font-ui font-semibold text-slate-900 mb-0.5">{i === 0 ? 'В день корзины' : `К ${i}-му дню`}</div>
            {d.total && <div>Все корзины: {pct(cum(d.total.w, i), 0)} <span className="text-slate-400">(в этот день {pct(share(d.total, i), 1)})</span></div>}
            {d.ad && <div>Реклама: {pct(cum(d.ad.w, i), 0)} <span className="text-slate-400">(в этот день {pct(share(d.ad, i), 1)})</span></div>}
            {tail[i] != null && <div>Хвосты остановок: {pct(tail[i], 0)}</div>}
          </>
        )} />
      <p className="text-xs text-slate-500">По оси — дни после корзины.</p>
    </Card>
  );
}

// ───────────── Из чего состоят заказы дня ─────────────

function Composition({ d }: { d: Lag }) {
  const s = useMemo(() => d.series.slice(-90), [d]);
  const dates = s.map((x) => x.date);
  const panels: PanelSpec[] = [
    { title: 'Заказы дня по модели 1: база (без корзин) · из корзин этого дня · из корзин прошлых дней; линия — факт', short: 'Заказы: модель и факт', h: 200,
      stack: [{ values: s.map((x) => x.base), color: BASE }, { values: s.map((x) => x.fromSame), color: ALL }, { values: s.map((x) => x.fromPrev), color: ALL, opacity: 0.45 }],
      lines: [{ values: s.map((x) => x.orders), color: INK, width: 1.6 }] },
    { title: 'Добавления в корзину, все источники (бледные — Ozon ещё дозаполняет)', short: 'Корзины', h: 120,
      stack: [{ values: s.map((x) => (x.fresh ? null : x.carts)), color: ALL }, { values: s.map((x) => (x.fresh ? x.carts : null)), color: ALL, opacity: 0.35 }] },
  ];
  return (
    <Card title="Из чего состоят заказы дня"
      hint="Проверка модели 1: если сумма столбцов близка к линии факта, модель описывает реальность. «Из корзин прошлых дней» — те самые отложенные корзины, которые доходят до заказа позже."
      legend={<Legend items={[{ color: BASE, label: 'база' }, { color: ALL, label: 'из корзин дня' }, { color: 'rgba(42,120,214,.45)', label: 'из прошлых корзин' }, { color: INK, label: 'факт', kind: 'line' }]} />}>
      <MultiPanel dates={dates} panels={panels} tooltip={(i) => {
        const x = s[i];
        return (
          <>
            {head(x.date)}
            <div>Заказов факт: <b>{fmt(x.orders)}</b>{x.fitted != null && <> · модель {fmt(x.fitted)}</>}</div>
            {x.fromSame != null && <div>из корзин дня {fmt(x.fromSame)} · из прошлых {fmt(x.fromPrev)} · база {fmt(x.base)}</div>}
            <div>Корзин: {fmt(x.carts)}{x.fresh && ' (ещё дозаполняется)'}</div>
            {x.adCarts != null && <div>Реклама: корзин {fmt(x.adCarts)}, заказов {fmt(x.adOrders)}</div>}
          </>
        );
      }} />
    </Card>
  );
}

// ───────────── Отложенные корзины последних дней ─────────────

function Pending({ d }: { d: Lag }) {
  const t = d.pending.total; const a = d.pending.ad;
  if (!t && !a) return null;
  const dates = (t ?? a)!.days.map((x) => x.date);
  const pick = (p: Pend | null, k: 'arrived' | 'pending') => dates.map((dd) => p?.days.find((x) => x.date === dd)?.[k] ?? null);
  const panels: PanelSpec[] = [];
  if (t) panels.push({ title: `Все корзины: ожидаемые заказы от корзин дня — уже пришли · ещё придут (всего ещё ${fmt(t.pending)})`, short: `Все: ещё придёт ${fmt(t.pending)}`, h: 160,
    stack: [{ values: pick(t, 'arrived'), color: ALL }, { values: pick(t, 'pending'), color: ALL, opacity: 0.35 }] });
  if (a) panels.push({ title: `Реклама: то же по рекламным корзинам (всего ещё ${fmt(a.pending)})`, short: `Реклама: ещё ${fmt(a.pending)}`, h: 160,
    stack: [{ values: pick(a, 'arrived'), color: AD }, { values: pick(a, 'pending'), color: AD, opacity: 0.35 }] });
  return (
    <Card title="Отложенные корзины: сколько заказов ещё в пути"
      hint={<>По каждому дню корзин: сколько заказов модель ждёт от них всего, сколько уже должно было прийти к {longDate(d.to)} и сколько ещё придёт. Корзины последних 3 дней Ozon ещё дозаполняет — по «всем корзинам» ожидание за них занижено.</>}
      legend={<Legend items={[{ color: ALL, label: 'уже пришли' }, { color: 'rgba(42,120,214,.35)', label: 'ещё придут' }]} />}>
      <MultiPanel dates={dates} panels={panels} tooltip={(i, p) => {
        const src = p === 0 && t ? t : a!;
        const x = src.days.find((y) => y.date === dates[i]);
        if (!x) return head(dates[i]);
        return (
          <>
            {head(x.date)}
            <div>Корзин: {fmt(x.carts)} → ожидается заказов {fmt(x.expected, 1)}</div>
            <div>уже пришло ≈ {fmt(x.arrived, 1)} · ещё придёт ≈ <b>{fmt(x.pending, 1)}</b></div>
          </>
        );
      }} />
    </Card>
  );
}

// ───────────── По часам ─────────────

function Hourly({ d }: { d: Lag }) {
  const h = d.hourly;
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const prof: CatSeries[] = [
    { label: 'Заказы (время отправлений)', color: INK, values: h.profile.orders, kind: 'line' },
    { label: 'Рекламные корзины', color: AD, values: h.profile.adCart, kind: 'line' },
    ...(h.profile.cartsN ? [{ label: 'Все корзины (снимки аналитики)', color: ALL, values: h.profile.carts, kind: 'line' as const }] : []),
  ];
  const lagCats = Array.from({ length: 49 }, (_, i) => String(i));
  const m = h.maturation;
  return (
    <>
      <Card title="Профиль суток: когда кладут в корзину и когда заказывают"
        hint={<>Доля за каждый час (МСК) за последние 28 дней. Если линия заказов заметно отстаёт от линии корзин — корзины доходят до заказа через несколько часов.
          {!h.postingsWithTime && ' Время заказов из отправлений ещё загружается — обновите страницу через несколько минут.'}
          {!h.profile.cartsN && ' Все корзины по часам начали собираться сегодня (снимки аналитики каждые 30 минут) — линия появится по мере накопления.'}</>}
        legend={<Legend items={prof.map((s) => ({ color: s.color, label: s.label, kind: 'line' }))} />}>
        <CatChart cats={hours} series={prof} percent h={200}
          tip={(i) => (
            <>
              <div className="font-ui font-semibold text-slate-900 mb-0.5">{hours[i]}:00–{hours[i]}:59</div>
              <div>Заказы: {pct(h.profile.orders[i], 1)}</div>
              <div>Рекламные корзины: {pct(h.profile.adCart[i], 1)}</div>
              {h.profile.cartsN > 0 && <div>Все корзины: {pct(h.profile.carts[i], 1)}</div>}
            </>
          )} />
        <p className="text-xs text-slate-500">По оси — час суток. Заказов {fmt(h.profile.ordersN)}, рекламных корзин {fmt(h.profile.adCartN)}{h.profile.cartsN ? `, всех корзин ${fmt(h.profile.cartsN)}` : ''}.</p>
      </Card>

      <Card title="Лаг по часам: рекламные корзины → рекламные заказы"
        hint={<>Модель на снимках рекламы каждые 30 минут ({fmt(h.collectedDays, 0)} дн. снимков{h.collectingSince ? ` с ${longDate(h.collectingSince.slice(0, 10))}` : ''}). Столбец — доля заказов через N часов после корзины.
          Ozon может показывать заказ в статистике рекламы с задержкой — это сдвигает лаг на час-два вправо.</>}>
        {h.ad ? (
          <>
            <CatChart cats={lagCats} series={[{ label: 'доля', color: AD, values: h.ad.w, kind: 'bar' }]} percent h={180}
              tip={(i) => (
                <>
                  <div className="font-ui font-semibold text-slate-900 mb-0.5">Через {i} ч</div>
                  <div>в этот час {pct(h.ad!.w[i], 1)} · всего к нему {pct(cum(h.ad!.w, i), 0)}</div>
                </>
              )} />
            <p className="text-xs text-slate-500">По оси — часы после корзины. Медиана {h.ad.median} ч, средняя {fmt(h.ad.mean, 1)} ч, надёжность {reliability(h.ad.r2)} (R² {fmt(h.ad.r2, 2)}).</p>
          </>
        ) : <p className="text-sm text-slate-500">Мало данных: нужны снимки рекламы кампаний, где этот товар — единственный.</p>}
      </Card>

      <Card title="Как Ozon дозаполняет корзины в аналитике"
        hint="Какая доля итоговых корзин и заказов дня видна в аналитике продавца через N часов после начала дня. Важно для свежих дней: пока корзины не дозрели, модель 1 занижает ожидание.">
        {m.days ? (
          <CatChart cats={m.points.map((p) => `${p.hours} ч`)} series={[{ label: 'Корзины', color: ALL, values: m.points.map((p) => p.carts), kind: 'line' }, { label: 'Заказы', color: INK, values: m.points.map((p) => p.orders), kind: 'line' }]} percent h={160}
            tip={(i) => <><div className="font-ui font-semibold text-slate-900 mb-0.5">Через {m.points[i].hours} ч от начала дня</div><div>Корзины: {pct(m.points[i].carts, 0)}</div><div>Заказы: {pct(m.points[i].orders, 0)}</div></>} />
        ) : <p className="text-sm text-slate-500">Снимки аналитики собираются с сегодняшнего дня каждые 30 минут. Первые полные дни появятся через 4 суток.</p>}
      </Card>
    </>
  );
}

// ───────────── Остановки кампаний ─────────────

function Tails({ d }: { d: Lag }) {
  const ev = d.tails.events;
  return (
    <Card title="Остановки рекламы: заказы после последнего клика"
      hint="Кампания по товару крутилась ≥ 14 дней (≥ 30 кликов и ≥ 3 заказов в день) и остановилась. Заказы, которые Ozon засчитывает ей после остановки, — это клики и корзины, дошедшие до заказа позже. Число в ячейке — заказы дня ÷ обычные заказы кампании в день до остановки.">
      {ev.length === 0 ? <p className="text-sm text-slate-500">Подходящих остановок по этому товару не было.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="py-1.5 pr-3 font-medium">Кампания</th><th className="py-1.5 pr-3 font-medium">Остановка</th>
                <th className="py-1.5 pr-3 font-medium text-right">Кликов/день</th><th className="py-1.5 pr-3 font-medium text-right">Заказов/день</th>
                {Array.from({ length: 10 }, (_, i) => <th key={i} className="py-1.5 px-1.5 font-medium text-right">+{i + 1}</th>)}
              </tr>
            </thead>
            <tbody>
              {ev.map((e) => (
                <tr key={e.campaignId + e.stop} className="border-b last:border-0">
                  <td className="py-1 pr-3 font-mono text-xs">{e.campaignId}</td>
                  <td className="py-1 pr-3">{longDate(e.stop)}</td>
                  <td className="py-1 pr-3 text-right">{fmt(e.avgClicks)}</td>
                  <td className="py-1 pr-3 text-right">{fmt(e.avgOrders, 1)}</td>
                  {Array.from({ length: 10 }, (_, i) => (
                    <td key={i} className="py-1 px-1.5 text-right" style={{ background: e.tail[i] != null ? `rgba(98,80,214,${Math.min(0.35, e.tail[i] * 0.35)})` : undefined }}>
                      {e.tail[i] != null ? pct(e.tail[i], 0) : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
