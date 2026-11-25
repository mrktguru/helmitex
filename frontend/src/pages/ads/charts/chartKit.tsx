import { ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { AD, ORG, fmt } from '../util';

// Многопанельный SVG-график на общей оси дней (ТЗ «Графики аналитики рекламы», разделы 5 и 8).
// Рисуется под фактическую ширину контейнера (1 ед. SVG = 1 px), а не масштабируется.

export const C = {
  fbo: '#2a78d6', fbs: '#e0a21b', ad: AD, org: ORG, stock: '#6250d6', sup: '#1baf7a',
  crit: '#d03b3b', fg2: '#4d5356', muted: '#7a8184', line: '#e5e7eb', band: 'rgba(208,59,59,.08)',
};
export const CAMP_COLORS = ['#0A9A8E', '#7c3aed', '#db2777', '#65a30d', '#0284c7'];

export interface Bar { values: (number | null)[]; color: string; opacity?: number }
export interface Line { values: (number | null)[]; color: string; width?: number; dots?: boolean; bridge?: boolean; dash?: string }
export interface PanelSpec {
  title: string; short?: string; h: number;
  stack?: Bar[]; // столбцы с накоплением, левая шкала
  lines?: Line[]; // линии, левая шкала
  zero?: boolean; // левая шкала от нуля (по умолчанию да)
  range?: [number, number]; // фиксированная левая шкала
  max?: number; // общий максимум с другой панелью
  unit?: string; // подпись к значениям левой шкалы
  right?: { bars?: Bar; area?: Line; unit: string }; // правая шкала от нуля
  band?: boolean[]; // подсветка дня на всю высоту панели
  marks?: { i: number; text: string }[]; // треугольники поставок над столбцом
}

export function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const measure = () => { const cw = Math.round(el.clientWidth); setW((p) => (p === 0 || Math.abs(cw - p) > 24 ? cw : p)); };
    measure();
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(measure, 120); });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);
  return [ref, Math.max(300, Math.min(w || 300, 1600))] as const;
}

