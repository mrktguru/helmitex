// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as typeof import('bwip-js');

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
