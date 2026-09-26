import prisma from '../prisma/client';
import { downloadFile, uploadFile } from './s3';
import { convertPdfPageToPng, renderPdfPages } from './pdf';
import { decodeDataMatrix, encodeDataMatrix } from './datamatrix';

const CACHE_PREFIX = 'cache/cz-dm-v3';
const RASTER_DENSITY = 250;
/** Pages per Ghostscript process, and how many Ghostscript processes run at once (process-wide). */
const GS_CHUNK_PAGES = 20;
const GS_CONCURRENCY = Math.max(1, Number(process.env.GS_CONCURRENCY) || 2);
let gsRunning = 0;
const gsWaiting: Array<() => void> = [];

async function withGsSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (gsRunning >= GS_CONCURRENCY) await new Promise<void>((resolve) => gsWaiting.push(resolve));
  gsRunning++;
  try {
    return await fn();
  } finally {
    gsRunning--;
    gsWaiting.shift()?.();
  }
}
const CACHE_FETCH_CONCURRENCY = 8;

const cacheKey = (czBatchId: string, pageIndex: number) => `${CACHE_PREFIX}/${czBatchId}/page-${pageIndex}.png`;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

/** Raster -> decoded payload (persisted on CzCode) -> clean re-encoded PNG (cached on S3). */
async function buildCleanPng(czBatchId: string, pageIndex: number, raster: Buffer): Promise<Buffer> {
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
  try { await uploadFile(cacheKey(czBatchId, pageIndex), cleanPng, 'image/png'); } catch (e) { console.warn('[cz] cache write failed:', e); }
  return cleanPng;
}


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
  // Fast path: single GET — no separate HEAD round-trip.
  try {
    return await downloadFile(cacheKey(czBatchId, pageIndex));
  } catch {
    // Not cached yet — build it.
  }

  // 250 DPI is sufficient for pylibdmtx; ~3× faster than 450 DPI in Ghostscript.
  const raster = await convertPdfPageToPng(pdfBuffer, pageIndex, {
    density: RASTER_DENSITY,
    timeoutMs: 60_000,
    trim: false,
  });
  return buildCleanPng(czBatchId, pageIndex, raster);
}

/**
 * Bulk variant of getCleanCzPng for many pages of one PDF (the PDF worker).
 * Cached pages are fetched in parallel; the rest are rasterized GS_CHUNK_PAGES at
 * a time by one Ghostscript process and fed straight into the decoder pool.
 * Fails as a whole if any page fails, like the per-page version.
 */
export async function getCleanCzPngs(
  czBatchId: string,
  pageIndexes: number[],
  pdfBuffer: Buffer,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, Buffer>> {
  const result = new Map<number, Buffer>();
  const pages = Array.from(new Set(pageIndexes)).sort((a, b) => a - b);
  let done = 0;
  const tick = () => onProgress?.(++done, pages.length);

  const misses: number[] = [];
  await mapLimit(pages, CACHE_FETCH_CONCURRENCY, async (pg) => {
    try {
      result.set(pg, await downloadFile(cacheKey(czBatchId, pg)));
      tick();
    } catch {
      misses.push(pg);
    }
  });
  misses.sort((a, b) => a - b);

  const chunks: number[][] = [];
  for (let i = 0; i < misses.length; i += GS_CHUNK_PAGES) chunks.push(misses.slice(i, i + GS_CHUNK_PAGES));

  // Enough chunks in flight to keep the decoder pool fed; withGsSlot caps real gs processes.
  await mapLimit(chunks, GS_CONCURRENCY + 1, async (chunk) => {
    const rasters = await withGsSlot(() => renderPdfPages(pdfBuffer, chunk, { density: RASTER_DENSITY, timeoutMs: 120_000 }));
    await Promise.all(chunk.map(async (pg) => {
      const raster = rasters.get(pg);
      if (!raster) throw new Error(`Ghostscript produced no image for page ${pg}`);
      result.set(pg, await buildCleanPng(czBatchId, pg, raster));
      tick();
    }));
  });

  return result;
}
