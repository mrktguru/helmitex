import { Fragment, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { fmt, longDate, weekday } from './util';
import { C, MultiPanel, PanelSpec } from './charts/chartKit';

// Поисковые запросы товара: по каким словам показывается, на какой позиции, сколько поисков и заказов.
// Снимок — раз в день по данным Ozon (история — около 5 недель).

interface Q {
  query: string; searches: number; viewers: number; orders: number; gmv: number; daysSeen: number;
  position: number | null; best: number | null; last: { date: string; position: number | null } | null;
  series: ({ position: number | null; searches: number; orders: number } | null)[];
}
interface Data {
  firstDay: string | null; days: string[];
  daily: { date: string; position: number | null; queries: number; searches: number; orders: number; adSpend: number; adViews: number }[];
  queries: Q[];
}
type SortK = 'searches' | 'position' | 'orders' | 'conv' | 'query';

const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const rev = <T,>(a: T[]) => [...a].reverse(); // сегодня — первым, дальше дни по убыванию
const posCls = (p: number | null) => (p == null ? 'text-slate-400' : p <= 3 ? 'text-emerald-700' : p <= 10 ? 'text-slate-800' : p <= 30 ? 'text-amber-700' : 'text-red-700');

/** Позиция по дням: меньше — выше (ось перевёрнута); пропуски — товар не попал в снимок */
function PosSpark({ s, w = 120, h = 28 }: { s: Q['series']; w?: number; h?: number }) {
  const pts = s.map((x, i) => ({ i, p: x?.position ?? null })).filter((x) => x.p != null && x.p > 0) as { i: number; p: number }[];
  if (pts.length < 2) return <span className="text-xs text-slate-400">—</span>;
  const max = Math.max(...pts.map((x) => x.p)); const min = Math.min(...pts.map((x) => x.p));
  const span = Math.max(1, max - min);
  const X = (i: number) => (s.length <= 1 ? w / 2 : ((s.length - 1 - i) / (s.length - 1)) * (w - 4) + 2); // сегодня слева
  const Y = (p: number) => 3 + ((p - min) / span) * (h - 6); // верх — лучшая позиция
  let d = ''; let prev = -2;
  for (const x of pts) { d += `${x.i === prev + 1 ? 'L' : 'M'}${X(x.i).toFixed(1)},${Y(x.p).toFixed(1)}`; prev = x.i; }
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} className="block" aria-hidden="true">
      <path d={d} fill="none" stroke={C.fbo} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={X(last.i)} cy={Y(last.p)} r={2.5} fill={C.fbo} />
    </svg>
  );
}

