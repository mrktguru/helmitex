import { Router, Response } from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getProjectOrFail } from './projects';
import { uploadFile } from '../services/s3';

const router = Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === 'application/pdf');
  },
});

// Separate uploader for CSV — accepts text/csv, application/vnd.ms-excel (Excel-exported CSV), or text/plain.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'text/csv'
      || file.mimetype === 'application/vnd.ms-excel'
      || file.mimetype === 'text/plain'
      || /\.csv$/i.test(file.originalname);
    cb(null, ok);
  },
});

const uploadBodySchema = z.object({
  totalCount: z.coerce.number().int().positive().optional(),
});

// POST /api/projects/:id/cz
router.post('/:id/cz', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  if (!req.file) { res.status(400).json({ error: 'PDF file required' }); return; }

  const parsed = uploadBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // Count pages
  let pageCount: number;
  try {
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    pageCount = pdfDoc.getPageCount();
  } catch {
    res.status(400).json({ error: 'Invalid PDF file' });
    return;
  }

  const totalCount = parsed.data.totalCount ?? pageCount;

  // Deduplicate by file hash within the project
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const existing = await prisma.czBatch.findFirst({
    where: { projectId: req.params.id, fileHash },
  });
  if (existing) {
    res.status(409).json({
      error: 'duplicate',
      message: 'Этот PDF уже был загружен ранее',
      czBatchId: existing.id,
      uploadedAt: existing.uploadedAt,
    });
    return;
  }

  const s3Key = `cz/${req.params.id}/${Date.now()}.pdf`;
  await uploadFile(s3Key, req.file.buffer, 'application/pdf');

  const czBatch = await prisma.czBatch.create({
    data: {
      projectId: req.params.id,
      s3Key,
      totalCount,
      fileHash,
      codes: {
        createMany: {
          data: Array.from({ length: pageCount }, (_, i) => ({ pageIndex: i + 1 })),
        },
      },
    },
  });

  // Generate inline base64 previews for first 3 pages — decode + re-encode
  // pipeline produces a perfectly clean square DataMatrix per page.
  const previews: string[] = [];
  const previewErrors: string[] = [];
  for (let i = 1; i <= Math.min(3, pageCount); i++) {
    try {
      const { getCleanCzPng } = await import('../services/czRender');
      const pngBuffer = await getCleanCzPng(czBatch.id, i, req.file.buffer);
      previews.push(`data:image/png;base64,${pngBuffer.toString('base64')}`);
    } catch (err: any) {
      console.error(`[cz preview] batch=${czBatch.id} page=${i} failed:`, err?.message ?? err);
      previewErrors.push(`page ${i}: ${err?.message ?? 'unknown'}`);
    }
  }

  res.status(201).json({ czBatchId: czBatch.id, totalCount, pageCount, previews, previewErrors });
});

// POST /api/projects/:id/cz/csv
// Accepts a CSV/TXT file with one CZ code per line (or first column of each line).
// Codes are stored on CzCode.code directly; no PDF is uploaded — at export time
// the worker re-encodes a clean DataMatrix from the stored text.
router.post('/:id/cz/csv', uploadCsv.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  if (!req.file) { res.status(400).json({ error: 'CSV file required' }); return; }

  // Parse: split on CR/LF, drop empty lines, take first comma/semicolon/tab field, trim quotes.
  const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const codes: string[] = [];
  for (const line of lines) {
    const first = line.split(/[,;\t]/)[0].trim().replace(/^"|"$/g, '');
    if (first && first.toLowerCase() !== 'code' && first.toLowerCase() !== 'код') codes.push(first);
  }
  if (codes.length === 0) {
    res.status(400).json({ error: 'CSV is empty or has no valid codes' });
    return;
  }

  // Deduplicate within the file (preserve first occurrence)
  const seen = new Set<string>();
  const uniqueCodes = codes.filter((c) => seen.has(c) ? false : (seen.add(c), true));

  // Deduplicate at the project level: skip codes already present in any other batch
  const existing = await prisma.czCode.findMany({
    where: { czBatch: { projectId: req.params.id }, code: { in: uniqueCodes } },
    select: { code: true },
  });
  const existingSet = new Set(existing.map((e) => e.code).filter(Boolean) as string[]);
  const newCodes = uniqueCodes.filter((c) => !existingSet.has(c));

  if (newCodes.length === 0) {
    res.status(409).json({
      error: 'duplicate',
      message: 'Все коды из этого CSV уже загружены',
      duplicates: uniqueCodes.length,
    });
    return;
  }

  const fileHash = crypto.createHash('sha256').update(newCodes.join('\n')).digest('hex');
  const czBatch = await prisma.czBatch.create({
    data: {
      projectId: req.params.id,
      s3Key: `csv:${fileHash}`,
      totalCount: newCodes.length,
      fileHash,
      codes: {
        createMany: {
          data: newCodes.map((code, i) => ({ pageIndex: i + 1, code })),
        },
      },
    },
  });

  // Generate inline previews for first 3 codes — quick, in-memory.
  const previews: string[] = [];
  const previewErrors: string[] = [];
  try {
    const { encodeDataMatrix } = await import('../services/datamatrix');
    for (let i = 0; i < Math.min(3, newCodes.length); i++) {
      try {
        const png = await encodeDataMatrix(newCodes[i], 10);
        previews.push(`data:image/png;base64,${png.toString('base64')}`);
      } catch (err: any) {
        previewErrors.push(`code ${i + 1}: ${err?.message ?? 'unknown'}`);
      }
    }
  } catch (err: any) {
    previewErrors.push(`encoder unavailable: ${err?.message ?? err}`);
  }

  res.status(201).json({
    czBatchId: czBatch.id,
    totalCount: newCodes.length,
    pageCount: newCodes.length,
    previews,
    previewErrors,
    skippedDuplicates: uniqueCodes.length - newCodes.length,
  });
});

