import { fromPath } from 'pdf2pic';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';

export interface ConvertOptions {
  density?: number;
  width?: number;
  height?: number;
  timeoutMs?: number;
  /** Auto-crop near-white margins so only the actual artwork remains. Default: true. */
  trim?: boolean;
  /** Pixels with luminance below this value count as "content". Default: 110. */
  trimThreshold?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function trimWhitespace(buf: Buffer, _threshold: number): Promise<Buffer> {
  // Minimal & robust:
  //  1) sharp.trim() — strip white margins precisely.
  //  2) Pad to square — preserves DataMatrix 1:1 aspect when later
  //     letterboxed into a non-square czArea.
  // The human-readable caption stays attached; it does not interfere with
  // scanning and removes the only source of crop-height ambiguity.
  try {
    const trimmed = await sharp(buf)
      .trim({ background: '#ffffff', threshold: 10 })
      .toBuffer();
    const meta = await sharp(trimmed).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return buf;
    const side = Math.max(w, h);
    const out = await sharp(trimmed)
      .extend({
        top:    Math.floor((side - h) / 2),
        bottom: Math.ceil((side - h) / 2),
        left:   Math.floor((side - w) / 2),
        right:  Math.ceil((side - w) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return Buffer.from(out);
  } catch (e) {
    console.warn('[pdf] trimWhitespace failed:', e);
    return buf;
  }
}

export async function convertPdfPageToPng(
  pdfBuffer: Buffer,
  pageIndex: number,
  opts: ConvertOptions = {},
): Promise<Buffer> {
  const density = opts.density ?? 450;
  // No hard width/height cap by default — at 450 DPI an A4 page is ~3700px wide
  // which is required for crisp DataMatrix after cropping. Callers that need
  // small previews should pass explicit width/height.
  const width = opts.width;
  const height = opts.height;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doTrim = opts.trim ?? true;
  const threshold = opts.trimThreshold ?? 110;

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cz-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  writeFileSync(pdfPath, pdfBuffer);

  try {
    const converter = fromPath(pdfPath, {
      density,
      saveFilename: 'page',
      savePath: tmpDir,
      format: 'png',
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });

    const result = await withTimeout(converter(pageIndex), timeoutMs, `pdf2pic page ${pageIndex}`);
    if (!result.path) throw new Error('Conversion produced no output');
    let pngBuffer: Buffer = readFileSync(result.path);
    unlinkSync(result.path);
    if (doTrim) pngBuffer = await trimWhitespace(pngBuffer, threshold);
    return pngBuffer;
  } finally {
    try { unlinkSync(pdfPath); } catch { /* ignore */ }
  }
}

// Lower-density variant for screen previews (faster, smaller files).
export function convertPdfPageToPngPreview(pdfBuffer: Buffer, pageIndex: number): Promise<Buffer> {
  return convertPdfPageToPng(pdfBuffer, pageIndex, { density: 200, timeoutMs: 25_000 });
}
