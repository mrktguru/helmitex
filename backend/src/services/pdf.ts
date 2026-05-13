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
  // Strategy:
  //  1) Build a blurred mask — thin frame lines vanish, DataMatrix block survives.
  //  2) Find content bbox on the mask.
  //  3) Strip the human-readable text below the DataMatrix by scanning rows
  //     from the bottom and stopping at the first "dense" row (≥8% dark pixels
  //     spanning the width), which is the DataMatrix bottom border.
  //  4) Crop original, then binarize for crispness.
  try {
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return buf;

    // Mild blur is enough to erase hairline frames (1-2 px → mid-gray, above
    // threshold) while preserving the structure of the DataMatrix where cells
    // are 5+ px wide at 450 DPI. A heavy blur erodes the timing/sparse rows
    // of the DM and produces a squashed crop.
    const sigma = 1.5;
    const maskRaw = await sharp(buf)
      .grayscale()
      .blur(sigma)
      .threshold(threshold)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mask = maskRaw.data;
    const mw = maskRaw.info.width;
    const mh = maskRaw.info.height;

    let minX = mw, minY = mh, maxX = -1, maxY = -1;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (mask[y * mw + x] === 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxY < 0) return buf;

    const contentW = maxX - minX + 1;
    const contentH = maxY - minY + 1;

    // Strip the human-readable caption: search for an empty horizontal gap
    // (≥ ~2% of content height of pure-white rows) starting just below the
    // densest row of the page. The first such gap separates DataMatrix from
    // the caption below it. If no clear gap exists, keep full bbox.
    let densestRow = minY, densestCount = 0;
    const rowCounts = new Int32Array(mh);
    for (let y = minY; y <= maxY; y++) {
      let c = 0;
      for (let x = minX; x <= maxX; x++) {
        if (mask[y * mw + x] === 0) c++;
      }
      rowCounts[y] = c;
      if (c > densestCount) { densestCount = c; densestRow = y; }
    }

    let dmBottom = maxY;
    const gapNeeded = Math.max(4, Math.round(contentH * 0.02));
    let gapRun = 0;
    for (let y = densestRow + 1; y <= maxY; y++) {
      if (rowCounts[y] === 0) {
        gapRun++;
        if (gapRun >= gapNeeded) { dmBottom = y - gapRun; break; }
      } else {
        gapRun = 0;
      }
    }

    const pad = Math.max(4, Math.round(Math.min(w, h) * 0.01));
    const left   = Math.max(0, minX - pad);
    const top    = Math.max(0, minY - pad);
    const right  = Math.min(w, maxX + pad + 1);
    const bottom = Math.min(h, dmBottom + pad + 1);
    const cropW  = right - left;
    const cropH  = bottom - top;
    if (cropW <= 0 || cropH <= 0) return buf;

    const out = await sharp(buf)
      .extract({ left, top, width: cropW, height: cropH })
      .threshold(160)
      .toBuffer();

    // Pad to a square so the DataMatrix keeps its 1:1 aspect ratio when later
    // letterboxed into the (possibly non-square) czArea. Honest Sign DM codes
    // are always square — any rectangular crop here is detection slack.
    const side = Math.max(cropW, cropH);
    const finalPng = await sharp(out)
      .extend({
        top:    Math.floor((side - cropH) / 2),
        bottom: Math.ceil((side - cropH) / 2),
        left:   Math.floor((side - cropW) / 2),
        right:  Math.ceil((side - cropW) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return Buffer.from(finalPng);
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
