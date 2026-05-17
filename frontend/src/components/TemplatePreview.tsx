import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { buildEan13Geometry } from '../lib/ean13';
import { substituteVariables } from '../lib/variables';

interface Props {
  projectId: string;
  /** Max rendered width in pixels (preview scales label to fit this). */
  maxWidthPx?: number;
  variables?: Record<string, string>;
}

interface TemplateData {
  widthMm: number;
  heightMm: number;
  elements: any[];
  czArea: { xMm: number; yMm: number; widthMm: number; heightMm: number };
  variables?: Record<string, string> | null;
}

/**
 * Client-side SVG preview of a label template — no server thumbnail needed.
 * Renders the same element types as the editor (text, variable, rect, barcode, eac, image)
 * in a non-interactive scaled-down view.
 */
export default function TemplatePreview({ projectId, maxWidthPx = 900, variables }: Props) {
  const [t, setT] = useState<TemplateData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getTemplate(projectId)
      .then((data) => setT(data))
      .catch(() => setT(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <div className="text-sm text-gray-400 text-center py-10">Загрузка превью…</div>;
  if (!t) return <div className="text-sm text-gray-400 text-center py-10">Шаблон ещё не создан</div>;

  const aspectRatio = t.widthMm / t.heightMm;

  const effectiveVars: Record<string, string> = { ...(t.variables ?? {}), ...(variables ?? {}) };

  return (
    <div className="w-full flex justify-center">
      <svg
        viewBox={`0 0 ${t.widthMm} ${t.heightMm}`}
        preserveAspectRatio="xMidYMid meet"
        className="bg-white border border-gray-300 shadow"
        style={{ width: '100%', maxWidth: maxWidthPx, height: 'auto', aspectRatio: `${aspectRatio}`, borderRadius: 6 }}
      >
        {/* Elements */}
        {t.elements.map((el) => {
          if (el.type === 'rect') {
            return (
              <rect
                key={el.id}
                x={el.xMm} y={el.yMm}
                width={el.widthMm} height={el.heightMm}
                fill={el.fillColor ?? 'none'}
                stroke={el.strokeColor ?? '#000'}
                strokeWidth={(el.strokeWidthPt ?? 1) / 2.83}
              />
            );
          }
          if (el.type === 'text' || el.type === 'variable') {
            const value = el.type === 'variable'
              ? (effectiveVars[el.key] ?? el.placeholder ?? `{${el.key}}`)
              : substituteVariables(el.text ?? '', effectiveVars);
            if (!value) return null;
            // Use pre-computed line breaks if the value matches what was wrapped
            // (i.e. variables haven't changed since the last save). Falls back to
            // browser wrap (pre-wrap) for new/unsaved values.
            const cachedLines: string[] | null = Array.isArray(el._wrappedLines) ? el._wrappedLines : null;
            const usePrewrapped = cachedLines && cachedLines.join('\n').replace(/\s+/g, ' ').trim() === value.replace(/\s+/g, ' ').trim();
            return (
              <foreignObject
                key={el.id}
                x={el.xMm} y={el.yMm}
                width={el.widthMm ?? 0} height={el.heightMm ?? 0}
              >
                <div
                  // @ts-ignore — xmlns needed for foreignObject content
                  xmlns="http://www.w3.org/1999/xhtml"
                  style={{
                    width: '100%', height: '100%', overflow: 'hidden',
                    fontFamily: "'PT Sans', sans-serif",
                    fontSize: `${(el._resolvedFontSizePt ?? el.fontSizePt ?? 10) * 0.353}px`,
                    fontWeight: el.bold ? 'bold' : 'normal',
                    color: el.type === 'variable' && !effectiveVars[el.key]
                      ? '#9ca3af'
                      : (el.color ?? '#000'),
                    fontStyle: el.type === 'variable' && !effectiveVars[el.key] ? 'italic' : 'normal',
                    lineHeight: 1.3,
                    textAlign: el.align ?? 'left',
                    whiteSpace: usePrewrapped ? 'pre' : 'pre-wrap',
                    wordBreak: 'keep-all',
                  }}
                >
                  {usePrewrapped ? cachedLines!.join('\n') : value}
                </div>
              </foreignObject>
            );
          }
          if (el.type === 'barcode') {
            const { first, leftD, rightD, bars } = buildEan13Geometry(el.value ?? '');
            const LQUIET = 11;
            const FS = 5.2;
            const TY = 49;
            return (
              <svg key={el.id}
                x={el.xMm} y={el.yMm}
                width={el.widthMm} height={el.heightMm}
                viewBox="0 0 113 50"
                preserveAspectRatio="none"
              >
                <rect width="113" height="50" fill="white" />
                {bars.map((b, i) => (
                  <rect key={i} x={LQUIET + b.x} y={0} width={1} height={b.h} fill="black" />
                ))}
                <text x={5.5} y={TY} fontSize={FS} textAnchor="middle" fontFamily="monospace" fill="black">{first}</text>
                {leftD.map((digit, i) => (
                  <text key={`l${i}`} x={LQUIET + 3 + i * 7 + 3.5} y={TY} fontSize={FS} textAnchor="middle" fontFamily="monospace" fill="black">{digit}</text>
                ))}
                {rightD.map((digit, i) => (
                  <text key={`r${i}`} x={LQUIET + 50 + i * 7 + 3.5} y={TY} fontSize={FS} textAnchor="middle" fontFamily="monospace" fill="black">{digit}</text>
                ))}
              </svg>
            );
          }
          if (el.type === 'eac') {
            const isBlack = !el.color || el.color === '#000000' || el.color === '#000';
            return (
              <image key={el.id}
                href="/eac-icon.svg"
                x={el.xMm} y={el.yMm}
                width={el.widthMm} height={el.heightMm}
                preserveAspectRatio="xMidYMid meet"
                style={isBlack ? undefined : { filter: hexToCssFilter(el.color) }}
              />
            );
          }
          if (el.type === 'image') {
            return (
              <rect key={el.id}
                x={el.xMm} y={el.yMm}
                width={el.widthMm} height={el.heightMm}
                fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.2} strokeDasharray="0.5 0.5"
              />
            );
          }
          return null;
        })}
        {/* CZ area marker */}
        <rect
          x={t.czArea.xMm} y={t.czArea.yMm}
          width={t.czArea.widthMm} height={t.czArea.heightMm}
          fill="rgba(249, 115, 22, 0.06)"
          stroke="#f97316" strokeWidth={0.3} strokeDasharray="0.6 0.4"
        />
      </svg>
    </div>
  );
}

// Approximate CSS filter chain that tints a black SVG icon to the given color.
// Good enough for preview — matches the heuristic used in the editor.
function hexToCssFilter(hex?: string): string {
  if (!hex || hex === '#000000' || hex === '#000') return 'none';
  if (hex === '#ffffff' || hex === '#fff') return 'invert(1)';
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const hue = Math.round(Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI);
  return `invert(${Math.round((1 - brightness) * 100)}%) sepia(100%) saturate(10) hue-rotate(${hue}deg)`;
}
