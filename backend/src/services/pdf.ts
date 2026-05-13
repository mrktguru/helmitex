import { fromPath } from 'pdf2pic';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export interface ConvertOptions {
  density?: number;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
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
    const pngBuffer = readFileSync(result.path);
    unlinkSync(result.path);
    return pngBuffer;
  } finally {
    try { unlinkSync(pdfPath); } catch { /* ignore */ }
  }
}

// Lower-density variant for screen previews (faster, smaller files).
export function convertPdfPageToPngPreview(pdfBuffer: Buffer, pageIndex: number): Promise<Buffer> {
  return convertPdfPageToPng(pdfBuffer, pageIndex, { density: 120, width: 600, height: 600, timeoutMs: 20_000 });
}
