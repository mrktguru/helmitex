import { Router, Response } from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getProjectOrFail } from './projects';
import { uploadFile, getSignedUrl } from '../services/s3';

const router = Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === 'application/pdf');
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
  const s3Key = `cz/${req.params.id}/${Date.now()}.pdf`;
  await uploadFile(s3Key, req.file.buffer, 'application/pdf');

  const czBatch = await prisma.czBatch.create({
    data: {
      projectId: req.params.id,
      s3Key,
      totalCount,
      codes: {
        createMany: {
          data: Array.from({ length: pageCount }, (_, i) => ({ pageIndex: i + 1 })),
        },
      },
    },
  });

  // Generate preview URLs for first 3 pages
  const previewUrls: string[] = [];
  for (let i = 1; i <= Math.min(3, pageCount); i++) {
    const previewKey = `previews/${czBatch.id}/page-${i}.png`;
    try {
      const { convertPdfPageToPng } = await import('../services/pdf');
      const pngBuffer = await convertPdfPageToPng(req.file.buffer, i);
      await uploadFile(previewKey, pngBuffer, 'image/png');
      previewUrls.push(await getSignedUrl(previewKey, 3600));
    } catch {
      // preview generation is best-effort
    }
  }

  res.status(201).json({ czBatchId: czBatch.id, totalCount, pageCount, previewUrls });
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