// POST /api/projects/:id/cz/:czBatchId/regenerate-previews
router.post('/:id/cz/:czBatchId/regenerate-previews', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const czBatch = await prisma.czBatch.findUnique({ where: { id: req.params.czBatchId } });
  if (!czBatch || czBatch.projectId !== req.params.id) { res.status(404).json({ error: 'Not found' }); return; }

  const { downloadFile } = await import('../services/s3');
  const { getCleanCzPng } = await import('../services/czRender');
  const { encodeDataMatrix } = await import('../services/datamatrix');

  const previews: string[] = [];
  const previewErrors: string[] = [];

  // CSV-sourced batches: re-encode directly from CzCode.code
  if (czBatch.s3Key.startsWith('csv:') || !czBatch.s3Key) {
    const csvCodes = await prisma.czCode.findMany({
      where: { czBatchId: czBatch.id },
      orderBy: { pageIndex: 'asc' },
      take: 3,
    });
    for (const c of csvCodes) {
      try {
        if (!c.code) throw new Error('missing code text');
        const png = await encodeDataMatrix(c.code, 10);
        previews.push(`data:image/png;base64,${png.toString('base64')}`);
      } catch (err: any) {
        previewErrors.push(`code ${c.pageIndex}: ${err?.message ?? 'unknown'}`);
      }
    }
    res.json({ previews, previewErrors });
    return;
  }

  let pdfBuffer: Buffer;
  try { pdfBuffer = await downloadFile(czBatch.s3Key); }
  catch (err: any) { res.status(500).json({ error: `download failed: ${err?.message}` }); return; }

  let pageCount = 0;
  try { pageCount = (await PDFDocument.load(pdfBuffer)).getPageCount(); }
  catch { res.status(500).json({ error: 'Cached PDF unreadable' }); return; }

  for (let i = 1; i <= Math.min(3, pageCount); i++) {
    try {
      const pngBuffer = await getCleanCzPng(czBatch.id, i, pdfBuffer);
      previews.push(`data:image/png;base64,${pngBuffer.toString('base64')}`);
    } catch (err: any) {
      console.error(`[cz preview regen] batch=${czBatch.id} page=${i} failed:`, err?.message ?? err);
      previewErrors.push(`page ${i}: ${err?.message ?? 'unknown'}`);
    }
  }
  res.json({ previews, previewErrors });
});

// GET /api/projects/:id/cz/batches
router.get('/:id/cz/batches', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const batches = await prisma.czBatch.findMany({
    where: { projectId: req.params.id },
    orderBy: { uploadedAt: 'desc' },
    include: { _count: { select: { codes: true } } },
  });
  const enriched = await Promise.all(batches.map(async (b) => {
    const used = await prisma.czCode.count({ where: { czBatchId: b.id, status: 'USED' } });
    return {
      id: b.id,
      uploadedAt: b.uploadedAt,
      totalCount: b.totalCount,
      pageCount: b._count.codes,
      used,
    };
  }));
  res.json(enriched);
});

// DELETE /api/projects/:id/cz/:czBatchId?force=1
router.delete('/:id/cz/:czBatchId', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const force = req.query.force === '1' || req.query.force === 'true';
  const czBatch = await prisma.czBatch.findUnique({
    where: { id: req.params.czBatchId },
    include: { _count: { select: { codes: { where: { status: 'USED' } } } } },
  });
  if (!czBatch || czBatch.projectId !== req.params.id) { res.status(404).json({ error: 'Not found' }); return; }
  if (czBatch._count.codes > 0 && !force) {
    res.status(409).json({
      error: 'in_use',
      message: 'В партии есть использованные коды. Передайте force=1 для принудительного удаления.',
      usedCount: czBatch._count.codes,
    });
    return;
  }
  await prisma.czCode.deleteMany({ where: { czBatchId: czBatch.id } });
  await prisma.czBatch.delete({ where: { id: czBatch.id } });
  res.json({ ok: true, forced: force && czBatch._count.codes > 0 });
});

// GET /api/projects/:id/cz/stats
router.get('/:id/cz/stats', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const batches = await prisma.czBatch.findMany({ where: { projectId: req.params.id } });
  const batchIds = batches.map((b) => b.id);
  const [total, used] = await Promise.all([
    prisma.czCode.count({ where: { czBatchId: { in: batchIds } } }),
    prisma.czCode.count({ where: { czBatchId: { in: batchIds }, status: 'USED' } }),
  ]);
  res.json({ total, used, pending: total - used });
});

export default router;
