import { useEffect, useState } from 'react';
import { api } from '../api/client';

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
        style={{ width: '100%', maxWidth: maxWidthPx, height: 'auto', aspectRatio: `${aspectRatio}` }}
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
              : (el.text ?? '');
            if (!value) return null;
            // Approximate text rendering — use foreignObject for proper wrap.
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
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {value}
                </div>
              </foreignObject>
            );
          }
          if (el.type === 'barcode') {
            return (
              <g key={el.id}>
                <rect x={el.xMm} y={el.yMm} width={el.widthMm} height={el.heightMm} fill="#fff" stroke="#ccc" strokeWidth={0.1} />
                {/* Simple stripe pattern */}
                {Array.from({ length: 30 }).map((_, i) => (
                  <rect key={i}
                    x={el.xMm + 0.5 + i * (el.widthMm - 1) / 30}
                    y={el.yMm + 0.5}
                    width={(el.widthMm - 1) / 60}
                    height={el.heightMm * 0.7}
                    fill="#000" />
                ))}
              </g>
            );
          }
          if (el.type === 'eac') {
            return (
              <g key={el.id}>
                <rect x={el.xMm} y={el.yMm} width={el.widthMm} height={el.heightMm} fill="#fff" />
                <text
                  x={el.xMm + el.widthMm / 2}
                  y={el.yMm + el.heightMm / 2 + el.heightMm * 0.15}
                  fontSize={el.heightMm * 0.4}
                  textAnchor="middle"
                  fontFamily="serif"
                  fontWeight="bold"
                  fill={el.color ?? '#000'}
                >EAC</text>
              </g>
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
