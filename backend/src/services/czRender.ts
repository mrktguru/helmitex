import prisma from '../prisma/client';
import { downloadFile, uploadFile } from './s3';
import { convertPdfPageToPng } from './pdf';
import { decodeDataMatrix, encodeDataMatrix } from './datamatrix';

const CACHE_PREFIX = 'cache/cz-dm-v3';

/**
 * Returns a clean, re-encoded DataMatrix PNG for the given (batch, page).
 *
 * Pipeline (cached on S3, run at most once per page):
 *   1. Try single GET from S3 — fast path, no extra HEAD round-trip.
 *   2. Render PDF page → raster at 250 DPI (~3× faster than 450 DPI).
 *   3. Decode DataMatrix payload via pylibdmtx (Python child).
 *   4. Persist payload on CzCode.code.
 *   5. Re-encode clean square DataMatrix via bwip-js.
 *   6. Upload to S3 cache and return.
 */
export async function getCleanCzPng(
  czBatchId: string,
  pageIndex: number,
  pdfBuffer: Buffer,
): Promise<Buffer> {
  const key = `${CACHE_PREFIX}/${czBatchId}/page-${pageIndex}.png`;

  // Fast path: single GET — no separate HEAD round-trip.
  try {
    return await downloadFile(key);
  } catch {
    // Not cached yet — build it.
  }

  // 250 DPI is sufficient for pylibdmtx; ~3× faster than 450 DPI in Ghostscript.
  const raster = await convertPdfPageToPng(pdfBuffer, pageIndex, {
    density: 250,
    timeoutMs: 60_000,
    trim: false,
  });

  const payload = await decodeDataMatrix(raster);
  if (!payload) throw new Error(`DataMatrix decode failed on page ${pageIndex}`);

  try {
    await prisma.czCode.updateMany({
      where: { czBatchId, pageIndex },
      data: { code: payload },
    });
  } catch (e) {
    console.warn('[cz] persist code failed:', e);
  }

  const cleanPng = await encodeDataMatrix(payload, 10);
  try { await uploadFile(key, cleanPng, 'image/png'); } catch (e) { console.warn('[cz] cache write failed:', e); }
  return cleanPng;
}
