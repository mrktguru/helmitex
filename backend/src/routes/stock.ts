import { Router, Response } from 'express';
import { z } from 'zod';
import { ItemType, Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { cancelDoc, nextDocNumber, postDoc, StockError } from '../services/stock';

const router = Router();
router.use(authMiddleware);

const itemTypes = ['RAW', 'CONTAINER', 'PACKAGING', 'LABEL', 'SEMI', 'PRODUCT'] as const;
const states = ['NONE', 'UNLABELED', 'LABELED'] as const;

const itemSchema = z.object({
  type: z.enum(itemTypes),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(10),
  minStock: z.number().nonnegative().nullable().optional(),
});
const itemPatchSchema = itemSchema.partial().extend({ archived: z.boolean().optional() });

const lineSchema = z.object({
  itemId: z.string().uuid(),
  lotId: z.string().uuid().nullable().optional(),
  qty: z.number().refine((v) => v !== 0, 'Количество не может быть нулём'),
  unitCost: z.number().nonnegative().nullable().optional(),
  supplierLot: z.string().max(100).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  barrel: z.string().max(50).nullable().optional(),
  state: z.enum(states).optional(),
  reason: z.string().max(300).nullable().optional(),
});
const docSchema = z.object({
  type: z.enum(['RECEIPT', 'OPENING', 'ADJUSTMENT']),
  date: z.string().optional(),
  supplier: z.string().max(200).nullable().optional(),
  docRef: z.string().max(200).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
  lines: z.array(lineSchema).max(500),
});

function lineData(l: z.infer<typeof lineSchema>) {
  return {
    itemId: l.itemId,
    lotId: l.lotId ?? null,
    qty: l.qty,
    unitCost: l.unitCost ?? null,
    supplierLot: l.supplierLot || null,
    expiresAt: l.expiresAt ? new Date(l.expiresAt) : null,
    barrel: l.barrel || null,
    state: l.state ?? 'NONE',
    reason: l.reason || null,
  };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof StockError) { res.status(400).json({ error: err.message }); return; }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({ error: 'Такая запись уже есть' }); return;
  }
  throw err;
}

// ───────────── Номенклатура ─────────────

// GET /api/stock/items?type=RAW&archived=1
router.get('/items', async (req: AuthRequest, res: Response) => {
  const type = itemTypes.includes(req.query.type as any) ? (req.query.type as ItemType) : undefined;
  const items = await prisma.item.findMany({
    where: { type, archived: req.query.archived === '1' ? undefined : false },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
  res.json(items);
});

// POST /api/stock/items
router.post('/items', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  try {
    res.status(201).json(await prisma.item.create({ data: parsed.data }));
  } catch (err) { sendError(res, err); }
});

// PATCH /api/stock/items/:id
router.patch('/items/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = itemPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  try {
    res.json(await prisma.item.update({ where: { id: req.params.id }, data: parsed.data }));
  } catch (err) { sendError(res, err); }
});

// ───────────── Остатки ─────────────

// GET /api/stock/balances?type=RAW&itemId=…&zero=1
router.get('/balances', async (req: AuthRequest, res: Response) => {
  const type = itemTypes.includes(req.query.type as any) ? (req.query.type as ItemType) : undefined;
  const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : undefined;
  const groups = await prisma.stockMove.groupBy({
    by: ['lotId', 'state'],
    where: { lot: { itemId, item: { type } } },
    _sum: { qty: true },
  });
  const rows = groups
    .map((g) => ({ lotId: g.lotId, state: g.state, qty: Math.round((g._sum.qty ?? 0) * 1e6) / 1e6 }))
    .filter((g) => req.query.zero === '1' || Math.abs(g.qty) > 1e-6);
  const lots = await prisma.lot.findMany({
    where: { id: { in: rows.map((r) => r.lotId) } },
    include: { item: true },
  });
  const byId = new Map(lots.map((l) => [l.id, l]));
  res.json(
    rows
      .map((r) => ({ ...r, lot: byId.get(r.lotId)! }))
      .sort((a, b) =>
        a.lot.item.name.localeCompare(b.lot.item.name, 'ru') ||
        (a.lot.expiresAt?.getTime() ?? Infinity) - (b.lot.expiresAt?.getTime() ?? Infinity) ||
        a.lot.number.localeCompare(b.lot.number)),
  );
});

