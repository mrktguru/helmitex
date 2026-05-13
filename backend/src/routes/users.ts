import { Router, Response } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('ADMIN'));

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'OPERATOR']).default('OPERATOR'),
});

const updateSchema = z.object({
  role: z.enum(['ADMIN', 'OPERATOR']).optional(),
});

// GET /api/users
router.get('/', async (_req: AuthRequest, res: Response) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(users);
});

// POST /api/users
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { email, password, role } = parsed.data;
  const passwordHash = await argon2.hash(password);
  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, role },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch {
    res.status(409).json({ error: 'Email already exists' });
  }
});

// PATCH /api/users/:id
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: parsed.data,
    select: { id: true, email: true, role: true, createdAt: true },
  });
  res.json(user);
});

// DELETE /api/users/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

export default router;
