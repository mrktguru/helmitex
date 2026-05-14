// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as typeof import('bwip-js');

import { PDFPage, PDFFont, rgb as pdfRgb } from 'pdf-lib';

// ─── EAN-13 encoding tables ───────────────────────────────────────────────────
const EAN13_L = [[0,0,0,1,1,0,1],[0,0,1,1,0,0,1],[0,0,1,0,0,1,1],[0,1,1,1,1,0,1],[0,1,0,0,0,1,1],[0,1,1,0,0,0,1],[0,1,0,1,1,1,1],[0,1,1,1,0,1,1],[0,1,1,0,1,1,1],[0,0,0,1,0,1,1]];
const EAN13_G = EAN13_L.map(p => [...p].reverse());
const EAN13_R = EAN13_L.map(p => p.map((b: number) => b ^ 1));
const EAN13_PARITY = [[0,0,0,0,0,0],[0,0,1,0,1,1],[0,0,1,1,0,1],[0,0,1,1,1,0],[0,1,0,0,1,1],[0,1,1,0,0,1],[0,1,1,1,0,0],[0,1,0,1,0,1],[0,1,0,1,1,0],[0,1,1,0,1,0]];

// EAN-13 mod-10 weighted checksum on the first 12 digits.
function ean13CheckDigit(d12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = d12.charCodeAt(i) - 48;
    sum += (i % 2 === 0) ? n : n * 3;
  }
  return (10 - (sum % 10)) % 10;
}

// Accept any input, coerce to a syntactically valid 13-digit EAN by
// recomputing the check digit from the first 12 digits.
export function normalizeEan13(value: string): string {
  let digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 0) digits = '0';
  digits = digits.slice(0, 13).padStart(13, '0');
  const head = digits.slice(0, 12);
  return head + String(ean13CheckDigit(head));
}

export async function generateEan13Png(value: string): Promise<Buffer> {
  const text = normalizeEan13(value);
  return bwipjs.toBuffer({
    bcid: 'ean13',
    text,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: 'center',
  });
}

/**
 * Draw a crisp vector EAN-13 barcode directly onto a pdf-lib page.
 * Bars are rectangles; digits are drawText calls — no rasterisation at any scale.
 *
 * Coordinate convention (same as pdfGenerator.ts):
 *   xLeft, yBottom — bottom-left corner in pdf-lib pts (Y axis up)
 *   wPt, hPt       — element size in pts
 */
export function drawEan13Vector(
  page: PDFPage,
  xLeft: number,
  yBottom: number,
  wPt: number,
  hPt: number,
  value: string,
  font: PDFFont,
): void {
  const ean = normalizeEan13(value);
  const d = ean.split('').map(Number);
  const first = d[0];
  const leftD = d.slice(1, 7);
  const rightD = d.slice(7);
  const par = EAN13_PARITY[first];

  // Build bar list: {pos: module index 0-94, isGuard}
  type BarDef = { pos: number; isGuard: boolean };
  const barDefs: BarDef[] = [];
  const addBits = (bits: number[], offset: number, isGuard: boolean) =>
    bits.forEach((b, i) => { if (b) barDefs.push({ pos: offset + i, isGuard }); });

  addBits([1,0,1], 0, true);
  leftD.forEach((digit, i) => addBits(par[i] === 0 ? EAN13_L[digit] : EAN13_G[digit], 3 + i * 7, false));
  addBits([0,1,0,1,0], 45, true);
  rightD.forEach((digit, i) => addBits(EAN13_R[digit], 50 + i * 7, false));
  addBits([1,0,1], 92, true);

  // Virtual coordinate system: 113 units wide (11 left quiet + 95 bars + 7 right quiet)
  const VW = 113;
  const LQUIET = 11;
  const unitW = wPt / VW;

  // Height split: 82% bars, 18% text
  const TEXT_FRAC = 0.18;
  const textH = hPt * TEXT_FRAC;
  const barH = hPt - textH;
  const guardExtend = textH * 0.55; // guards reach down into text zone

  // Draw bars (Y grows upward in pdf-lib)
  barDefs.forEach(({ pos, isGuard }) => {
    const bx = xLeft + (LQUIET + pos) * unitW;
    const bh = isGuard ? barH + guardExtend : barH;
    const by = isGuard ? yBottom + textH - guardExtend : yBottom + textH;
    page.drawRectangle({ x: bx, y: by, width: Math.max(unitW, 0.4), height: bh, color: pdfRgb(0, 0, 0) });
  });

  // Draw digits — properly centred using font metrics
  const fontSize = textH * 0.85;
  const ty = yBottom + textH * 0.08; // baseline just above bottom edge

  const drawCentredDigit = (digit: number, centreModuleX: number) => {
    const cx = xLeft + centreModuleX * unitW;
    const charW = font.widthOfTextAtSize(String(digit), fontSize);
    page.drawText(String(digit), { x: cx - charW / 2, y: ty, size: fontSize, font, color: pdfRgb(0, 0, 0) });
  };

  // First digit: centre of left quiet zone (module offset 5.5 from element left)
  drawCentredDigit(first, 5.5);
  // Left 6 digits: centres at LQUIET + 3 + i*7 + 3.5
  leftD.forEach((digit, i) => drawCentredDigit(digit, LQUIET + 3 + i * 7 + 3.5));
  // Right 6 digits: centres at LQUIET + 50 + i*7 + 3.5
  rightD.forEach((digit, i) => drawCentredDigit(digit, LQUIET + 50 + i * 7 + 3.5));
}
