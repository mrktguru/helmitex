// Shared EAN-13 SVG renderer used by both the editor and the dashboard preview.

const EAN13_L = [[0,0,0,1,1,0,1],[0,0,1,1,0,0,1],[0,0,1,0,0,1,1],[0,1,1,1,1,0,1],[0,1,0,0,0,1,1],[0,1,1,0,0,0,1],[0,1,0,1,1,1,1],[0,1,1,1,0,1,1],[0,1,1,0,1,1,1],[0,0,0,1,0,1,1]];
const EAN13_G = EAN13_L.map((p) => [...p].reverse());
const EAN13_R = EAN13_L.map((p) => p.map((b) => b ^ 1));
const EAN13_PARITY = [[0,0,0,0,0,0],[0,0,1,0,1,1],[0,0,1,1,0,1],[0,0,1,1,1,0],[0,1,0,0,1,1],[0,1,1,0,0,1],[0,1,1,1,0,0],[0,1,0,1,0,1],[0,1,0,1,1,0],[0,1,1,0,1,0]];

export function normalizeEan13(value: string): string {
  let digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 0) digits = '0';
  digits = digits.slice(0, 13).padStart(13, '0');
  const head = digits.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(head[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return head + check;
}

export interface Ean13Bar { x: number; h: number }

export function buildEan13Geometry(value: string) {
  const ean = normalizeEan13(value);
  const d = ean.split('').map(Number);
  const first = d[0];
  const leftD = d.slice(1, 7);
  const rightD = d.slice(7);
  const par = EAN13_PARITY[first];

  const bars: Ean13Bar[] = [];
  const addBits = (bits: number[], offset: number, isGuard: boolean) =>
    bits.forEach((b, i) => { if (b) bars.push({ x: offset + i, h: isGuard ? 44 : 42 }); });

  addBits([1,0,1], 0, true);
  leftD.forEach((digit, i) => addBits(par[i] === 0 ? EAN13_L[digit] : EAN13_G[digit], 3 + i * 7, false));
  addBits([0,1,0,1,0], 45, true);
  rightD.forEach((digit, i) => addBits(EAN13_R[digit], 50 + i * 7, false));
  addBits([1,0,1], 92, true);

  return { first, leftD, rightD, bars };
}
