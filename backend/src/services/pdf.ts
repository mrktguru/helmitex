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
  // Step 1: precise bbox via sharp.trim() — anything not pure-white is content.
  // Honest Sign source PDFs have a clean white page, so this gives a tight
  // box around (DataMatrix + caption text).
  // Step 2: scan rows on the trimmed image and locate the horizontal white
  // gap that separates DM from caption. Crop above the gap.
  // Step 3: pad to square so czArea letterbox keeps 1:1 ratio.
  try {
    const trimmed = await sharp(buf)
      .trim({ background: '#ffffff', threshold: 10 })
      .toBuffer();

    const meta = await sharp(trimmed).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return buf;

    // Row darkness on the trimmed image.
    const grayRaw = await sharp(trimmed)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const g = grayRaw.data;

    const rowDark = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      const off = y * W;
      for (let x = 0; x < W; x++) {
        if (g[off + x] < 200) c++;
      }
      rowDark[y] = c;
    }
    let densest = 0, densestRow = 0;
    for (let y = 0; y < H; y++) {
      if (rowDark[y] > densest) { densest = rowDark[y]; densestRow = y; }
    }

    // Search below the densest row for a run of nearly-empty rows
    // (≥1.5% of content height of rows with <1% dark pixels).
    const gapMin = Math.max(6, Math.round(H * 0.015));
    const rowEmptyThresh = Math.max(1, Math.round(W * 0.01));
    let cutY = H;
    let run = 0;
    for (let y = densestRow + 1; y < H; y++) {
      if (rowDark[y] <= rowEmptyThresh) {
        run++;
        if (run >= gapMin) { cutY = y - run + 1; break; }
      } else {
        run = 0;
      }
    }

    // Crop original-trimmed image above the cut.
    const cropH = Math.max(1, cutY);
    let cropped = trimmed;
    if (cropH < H) {
      cropped = await sharp(trimmed)
        .extract({ left: 0, top: 0, width: W, height: cropH })
        .toBuffer();
    }

    const finalMeta = await sharp(cropped).metadata();
    const fw = finalMeta.width ?? W;
    const fh = finalMeta.height ?? cropH;
    const side = Math.max(fw, fh);

    const out = await sharp(cropped)
      .threshold(180)
      .extend({
        top:    Math.floor((side - fh) / 2),
        bottom: Math.ceil((side - fh) / 2),
        left:   Math.floor((side - fw) / 2),
        right:  Math.ceil((side - fw) / 2),
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