/** «Круглый» шаг сетки: 1, 2, 5 × 10^k — примерно target делений */
export function niceStep(span: number, target = 4) {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

const isoWeek = (s: string) => {
  const d = new Date(s + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
};
const dow = (s: string) => new Date(s + 'T00:00:00Z').getUTCDay();
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;

function linePath(vals: (number | null)[], X: (i: number) => number, Y: (v: number) => number, bridge = false) {
  let d = ''; let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { if (!bridge) pen = false; return; }
    d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function MultiPanel({ dates, panels, tooltip, today, gap = 30, card }: {
  dates: string[]; panels: PanelSpec[]; tooltip: (i: number, panel: number) => ReactNode; today?: string; gap?: number;
  card?: number; // подсказка — готовая карточка этой ширины: без своей рамки, рядом с курсором по вертикали, не выходит за график
}) {
  const [ref, W] = useChartWidth();
  const [hover, setHover] = useState<{ i: number; p: number; left: number; y: number; flip: boolean } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipH, setTipH] = useState(0);
  useLayoutEffect(() => { if (tipRef.current) setTipH(tipRef.current.offsetHeight); }, [hover?.i, hover?.p, !!hover]);
  const svgRef = useRef<SVGSVGElement>(null);
  const narrow = W < 640;
  const N = Math.max(1, dates.length);
  const L = 50;
  const R = panels.some((p) => p.right) ? 62 : 10;
  const pw = W - L - R;
  const step = pw / N;
  // свежие дни слева: день i (по возрастанию дат) — в ячейке N−1−i
  const cell = (i: number) => L + (N - 1 - i) * step; // левый край ячейки дня
  const X = (i: number) => cell(i) + step / 2;
  const bw = Math.max(1.5, Math.min(step - 3, step * 0.74));

  // раскладка панелей
  let y = 0;
  const lay = panels.map((p) => {
    const titleH = 24 + (p.marks?.length ? 14 : 0);
    const top = y + titleH; const bot = top + p.h;
    y = bot + gap;
    return { top, bot, titleTop: top - titleH };
  });
  const firstTop = lay[0]?.top ?? 0;
  const lastBot = lay[lay.length - 1]?.bot ?? 0;
  const H = lastBot + 42;

  const mondays = dates.map((d, i) => (i > 0 && dow(d) === 1 ? i : -1)).filter((i) => i >= 0);
  const showDate = (i: number) => {
    if (i === dates.length - 1) return true;
    const d = dow(dates[i]);
    if (narrow || step < 9) return d === 1 && (step >= 5 || isoWeek(dates[i]) % 2 === 0);
    return d === 1 || d === 4;
  };
  // подписи недель — по центру недели внутри периода
  const weeks: { a: number; b: number; w: number }[] = [];
  dates.forEach((d, i) => {
    const w = isoWeek(d); const last = weeks[weeks.length - 1];
    if (last && last.w === w) last.b = i; else weeks.push({ a: i, b: i, w });
  });

  function onMove(e: React.PointerEvent) {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const k = svg.viewBox.baseVal.width / rect.width;
    const sx = (e.clientX - rect.left) * k; const sy = (e.clientY - rect.top) * k;
    const i = N - 1 - Math.min(N - 1, Math.max(0, Math.floor((sx - L) / step)));
    let p = lay.findIndex((l) => sy <= l.bot + gap / 2);
    if (p < 0) p = lay.length - 1;
    const left = X(i) / k;
    const tw = card ? Math.min(card, rect.width - 16) : 260;
    setHover({ i, p, left, y: (e.clientY - rect.top), flip: left + 14 + tw > rect.width });
  }

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ height: 'auto', overflow: 'visible', display: 'block' }}>
        {/* разделители недель */}
        {mondays.map((i) => <line key={`w${i}`} x1={cell(i) + step} x2={cell(i) + step} y1={firstTop} y2={lastBot} stroke={C.muted} strokeOpacity={0.35} />)}
        {panels.map((p, pi) => {
          const { top, bot, titleTop } = lay[pi];
          // левая шкала
          const vals: number[] = [];
          if (p.stack) for (let i = 0; i < N; i++) vals.push(p.stack.reduce((t, s) => t + (s.values[i] ?? 0), 0));
          for (const l of p.lines ?? []) for (const v of l.values) if (v != null) vals.push(v);
          let lo: number; let hi: number; let st: number;
          if (p.range) { [lo, hi] = p.range; st = niceStep(hi - lo, 2); } else if (p.zero === false) {
            const mn = vals.length ? Math.min(...vals) : 0; const mx = vals.length ? Math.max(...vals) : 1;
            st = niceStep(mx - mn || Math.abs(mx) * 0.2 || 1, 3);
            lo = Math.floor(mn / st) * st; hi = Math.ceil(mx / st) * st; if (hi <= lo) hi = lo + st;
          } else {
            const mx = Math.max(p.max ?? 0, ...vals, 0);
            st = niceStep(mx || 1, mx > 6 ? 4 : 2); if (st < 1 && !p.unit) st = 1;
            lo = 0; hi = Math.max(st, Math.ceil(mx / st) * st);
          }
          const Y = (v: number) => bot - ((v - lo) / (hi - lo)) * p.h;
          const ticks: number[] = []; for (let v = lo; v <= hi + st / 1e6; v += st) ticks.push(Math.round(v * 1e6) / 1e6);
          // правая шкала
          let YR: ((v: number) => number) | null = null; let rTicks: number[] = [];
          if (p.right) {
            const rv = [...(p.right.bars?.values ?? []), ...(p.right.area?.values ?? [])].filter((v): v is number => v != null);
            const mx = Math.max(1, ...rv); const rs = niceStep(mx, 3); const rhi = Math.ceil(mx / rs) * rs;
            YR = (v: number) => bot - (v / rhi) * p.h;
            for (let v = 0; v <= rhi; v += rs) rTicks.push(v);
          }
          const dim = (i: number) => (today && dates[i] === today ? 0.45 : 1);
          return (
            <g key={pi}>
              {pi > 0 && <line x1={0} x2={W} y1={titleTop - gap / 2} y2={titleTop - gap / 2} stroke="#eef0f3" />}
              <text x={L} y={titleTop + 14} fontSize={13} fontWeight={600} fill="#1e293b" className="font-ui">{narrow && p.short ? p.short : p.title}</text>
              {p.band?.map((b, i) => b && <rect key={`b${i}`} x={cell(i)} y={top} width={step} height={p.h} fill={C.band} />)}
              {ticks.map((v) => (
                <g key={`t${v}`}>
                  <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={C.line} />
                  <text x={L - 6} y={Y(v) + 3.5} fontSize={11} textAnchor="end" fill="#64748b" className="font-mono">{fmt(v, 1)}{p.unit ?? ''}</text>
                </g>
              ))}
              {YR && rTicks.map((v) => <text key={`r${v}`} x={W - R + 6} y={YR!(v) + 3.5} fontSize={11} fill={C.muted} className="font-mono">{fmt(v)} {p.right!.unit}</text>)}
              {/* правая шкала: столбцы и область */}
              {YR && p.right!.bars && p.right!.bars.values.map((v, i) => v != null && v > 0 && (
                <rect key={`rb${i}`} x={X(i) - bw / 2} y={YR!(v)} width={bw} height={bot - YR!(v)} rx={Math.min(2, bw / 3)} fill={p.right!.bars!.color} opacity={(p.right!.bars!.opacity ?? 0.28) * dim(i)} />
              ))}
              {YR && p.right!.area && (() => {
                const a = p.right!.area!; const segs: number[][] = [];
                a.values.forEach((v, i) => { if (v == null) return; const s = segs[segs.length - 1]; if (s && s[s.length - 1] === i - 1) s.push(i); else segs.push([i]); });
                return segs.map((s, k) => {
                  const xs = s.map((i) => [i === s[0] ? cell(i) + step : X(i), YR!(a.values[i]!)] as const);
                  const end = cell(s[s.length - 1]);
                  const line = xs.map(([x, yy], j) => `${j ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`).join('') + `L${end.toFixed(1)},${xs[xs.length - 1][1].toFixed(1)}`;
                  return (
                    <g key={`a${k}`}>
                      <path d={`${line}L${end.toFixed(1)},${bot}L${xs[0][0].toFixed(1)},${bot}Z`} fill={a.color} opacity={0.16} />
                      <path d={line} fill="none" stroke={a.color} strokeWidth={a.width ?? 1.5} />
                    </g>
                  );
                });
              })()}
              {/* столбцы с накоплением */}
              {p.stack && dates.map((_, i) => {
                let acc = 0;
                return p.stack!.map((s, si) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  const y0 = Y(acc); const y1 = Y(acc + v); const gapPx = acc > 0 ? 1.5 : 0;
                  acc += v;
                  return <rect key={`s${i}-${si}`} x={X(i) - bw / 2} y={y1} width={bw} height={Math.max(0.5, y0 - y1 - gapPx)} rx={Math.min(2, bw / 3)} fill={s.color} opacity={(s.opacity ?? 1) * dim(i)} />;
                });
              })}
              {/* линии */}
              {(p.lines ?? []).map((l, li) => (
                <g key={`l${li}`}>
                  {l.bridge && <path d={linePath(l.values, X, Y, true)} fill="none" stroke={l.color} strokeWidth={1.2} strokeDasharray="4 4" opacity={0.7} />}
                  <path d={linePath(l.values, X, Y)} fill="none" stroke={l.color} strokeWidth={l.width ?? 2.2} strokeDasharray={l.dash} strokeLinejoin="round" />
                  {(l.dots ?? true) && step >= 6 && l.values.map((v, i) => v != null && <circle key={i} cx={X(i)} cy={Y(v)} r={l.width && l.width < 2 ? 1.8 : 3} fill={l.color} opacity={dim(i)} />)}
                </g>
              ))}
              {(() => {
                // подпись числа — только если не налезает на предыдущую
                let lastEnd = -Infinity;
                const ms = [...(p.marks ?? [])].sort((a, b) => X(a.i) - X(b.i));
                return ms.map((m, k) => {
                  const x = X(m.i); const tw = m.text.length * 6.2 + 4;
                  const next = ms[k + 1] ? X(ms[k + 1].i) - 5 : W;
                  const label = x + 6 >= lastEnd && x + 6 + tw <= next;
                  if (label) lastEnd = x + 7 + tw;
                  return (
                    <g key={`m${m.i}`}>
                      <path d={`M${x - 4.5},${top - 11}L${x + 4.5},${top - 11}L${x},${top - 3}Z`} fill={C.sup} />
                      {label && <text x={x + 6} y={top - 3} fontSize={10} fill={C.sup} fontWeight={600} className="font-mono">{m.text}</text>}
                    </g>
                  );
                });
              })()}
              <line x1={L} x2={W - R} y1={bot} y2={bot} stroke="#cbd5e1" />
            </g>
          );
        })}
        {/* ось времени */}
        {(() => {
          // слева направо (от свежих дней), подпись пропускается, если налезает на предыдущую
          let lastX = -Infinity;
          return dates.map((_, k) => dates.length - 1 - k).filter((i) => showDate(i)).map((i) => {
            if (X(i) - lastX < 40) return null;
            lastX = X(i);
            return <text key={`d${i}`} x={X(i)} y={lastBot + 15} fontSize={11} textAnchor="middle" fill={C.muted} className="font-mono">{dm(dates[i])}</text>;
          });
        })()}
        {weeks.map((w) => (w.b - w.a + 1) * step > (narrow ? 34 : 50) && (
          <text key={`wk${w.a}`} x={(X(w.a) + X(w.b)) / 2} y={lastBot + 31} fontSize={11} textAnchor="middle" fill="#94a3b8" className="font-ui">{narrow ? `н. ${w.w}` : `нед. ${w.w}`}</text>
        ))}
        {hover && <line x1={X(hover.i)} x2={X(hover.i)} y1={firstTop - 4} y2={lastBot} stroke={C.muted} strokeDasharray="3 3" pointerEvents="none" />}
        <rect x={L} y={0} width={pw} height={lastBot} fill="transparent" style={{ touchAction: 'pan-y' }}
          onPointerMove={onMove} onPointerDown={(e) => { if (e.pointerType !== 'mouse') onMove(e); }} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover && card != null && (() => {
        const boxW = ref.current?.clientWidth ?? W; const boxH = ref.current?.clientHeight ?? H;
        const w = Math.min(card, boxW - 16);
        const top = Math.max(0, Math.min(hover.y - 80, boxH - tipH));
        // на узком экране — по центру, иначе справа от курсора (не помещается — слева)
        const left = narrow ? (boxW - w) / 2 : hover.flip ? Math.max(0, hover.left - 14 - w) : hover.left + 14;
        return <div ref={tipRef} className="absolute z-20 pointer-events-none" style={{ top, left, width: w }}>{tooltip(hover.i, hover.p)}</div>;
      })()}
      {hover && card == null && (
        <div className="absolute z-20 pointer-events-none bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs font-mono leading-5 text-slate-700"
          style={{ top: Math.max(0, lay[hover.p].titleTop), left: hover.flip ? undefined : hover.left + 14, right: hover.flip ? `calc(100% - ${hover.left - 14}px)` : undefined, maxWidth: narrow ? 240 : 340, whiteSpace: narrow ? 'normal' : 'nowrap', fontSize: narrow ? 11 : 12 }}>
          {tooltip(hover.i, hover.p)}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string; kind?: 'bar' | 'line' | 'dash' | 'band' | 'tri' }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          {it.kind === 'line' ? <i className="w-4 h-0.5 rounded" style={{ background: it.color }} />
            : it.kind === 'dash' ? <i className="w-4 h-0 border-t-2 border-dashed" style={{ borderColor: it.color }} />
              : it.kind === 'band' ? <i className="w-3.5 h-3 rounded-sm border border-red-200" style={{ background: it.color }} />
                : it.kind === 'tri' ? <i className="w-0 h-0 border-x-[5px] border-x-transparent border-t-[7px]" style={{ borderTopColor: it.color }} />
                  : <i className="w-3 h-3 rounded-sm" style={{ background: it.color }} />}
          {it.label}
        </span>
      ))}
    </div>
  );
}