export default function QueriesTab({ sku, from, to, campaignsOn }: { sku: string; from: string; to: string; campaignsOn?: (d: string) => boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<{ k: SortK; asc: boolean }>({ k: 'searches', asc: false });
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    api.adsQueries(sku, from, to).then((r) => alive && setData(r)).catch((e) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [sku, from, to]);

  const rows = useMemo(() => {
    if (!data) return [];
    const f = filter.trim().toLowerCase();
    const conv = (q: Q) => (q.viewers ? q.orders / q.viewers : 0);
    const val = (q: Q): number | string => (sort.k === 'query' ? q.query : sort.k === 'conv' ? conv(q) : sort.k === 'position' ? q.position ?? 999 : q[sort.k]);
    return data.queries.filter((q) => !f || q.query.toLowerCase().includes(f))
      .sort((a, b) => { const x = val(a), y = val(b); const r = typeof x === 'string' ? x.localeCompare(String(y), 'ru') : (x as number) - (y as number); return sort.asc ? r : -r; });
  }, [data, sort, filter]);

  if (!data) return <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">{error ? <span className="text-red-600">{error}</span> : loading ? 'Загружаю поисковые запросы… Первый раз — несколько минут.' : 'Нет данных'}</div>;

  const d = data.daily;
  const withPos = d.filter((x) => x.position != null);
  const lastDay = withPos[withPos.length - 1];
  const totals = data.queries.reduce((t, q) => ({ searches: t.searches + q.searches, orders: t.orders + q.orders }), { searches: 0, orders: 0 });
  const panels: PanelSpec[] = [
    { title: 'Средняя позиция по всем запросам (взвешена по числу поисков; меньше — выше в выдаче)', short: 'Средняя позиция', h: 130, zero: false, lines: [{ values: d.map((x) => x.position), color: C.fbo, bridge: true }] },
    { title: 'Поиски по запросам товара (уникальные покупатели)', short: 'Поиски', h: 110, stack: [{ values: d.map((x) => x.searches), color: '#94a3b8' }] },
    { title: 'Расход на рекламу товара, ₽ (все кампании)', short: 'Расход на рекламу', h: 90, stack: [{ values: d.map((x) => x.adSpend), color: C.ad, opacity: 0.6 }] },
  ];
  const tip = (i: number) => {
    const x = d[i];
    return (
      <>
        <div className="font-ui font-semibold text-slate-900 mb-0.5">{longDate(x.date)}, {weekday(x.date)}</div>
        <div>Средняя позиция: <b>{x.position != null ? fmt(x.position, 1) : '—'}</b></div>
        <div>Запросов в снимке: {x.queries}</div>
        <div>Поисков: {fmt(x.searches)} · заказов из поиска: {fmt(x.orders)}</div>
        <div>Расход на рекламу: {fmt(x.adSpend)} ₽ · показы РК: {fmt(x.adViews)}</div>
      </>
    );
  };
  const th = (k: SortK, label: string, cls = 'text-right') => (
    <th className={clsx('px-3 py-2 font-medium text-[11px] text-slate-500 whitespace-nowrap cursor-pointer select-none hover:text-slate-800', cls)}
      onClick={() => setSort((s) => ({ k, asc: s.k === k ? !s.asc : k === 'position' || k === 'query' }))}>
      {label}{sort.k === k ? (sort.asc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <h2 className="font-semibold">Позиция в поиске по дням</h2>
          <div className="flex flex-wrap gap-4 text-sm text-slate-600">
            <span>сейчас: <b className="font-mono">{lastDay?.position != null ? fmt(lastDay.position, 1) : '—'}</b>{lastDay && <span className="text-slate-400"> ({dm(lastDay.date)})</span>}</span>
            <span>запросов за период: <b className="font-mono">{data.queries.length}</b></span>
            <span>поисков: <b className="font-mono">{fmt(totals.searches)}</b></span>
            <span>заказов из поиска: <b className="font-mono">{fmt(totals.orders)}</b></span>
          </div>
        </div>
        <MultiPanel dates={data.days} panels={panels} tooltip={tip} gap={30} />
        <p className="mt-1 text-[11px] text-slate-500 leading-4">
          Данные Ozon «Аналитика → поисковые запросы» за каждый день{data.firstDay ? ` (есть с ${dm(data.firstDay)})` : ''}. Ozon отдаёт до 15 запросов за одну выборку, портал объединяет несколько выборок — около 45–50 запросов в день, редкие запросы могут выпадать.
          Позиция — средняя позиция товара в выдаче по запросу за день, как её считает Ozon.
        </p>
      </section>

      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
          <h2 className="font-semibold">Запросы, по которым показывается товар</h2>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Найти запрос" className="border border-slate-300 rounded-lg h-8 px-2.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {th('query', 'Запрос', 'text-left')}
                {th('searches', 'Поисков')}
                <th className="px-3 py-2 font-medium text-[11px] text-slate-500 text-right">Увидели</th>
                {th('position', 'Позиция ср.')}
                <th className="px-3 py-2 font-medium text-[11px] text-slate-500 text-right whitespace-nowrap">Последняя</th>
                <th className="px-3 py-2 font-medium text-[11px] text-slate-500 text-right">Лучшая</th>
                <th className="px-3 py-2 font-medium text-[11px] text-slate-500 text-left whitespace-nowrap">Позиция по дням (сегодня слева)</th>
                {th('orders', 'Заказы')}
                {th('conv', 'Конв.')}
                <th className="px-3 py-2 font-medium text-[11px] text-slate-500 text-right whitespace-nowrap">Дней в снимке</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <Fragment key={q.query}>
                  <tr onClick={() => setOpen(open === q.query ? null : q.query)} className={clsx('border-b border-slate-100 cursor-pointer hover:bg-slate-50', open === q.query && 'bg-slate-50')}>
                    <td className="px-3 py-1.5 max-w-[320px]"><span className="text-slate-400 mr-1">{open === q.query ? '▾' : '▸'}</span>{q.query}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(q.searches)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{fmt(q.viewers)}</td>
                    <td className={clsx('px-3 py-1.5 text-right font-mono tabular-nums font-semibold', posCls(q.position))}>{q.position != null ? fmt(q.position, 1) : '—'}</td>
                    <td className={clsx('px-3 py-1.5 text-right font-mono tabular-nums', posCls(q.last?.position ?? null))}>{q.last?.position != null ? fmt(q.last.position, 1) : '—'}<span className="text-[11px] text-slate-400 ml-1">{q.last ? dm(q.last.date) : ''}</span></td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{q.best != null ? fmt(q.best, 1) : '—'}</td>
                    <td className="px-3 py-1"><PosSpark s={q.series} /></td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(q.orders)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{q.viewers ? `${fmt(q.orders / q.viewers * 100, 1)}%` : '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{q.daysSeen}</td>
                  </tr>
                  {open === q.query && (
                    <tr className="border-b border-slate-200 bg-slate-50/60">
                      <td colSpan={10} className="px-3 py-3">
                        <div className="overflow-x-auto">
                          <table className="text-xs">
                            <tbody>
                              <tr><td className="pr-3 text-slate-500 whitespace-nowrap">День</td>{rev(data.days.map((dd) => <td key={dd} className={clsx('px-1.5 text-center font-mono', campaignsOn && !campaignsOn(dd) && 'bg-slate-200/60')}>{dm(dd)}</td>))}</tr>
                              <tr><td className="pr-3 text-slate-500 whitespace-nowrap">Позиция</td>{rev(q.series.map((x, i) => <td key={i} className={clsx('px-1.5 text-center font-mono font-semibold', posCls(x?.position ?? null))}>{x?.position != null ? fmt(x.position, 0) : '·'}</td>))}</tr>
                              <tr><td className="pr-3 text-slate-500 whitespace-nowrap">Поисков</td>{rev(q.series.map((x, i) => <td key={i} className="px-1.5 text-center font-mono text-slate-600">{x ? fmt(x.searches) : '·'}</td>))}</tr>
                              <tr><td className="pr-3 text-slate-500 whitespace-nowrap">Заказов</td>{rev(q.series.map((x, i) => <td key={i} className="px-1.5 text-center font-mono text-slate-600">{x ? x.orders : '·'}</td>))}</tr>
                              <tr><td className="pr-3 text-slate-500 whitespace-nowrap">Расход РК, ₽</td>{rev(data.daily.map((x, i) => <td key={i} className="px-1.5 text-center font-mono text-slate-400">{x.adSpend ? fmt(x.adSpend / 1000, 1) + 'к' : '0'}</td>))}</tr>
                            </tbody>
                          </table>
                        </div>
                        <p className="mt-1.5 text-[11px] text-slate-500">«·» — запроса нет в снимке Ozon за этот день.{campaignsOn && ' Серым — дни, когда кампания эксперимента была выключена.'}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="px-4 py-6 text-sm text-slate-500">Запросов нет{filter ? ' по фильтру' : ' за период'}.</p>}
        </div>
      </section>
    </div>
  );
}
