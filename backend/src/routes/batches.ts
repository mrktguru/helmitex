import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getProjectOrFail } from './projects';
import { downloadFile } from '../services/s3';
import { pdfQueue } from '../workers/pdfQueue';

const router = Router();
router.use(authMiddleware);

const createBatchSchema = z.object({
  batchSize: z.union([z.literal(50), z.literal(100)]),
});

// POST /api/projects/:id/batches
router.post('/projects/:id/batches', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { batchSize } = parsed.data;

  // Get pending codes (lock to prevent two concurrent batch creations from claiming the same codes).
  // CzCode has no projectId column directly — join via CzBatch.
  const codes = await prisma.$queryRaw<{ id: string; pageIndex: number; czBatchId: string }[]>`
    SELECT c.id, c."pageIndex", c."czBatchId"
    FROM "CzCode" c
    JOIN "CzBatch" b ON b.id = c."czBatchId"
    WHERE b."projectId" = ${req.params.id}
      AND c.status = 'PENDING'
    ORDER BY b."uploadedAt" ASC, c."pageIndex" ASC
    LIMIT ${batchSize}
    FOR UPDATE OF c SKIP LOCKED
  `;

  if (codes.length === 0) {
    res.status(422).json({ error: 'No pending codes available' });
    return;
  }

  // Create output batch and mark codes as USED in one transaction
  const firstCode = codes[0];
  const lastCode = codes[codes.length - 1];

  const outputBatch = await prisma.$transaction(async (tx) => {
    const batch = await tx.outputBatch.create({
      data: {
        projectId: req.params.id,
        fromIndex: firstCode.pageIndex,
        toIndex: lastCode.pageIndex,
        count: codes.length,
      },
    });
    await tx.czCode.updateMany({
      where: { id: { in: codes.map((c) => c.id) } },
      data: { status: 'USED', usedAt: new Date(), outputBatchId: batch.id },
    });
    return batch;
  });

  const job = await pdfQueue.add('generate-pdf', {
    outputBatchId: outputBatch.id,
    projectId: req.params.id,
    codeIds: codes.map((c) => c.id),
  });

  res.status(201).json({ outputBatchId: outputBatch.id, jobId: job.id });
});

// GET /api/projects/:id/batches
router.get('/projects/:id/batches', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const batches = await prisma.outputBatch.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(batches);
});

// GET /api/batches/:id/status
router.get('/batches/:id/status', async (req: AuthRequest, res: Response): Promise<void> => {
  const batch = await prisma.outputBatch.findUnique({ where: { id: req.params.id } });
  if (!batch) { res.status(404).json({ error: 'Not found' }); return; }
  if (req.user!.role !== 'ADMIN') {
    const project = await prisma.project.findUnique({ where: { id: batch.projectId } });
    if (project?.userId !== req.user!.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  }

  let downloadUrl: string | undefined;
  if (batch.jobStatus === 'done' && batch.s3Key) {
    downloadUrl = `/api/batches/${batch.id}/download`;
  }
  res.json({ status: batch.jobStatus, downloadUrl });
});

// GET /api/batches/:id/download  — streams the PDF through the API (no signed S3 URLs)
router.get('/batches/:id/download', async (req: AuthRequest, res: Response): Promise<void> => {
  const batch = await prisma.outputBatch.findUnique({ where: { id: req.params.id } });
  if (!batch || batch.jobStatus !== 'done' || !batch.s3Key) { res.status(404).json({ error: 'Not ready' }); return; }
  if (req.user!.role !== 'ADMIN') {
    const project = await prisma.project.findUnique({ where: { id: batch.projectId } });
    if (project?.userId !== req.user!.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  }
  try {
    const buf = await downloadFile(batch.s3Key);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.fromIndex}-${batch.toIndex}.pdf"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  } catch (err: any) {
    console.error('[batch download] failed:', err?.message ?? err);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
