import prisma from '../prisma/client';
import { downloadFile, uploadFile, objectExists } from './s3';
import { convertPdfPageToPng } from './pdf';
import { decodeDataMatrix, encodeDataMatrix } from './datamatrix';

const CACHE_PREFIX = 'cache/cz-dm-v1';

/**
 * Returns a clean, re-encoded DataMatrix PNG for the given (batch, page).
 *
 * Pipeline (cached on S3, run at most once per page):
 *   1. Render PDF page → raster PNG (450 dpi via pdf2pic).
 *   2. Decode DataMatrix payload via pylibdmtx (Python child).
 *   3. Persist payload on CzCode.code.
 *   4. Re-encode payload as a clean square DataMatrix via bwip-js.
 *   5. Upload the clean PNG to S3 cache and return it.
 *
 * On subsequent calls only step 5's download runs.
 */
export async function getCleanCzPng(
  czBatchId: string,
  pageIndex: number,
  pdfBuffer: Buffer,
): Promise<Buffer> {
  const key = `${CACHE_PREFIX}/${czBatchId}/page-${pageIndex}.png`;
  if (await objectExists(key)) {
    return await downloadFile(key);
  }

  // Need raw raster to feed the decoder. Use the trim=false path: we want the
  // original page, decoder picks the DM out by itself.
  const raster = await convertPdfPageToPng(pdfBuffer, pageIndex, {
    timeoutMs: 60_000,
    trim: false,
  });

  const payload = await decodeDataMatrix(raster);
  if (!payload) throw new Error(`DataMatrix decode failed on page ${pageIndex}`);

  // Persist the decoded payload (best effort — not fatal if no row exists).
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
