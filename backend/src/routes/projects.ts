import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

const createSchema = z.object({ name: z.string().min(1).max(100) });
const copySchema = z.object({ name: z.string().min(1).max(100) });

function projectFilter(req: AuthRequest) {
  return req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };
}

async function getProjectOrFail(id: string, req: AuthRequest, res: Response): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) { res.status(404).json({ error: 'Not found' }); return false; }
  if (req.user!.role !== 'ADMIN' && project.userId !== req.user!.id) {
    res.status(403).json({ error: 'Forbidden' }); return false;
  }
  return true;
}

// GET /api/projects
router.get('/', async (req: AuthRequest, res: Response) => {
  const projects = await prisma.project.findMany({
    where: projectFilter(req),
    orderBy: { createdAt: 'desc' },
    include: {
      template: { select: { widthMm: true, heightMm: true } },
      czBatches: {
        orderBy: { uploadedAt: 'desc' },
        take: 1,
        include: { codes: { select: { status: true } } },
      },
    },
  });
  res.json(projects);
});

// POST /api/projects
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const project = await prisma.project.create({
    data: { name: parsed.data.name, userId: req.user!.id },
  });
  res.status(201).json(project);
});

// GET /api/projects/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { template: true, czBatches: { include: { codes: { select: { status: true } } } } },
  });
  res.json(project);
});

// POST /api/projects/:id/copy
router.post('/:id/copy', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  const parsed = copySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const source = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { template: true },
  });
  if (!source) { res.status(404).json({ error: 'Not found' }); return; }

  const created = await prisma.$transaction(async (tx) => {
    const newProject = await tx.project.create({
      data: { name: parsed.data.name, userId: req.user!.id },
    });
    if (source.template) {
      await tx.labelTemplate.create({
        data: {
          projectId: newProject.id,
          widthMm: source.template.widthMm,
          heightMm: source.template.heightMm,
          elements: source.template.elements as any,
          czArea: source.template.czArea as any,
          barcodeValue: source.template.barcodeValue,
          printMargins: source.template.printMargins as any,
          variables: source.template.variables as any,
        },
      });
    }
    return newProject;
  });
  res.status(201).json(created);
});

// DELETE /api/projects/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await getProjectOrFail(req.params.id, req, res))) return;
  await prisma.project.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

export { getProjectOrFail };
export default router;
