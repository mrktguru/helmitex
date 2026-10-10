import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AD, ORG, RAMP, fmt, pct, rub, short, weekday } from './util';

const SPEND_CLICK = '#334155';
const SPEND_ORDER = '#94A3B8';

export interface Marker { date: string; n: number; text: string; auto: boolean }

// Заказы (реклама / органика) и расход по дням — два графика с общей осью дат, метки журнала сверху.
// Наведение на день показывает расшифровку в строке под заголовком.
export default function DailyCharts({ series, markers, onMarker }: { series: any[]; markers: Marker[]; onMarker: (date: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = series.length;
  const rows = useMemo(() => series.map((s) => {
    const ad = Math.min(s.adOrders, s.orders);
    const spend = s.spendClick + s.spendSelected + s.spendAll;
    return { ...s, ad, org: s.orders - ad, spend, drr: s.revenue ? spend / s.revenue : null };
  }), [series]);
  const maxO = Math.max(1, ...rows.map((r) => r.orders));
  const maxS = Math.max(1, ...rows.map((r) => r.spend));
  const byDate = new Map<string, Marker[]>();
  for (const m of markers) { const a = byDate.get(m.date) ?? []; a.push(m); byDate.set(m.date, a); }
  const h = hover != null ? rows[hover] : null;
  const showValues = n <= 31;
  const grid = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };

  return (
    <section className="bg-white rounded-xl border border-slate-200 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
        <h2 className="font-semibold">По дням</h2>
        <div className="flex flex-wrap gap-4 text-xs text-slate-600">
          <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm" style={{ background: AD }} />Заказы с рекламы</span>
          <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm" style={{ background: ORG }} />Органика</span>
          <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm" style={{ background: SPEND_CLICK }} />Клики, ₽</span>
          <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm" style={{ background: SPEND_ORDER }} />Оплата за заказ, ₽</span>
        </div>
      </div>

      <div className="px-5 pt-3 min-h-[44px] text-sm tabular-nums text-slate-600 flex flex-wrap gap-x-5 gap-y-1" aria-live="polite">
        {h ? (
          <>
            <b className="text-slate-900">{short(h.date)}, {weekday(h.date)}</b>
            <span>показы {fmt(h.views)}</span><span>в поиске {fmt(h.searchViews)}</span><span>корзины {fmt(h.toCart)}</span>
            <span>заказы {fmt(h.orders)} <span style={{ color: AD }}>({fmt(h.ad)} рекл.)</span></span>
            <span>выручка {rub(h.revenue)}</span><span>реклама {rub(h.spend)}</span><span>ДРР {pct(h.drr)}</span>
            {h.position != null && <span>позиция {fmt(h.position, 1)}</span>}
          </>
        ) : <span className="text-slate-400">Наведите на день, чтобы увидеть цифры. Номер над столбцом — запись журнала, «!» — аномалия.</span>}
      </div>

      <div className="px-5 pb-4 overflow-x-auto">
        <div style={{ minWidth: Math.max(560, n * 22) }} onMouseLeave={() => setHover(null)}>
          {/* Метки журнала */}
          <div className="grid gap-[3px] h-7 items-end" style={grid}>
            {rows.map((r) => {
              const ms = byDate.get(r.date) ?? [];
              return (
                <div key={r.date} className="flex justify-center gap-0.5">
                  {ms.slice(0, 2).map((m) => (
                    <button key={m.n} onClick={() => onMarker(m.date)} title={`${short(m.date)}: ${m.text}`}
                      className={clsx('w-5 h-5 rounded-full text-[10px] font-semibold flex items-center justify-center',
                        m.auto ? 'border-2 border-red-500 text-red-600 bg-white' : 'bg-slate-800 text-white')}>
                      {m.auto ? '!' : m.n}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Заказы */}
          <div className="text-[11px] text-slate-500 mt-1">Заказы, шт</div>
          <div className="grid gap-[3px] items-end h-40 border-b border-slate-300" style={grid}>
            {rows.map((r, i) => (
              <div key={r.date} onMouseEnter={() => setHover(i)} className={clsx('h-full flex flex-col justify-end items-stretch cursor-default', hover === i && 'bg-slate-100/80 rounded-t')}>
                {showValues && <span className="text-[10px] text-slate-500 text-center tabular-nums leading-none mb-0.5">{r.orders}</span>}
                <i className="block rounded-t-[3px]" style={{ height: `${(r.org / maxO) * 85}%`, background: ORG }} />
                <i className="block mt-[2px]" style={{ height: `${(r.ad / maxO) * 85}%`, background: AD }} />
              </div>
            ))}
          </div>

          {/* Расход */}
          <div className="text-[11px] text-slate-500 mt-3">Расход на рекламу, ₽</div>
          <div className="grid gap-[3px] items-end h-24 border-b border-slate-300" style={grid}>
            {rows.map((r, i) => (
              <div key={r.date} onMouseEnter={() => setHover(i)} className={clsx('h-full flex flex-col justify-end', hover === i && 'bg-slate-100/80 rounded-t')}>
                <i className="block rounded-t-[3px]" style={{ height: `${((r.spendSelected + r.spendAll) / maxS) * 90}%`, background: SPEND_ORDER }} />
                <i className="block mt-[2px]" style={{ height: `${(r.spendClick / maxS) * 90}%`, background: SPEND_CLICK }} />
              </div>
            ))}
          </div>

          {/* Даты */}
          <div className="grid gap-[3px] mt-1" style={grid}>
            {rows.map((r, i) => (
              <span key={r.date} className={clsx('text-[10px] text-center tabular-nums', ['сб', 'вс'].includes(weekday(r.date)) ? 'text-slate-400' : 'text-slate-500')}>
                {n <= 31 || i % Math.ceil(n / 20) === 0 ? short(r.date) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Heatmap rows={rows} />
    </section>
  );
}

// Конверсии по дням: цвет — относительно своей строки (светлее — ниже, темнее — выше)
function Heatmap({ rows }: { rows: any[] }) {
  const n = rows.length;
  const lines = [
    { label: 'CTR рекламы', v: rows.map((r) => (r.adViews ? r.adClicks / r.adViews : null)), f: (v: number) => pct(v) },
    { label: 'Показ → карточка', v: rows.map((r) => (r.views ? r.pdpViews / r.views : null)), f: (v: number) => pct(v) },
    { label: 'Карточка → корзина', v: rows.map((r) => (r.pdpViews ? r.toCart / r.pdpViews : null)), f: (v: number) => pct(v, 0) },
    { label: 'Корзина → заказ', v: rows.map((r) => (r.toCart ? r.orders / r.toCart : null)), f: (v: number) => pct(v, 0) },
    { label: 'Позиция (меньше — лучше)', v: rows.map((r) => r.position), f: (v: number) => fmt(v, 1), invert: true },
  ];
  return (
    <div className="border-t border-slate-100 px-5 py-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold">Конверсии по дням</h3>
        <span className="text-[11px] text-slate-500">светлее — ниже, темнее — выше (внутри строки)</span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: `150px repeat(${n}, minmax(34px, 1fr))`, minWidth: 150 + n * 36 }}>
          {lines.map((l) => {
            const vals = l.v.filter((x): x is number => x != null);
            const mn = Math.min(...vals), mx = Math.max(...vals);
            return [
              <span key={l.label} className="text-xs text-slate-600 flex items-center pr-2">{l.label}</span>,
              ...l.v.map((v, i) => {
                if (v == null) return <span key={i} className="h-7 rounded-sm bg-slate-50" />;
                let k = Math.round(((v - mn) / ((mx - mn) || 1)) * (RAMP.length - 1));
                if (l.invert) k = RAMP.length - 1 - k;
                return (
                  <span key={i} title={`${l.label}, ${short(rows[i].date)}: ${l.f(v)}`}
                    className="h-7 rounded-sm text-[10px] tabular-nums flex items-center justify-center"
                    style={{ background: RAMP[k], color: k >= 5 ? '#fff' : '#0f172a' }}>
                    {n <= 31 ? l.f(v).replace('%', '') : ''}
                  </span>
                );
              }),
            ];
          })}
        </div>
      </div>
    </div>
  );
}
