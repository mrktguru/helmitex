import { substituteVariables, hasVariableRefs } from './variables';

const SCALE = 3.7795 * 3;
const LABEL_FONT = "'PT Sans', sans-serif";

let _mctx: CanvasRenderingContext2D | null = null;

function browserWrapText(text: string, bold: boolean, fontSizePx: number, blockWidthPx: number): string[] {
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d')!;
  _mctx.font = `${bold ? 'bold ' : ''}${fontSizePx}px ${LABEL_FONT}`;
  const paragraphs = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result: string[] = [];
  for (const para of paragraphs) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(' ');
    let cur = '';
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (_mctx.measureText(candidate).width <= blockWidthPx - 2) {
        cur = candidate;
      } else {
        if (cur) result.push(cur);
        cur = word;
      }
    }
    if (cur) result.push(cur);
  }
  return result.length > 0 ? result : [text];
}

function getFitFontSizePx(text: string, bold: boolean, widthPx: number, heightPx: number): number {
  if (!text.trim()) return 12;
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d')!;
  const lines = text.split('\n');
  let lo = 1, hi = 600;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    _mctx.font = `${bold ? 'bold ' : ''}${mid}px ${LABEL_FONT}`;
    const maxW = Math.max(...lines.map((l) => _mctx!.measureText(l || ' ').width));
    const totalH = lines.length * mid * 1.3;
    if (maxW <= widthPx - 4 && totalH <= heightPx - 4) lo = mid;
    else hi = mid;
  }
  return Math.max(4, lo);
}

/**
 * Pre-compute wrapped lines for text/variable elements using browser canvas metrics,
 * substituting `{{token}}` references against `variables`. The PDF generator can
 * then reproduce the exact same layout without re-measuring.
 *
 * `text` content is left as-is (literal `{{token}}` preserved) — only `_wrappedLines`
 * and `_resolvedFontSizePt` are updated. Server skips its own substitution when
 * `_wrappedLines` are present.
 */
export function precomputeWraps(elements: any[], variables: Record<string, string>): any[] {
  return elements.map((el) => {
    if (el.type === 'text') {
      const blockW = el.widthMm ? el.widthMm * SCALE : 0;
      const rendered = hasVariableRefs(el.text) ? substituteVariables(el.text, variables) : (el.text ?? '');
      if (!blockW || !rendered) return { ...el, _wrappedLines: [rendered] };
      const fontSizePx = el.fitToBlock && el.heightMm
        ? getFitFontSizePx(rendered, el.bold, blockW, el.heightMm * SCALE)
        : el.fontSizePt * (SCALE / 3);
      const wrapped = browserWrapText(rendered, el.bold, fontSizePx, blockW);
      const resolvedFontSizePt = fontSizePx * 72 / (SCALE * 25.4);
      return { ...el, _wrappedLines: wrapped, _resolvedFontSizePt: resolvedFontSizePt };
    }
    if (el.type === 'variable') {
      const value = variables[el.key] ?? el.placeholder ?? '';
      const blockW = el.widthMm ? el.widthMm * SCALE : 0;
      if (!blockW) return { ...el, _wrappedLines: [value] };
      const fontSizePx = el.fitToBlock && el.heightMm
        ? getFitFontSizePx(value || ' ', el.bold, blockW, el.heightMm * SCALE)
        : el.fontSizePt * (SCALE / 3);
      const wrapped = browserWrapText(value, el.bold, fontSizePx, blockW);
      const resolvedFontSizePt = fontSizePx * 72 / (SCALE * 25.4);
      return { ...el, _wrappedLines: wrapped, _resolvedFontSizePt: resolvedFontSizePt };
    }
    return el;
  });
}
