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

async function trimWhitespace(buf: Buffer, threshold: number): Promise<Buffer> {
  // Custom bbox detection: find the tightest rectangle containing any pixel
  // darker than `threshold`. This is far more aggressive than sharp.trim,
  // which stops at the first non-white pixel and is fooled by thin gray
  // borders on label sheets.
  try {
    const img = sharp(buf).ensureAlpha();
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return buf;

    const { data } = await img.raw().toBuffer({ resolveWithObject: true });
    // RGBA, 4 bytes per pixel
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 16) continue;
        // Luminance — only react to *really* dark pixels (DataMatrix, glyphs).
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < threshold) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0 || maxY < 0) return buf; // empty page

    // Small padding around content (1.5% of min dimension, min 4 px).
    const pad = Math.max(4, Math.round(Math.min(w, h) * 0.015));
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const right = Math.min(w, maxX + pad + 1);
    const bottom = Math.min(h, maxY + pad + 1);
    const cropW = right - left;
    const cropH = bottom - top;
    if (cropW <= 0 || cropH <= 0) return buf;

    const out = await sharp(buf)
      .extract({ left, top, width: cropW, height: cropH })
      .png()
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
  const density = opts.density ?? 300;
  const width = opts.width ?? 1200;
  const height = opts.height ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 45_000;
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
      width,
      height,
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
  return convertPdfPageToPng(pdfBuffer, pageIndex, { density: 120, width: 600, height: 600, timeoutMs: 20_000 });
}
