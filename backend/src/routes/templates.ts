import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getProjectOrFail } from './projects';
import { uploadFile, getSignedUrl } from '../services/s3';

const router = Router();
router.use(authMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const templateSchema = z.object({
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  elements: z.array(z.any()),
  czArea: z.object({
    xMm: z.number(),
    yMm: z.number(),
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
  }),
  barcodeValue: z.string().optional().nullable(),
  printMargins: z.object({
    topMm: z.number(), rightMm: z.number(), bottomMm: z.number(), leftMm: z.number(),
  }).optional().nullable(),
});

// GET /api/projects/:id/template
router.get('/:id/template', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const template = await prisma.labelTemplate.findUnique({ where: { projectId: req.params.id } });
  if (!template) { res.status(404).json({ error: 'No template yet' }); return; }
  res.json(template);
});

// PUT /api/projects/:id/template
router.put('/:id/template', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const template = await prisma.labelTemplate.upsert({
    where: { projectId: req.params.id },
    update: parsed.data,
    create: { ...parsed.data, projectId: req.params.id },
  });
  res.json(template);
});

// POST /api/projects/:id/template/assets (upload logo/image)
router.post('/:id/template/assets', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
  const ext = req.file.originalname.split('.').pop()?.toLowerCase() ?? 'bin';
  const allowedExts = ['png', 'jpg', 'jpeg', 'webp'];
  if (!allowedExts.includes(ext)) { res.status(400).json({ error: 'Only PNG/JPEG images allowed' }); return; }
  const s3Key = `assets/${req.params.id}/${Date.now()}.${ext}`;
  await uploadFile(s3Key, req.file.buffer, req.file.mimetype);
  const s3Url = await getSignedUrl(s3Key, 3600);
  res.json({ s3Key, s3Url });
});

export default router;
