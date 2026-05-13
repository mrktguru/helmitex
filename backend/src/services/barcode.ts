// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require('bwip-js') as typeof import('bwip-js');

export async function generateEan13Png(value: string): Promise<Buffer> {
  // Ensure 13-digit EAN (pad or trim check digit)
  const text = value.replace(/\D/g, '').slice(0, 13).padStart(13, '0');
  return bwipjs.toBuffer({
    bcid: 'ean13',
    text,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: 'center',
  });
}