// GET /api/stock/moves?lotId=…&limit=200
router.get('/moves', async (req: AuthRequest, res: Response) => {
  const lotId = typeof req.query.lotId === 'string' ? req.query.lotId : undefined;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const moves = await prisma.stockMove.findMany({
    where: { lotId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      lot: { include: { item: true } },
      doc: { select: { id: true, number: true, type: true, status: true, user: { select: { email: true } } } },
    },
  });
  res.json(moves);
});

// ───────────── Документы ─────────────

// GET /api/stock/docs?type=RECEIPT
router.get('/docs', async (req: AuthRequest, res: Response) => {
  const type = ['RECEIPT', 'OPENING', 'ADJUSTMENT'].includes(req.query.type as string)
    ? (req.query.type as 'RECEIPT') : undefined;
  const docs = await prisma.stockDoc.findMany({
    where: { type },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      user: { select: { email: true } },
      lines: { select: { qty: true, unitCost: true } },
    },
  });
  res.json(docs.map(({ lines, ...d }) => ({
    ...d,
    lineCount: lines.length,
    total: lines.some((l) => l.unitCost != null)
      ? lines.reduce((s, l) => s + (l.unitCost ?? 0) * l.qty, 0) : null,
  })));
});

// GET /api/stock/docs/:id
router.get('/docs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const doc = await prisma.stockDoc.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { email: true } },
      lines: { include: { item: true }, orderBy: { id: 'asc' } },
    },
  });
  if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
  const lotIds = doc.lines.map((l) => l.lotId).filter((x): x is string => !!x);
  const lots = await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, number: true } });
  const num = new Map(lots.map((l) => [l.id, l.number]));
  res.json({ ...doc, lines: doc.lines.map((l) => ({ ...l, lotNumber: l.lotId ? num.get(l.lotId) ?? null : null })) });
});

// POST /api/stock/docs — создаёт черновик; ?post=1 сразу проводит
router.post('/docs', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = docSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { lines, date, ...head } = parsed.data;
  try {
    const doc = await prisma.$transaction(async (tx) => {
      const created = await tx.stockDoc.create({
        data: {
          ...head,
          number: await nextDocNumber(tx, head.type),
          date: date ? new Date(date) : new Date(),
          userId: req.user!.id,
          lines: { create: lines.map(lineData) },
        },
      });
      if (req.query.post === '1') await postDoc(tx, created.id);
      return created;
    }, { isolationLevel: 'Serializable' });
    res.status(201).json(doc);
  } catch (err) { sendError(res, err); }
});

// PUT /api/stock/docs/:id — правка черновика (строки заменяются целиком)
router.put('/docs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = docSchema.omit({ type: true }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { lines, date, ...head } = parsed.data;
  try {
    const doc = await prisma.$transaction(async (tx) => {
      const existing = await tx.stockDoc.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new StockError('Документ не найден');
      if (existing.status !== 'DRAFT') throw new StockError('Изменить можно только черновик');
      await tx.stockDocLine.deleteMany({ where: { docId: existing.id } });
      return tx.stockDoc.update({
        where: { id: existing.id },
        data: {
          ...head,
          date: date ? new Date(date) : undefined,
          lines: { create: lines.map(lineData) },
        },
      });
    });
    res.json(doc);
  } catch (err) { sendError(res, err); }
});

// POST /api/stock/docs/:id/post
router.post('/docs/:id/post', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.$transaction((tx) => postDoc(tx, req.params.id), { isolationLevel: 'Serializable' });
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// POST /api/stock/docs/:id/cancel
router.post('/docs/:id/cancel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.$transaction((tx) => cancelDoc(tx, req.params.id), { isolationLevel: 'Serializable' });
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// DELETE /api/stock/docs/:id — только черновик
router.delete('/docs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const doc = await prisma.stockDoc.findUnique({ where: { id: req.params.id } });
  if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
  if (doc.status !== 'DRAFT') { res.status(400).json({ error: 'Удалить можно только черновик' }); return; }
  await prisma.stockDoc.delete({ where: { id: doc.id } });
  res.json({ ok: true });
});

export default router;
