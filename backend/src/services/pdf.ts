import { fromPath } from 'pdf2pic';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export async function convertPdfPageToPng(pdfBuffer: Buffer, pageIndex: number): Promise<Buffer> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cz-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  writeFileSync(pdfPath, pdfBuffer);

  try {
    const converter = fromPath(pdfPath, {
      density: 300,
      saveFilename: 'page',
      savePath: tmpDir,
      format: 'png',
      width: 1200,
      height: 1200,
    });

    const result = await converter(pageIndex);
    if (!result.path) throw new Error('Conversion produced no output');
    const pngBuffer = readFileSync(result.path);
    unlinkSync(result.path);
    return pngBuffer;
  } finally {
    try { unlinkSync(pdfPath); } catch { /* ignore */ }
  }
}
