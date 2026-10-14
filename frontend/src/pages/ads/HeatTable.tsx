import clsx from 'clsx';
import { Bucket, Gran, Metric, bucketLabel, delta, deltaCls, heatStyle } from './periods';

export interface ColumnLabel { a: string; b: string; weekend?: boolean }

// Таблица: строки — показатели (по группам), столбцы — периоды, свежие слева.
// Значение и разница с предыдущим периодом — друг под другом, выровнены вправо: столбцы не «прыгают».
export default function HeatTable({ rows, metrics, gran, label, notes, compare, compact = false, maxHeight = '72vh', empty }: {
  rows: Bucket[]; metrics: Metric[]; gran?: Gran; label?: (b: Bucket) => ColumnLabel;
  notes?: (b: Bucket) => string[]; compare?: (b: Bucket) => Bucket | undefined; compact?: boolean; maxHeight?: string; empty?: string;
}) {
  if (!rows.length) return <p className="px-4 py-6 text-sm text-slate-500">{empty ?? 'Нет данных за период'}</p>;
  const cols = [...rows].reverse();
  // с чем сравнивать: по умолчанию — предыдущий период; по часам — то же время вчера
  const prevOf = (b: Bucket) => (compare ? compare(b) : rows[rows.indexOf(b) - 1]);
  const lab = (b: Bucket) => (label ? label(b) : bucketLabel(b.key, gran ?? 'day', b.days));
  let lastGroup = '';
  return (
    <div className="overflow-auto thin" style={{ maxHeight }}>
      <table className="border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-30 bg-white px-3 py-2 text-left align-bottom border-b border-slate-200 text-[11px] font-medium text-slate-500 min-w-[190px]">Показатель</th>
            {cols.map((b) => {
              const L = lab(b); const n = notes?.(b) ?? [];
              return (
                <th key={b.key} className="sticky top-0 z-20 bg-white px-2.5 pt-2 pb-1.5 text-right align-bottom border-b border-slate-200 whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1.5">
                    {n.length > 0 && (
                      <span className="group relative">
                        <span className="w-[18px] h-[18px] rounded-full bg-slate-800 text-white text-[10px] font-semibold flex items-center justify-center" aria-label={`Записей в журнале: ${n.length}`}>{n.length}</span>
                        <span className="pointer-events-none absolute right-0 top-6 z-40 hidden group-hover:block w-72 whitespace-normal text-left bg-slate-900 text-white text-xs font-normal rounded-lg px-3 py-2 shadow-lg">
                          {n.slice(0, 6).map((t, i) => <span key={i} className="block py-0.5">{t}</span>)}
                        </span>
                      </span>
                    )}
                    <span className={clsx('font-mono tabular-nums text-[12.5px] font-semibold', L.weekend && 'text-slate-500')}>{L.a}</span>
                  </div>
                  <div className="text-[10.5px] text-slate-400 font-normal">{L.b}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => {
            const head = m.g !== lastGroup; lastGroup = m.g;
            return [
              head && (
                <tr key={m.g}>
                  <td className="sticky left-0 z-10 bg-white px-3 pt-3 pb-1 text-[11px] font-semibold text-brand-700">{m.g}</td>
                  <td colSpan={cols.length} />
                </tr>
              ),
              <tr key={m.k} className="group">
                <td className={clsx('sticky left-0 z-10 bg-white px-3 text-[13px] text-slate-700 border-b border-slate-100 group-hover:bg-slate-50 whitespace-nowrap', compact ? 'py-1' : 'py-1.5')} title={m.hint}>{m.l}</td>
                {cols.map((b) => {
                  const x = delta(m, b, prevOf(b));
                  return (
                    <td key={b.key} className={clsx('px-2.5 border-b border-white', compact ? 'py-1' : 'py-1.5')} style={heatStyle(x)} title={x ? `${m.l}: ${m.f(b[m.k])} · было ${m.f(prevOf(b)?.[m.k])} · ${x.t}` : undefined}>
                      <div className="flex flex-col items-end min-w-[84px] leading-tight">
                        <span className="font-mono tabular-nums text-[12.5px]">{m.f(b[m.k])}</span>
                        <span className={clsx("font-mono tabular-nums text-[10.5px] mt-0.5 h-[13px]", deltaCls(x))}>{x ? x.t : ''}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
