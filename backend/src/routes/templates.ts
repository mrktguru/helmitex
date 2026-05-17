import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getProjectOrFail } from './projects';
import { uploadFile, downloadFile, getSignedUrl } from '../services/s3';

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
  variables: z.record(z.string()).optional().nullable(),
  variableDefs: z.array(z.object({
    token: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    name: z.string(),
  })).optional().nullable(),
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
  const { printMargins, variables, variableDefs, ...rest } = parsed.data;
  const data = {
    ...rest,
    ...(printMargins != null ? { printMargins } : {}),
    ...(variables != null ? { variables } : {}),
    ...(variableDefs != null ? { variableDefs } : {}),
  };
  const template = await prisma.labelTemplate.upsert({
    where: { projectId: req.params.id },
    update: data,
    create: { ...data, projectId: req.params.id },
  });
  res.json(template);
});

// GET /api/projects/:id/template/assets/serve?key=… — proxy image from S3
router.get('/:id/template/assets/serve', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const key = req.query.key as string;
  if (!key || !key.startsWith(`assets/${req.params.id}/`) || key.includes('..')) {
    res.status(400).json({ error: 'Invalid key' }); return;
  }
  try {
    const buf = await downloadFile(key);
    const ext = key.split('.').pop()?.toLowerCase() ?? 'bin';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
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
