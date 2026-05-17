import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getProjectOrFail } from './projects';
import { downloadFile, deleteFile } from '../services/s3';
import { pdfQueue } from '../workers/pdfQueue';

const router = Router();
router.use(authMiddleware);

const createBatchSchema = z.object({
  batchSize: z.number().int().min(1).max(2000),
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

// GET /api/projects/:id/batches?limit=10&offset=0
router.get('/projects/:id/batches', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
  const [items, total] = await Promise.all([
    prisma.outputBatch.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.outputBatch.count({ where: { projectId: req.params.id } }),
  ]);
  res.json({ items, total });
});

// DELETE /api/batches/:id  — rolls back USED codes → PENDING, removes PDF from S3
router.delete('/batches/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const batch = await prisma.outputBatch.findUnique({ where: { id: req.params.id } });
  if (!batch) { res.status(404).json({ error: 'Not found' }); return; }
  if (req.user!.role !== 'ADMIN') {
    const project = await prisma.project.findUnique({ where: { id: batch.projectId } });
    if (project?.userId !== req.user!.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  }
  const s3Key = batch.s3Key;
  await prisma.$transaction(async (tx) => {
    // Roll codes back to PENDING so they can be reused in a new batch
    await tx.czCode.updateMany({
      where: { outputBatchId: batch.id },
      data: { status: 'PENDING', usedAt: null, outputBatchId: null },
    });
    await tx.outputBatch.delete({ where: { id: batch.id } });
  });
  if (s3Key) {
    try { await deleteFile(s3Key); } catch (e) { console.warn('[batch delete] s3 cleanup failed:', e); }
  }
  res.json({ ok: true });
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
