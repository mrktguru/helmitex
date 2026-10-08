import { Router, Response } from 'express';
import { z } from 'zod';
import { ItemType, Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { allocateFefo, cancelDoc, lotBalance, nextDocNumber, postDoc, PdfJob, StockError } from '../services/stock';
import { enqueuePdfJobs } from './quants';

const router = Router();
router.use(authMiddleware);

const itemTypes = ['RAW', 'CONTAINER', 'PACKAGING', 'LABEL', 'SEMI', 'PRODUCT'] as const;
const states = ['NONE', 'UNLABELED', 'LABELED'] as const;

const itemSchema = z.object({
  type: z.enum(itemTypes),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(10),
  minStock: z.number().nonnegative().nullable().optional(),
  noStock: z.boolean().optional(),
});
const itemPatchSchema = itemSchema.partial().extend({ archived: z.boolean().optional() });

const lineSchema = z.object({
  itemId: z.string().uuid(),
  lotId: z.string().uuid().nullable().optional(),
  qty: z.number(),
  unitCost: z.number().nonnegative().nullable().optional(),
  supplierLot: z.string().max(100).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  barrel: z.string().max(50).nullable().optional(),
  state: z.enum(states).optional(),
  reason: z.string().max(300).nullable().optional(),
  planQty: z.number().nonnegative().nullable().optional(),
  stage: z.number().int().nullable().optional(),
});
const docTypes = ['RECEIPT', 'OPENING', 'ADJUSTMENT', 'MIX', 'FILL', 'QUANT'] as const;
const docSchema = z.object({
  type: z.enum(docTypes),
  date: z.string().optional(),
  supplier: z.string().max(200).nullable().optional(),
  docRef: z.string().max(200).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
  outputItemId: z.string().uuid().nullable().optional(),
  plannedQty: z.number().positive().nullable().optional(),
  yieldQty: z.number().nonnegative().nullable().optional(),
  barrel: z.string().max(50).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  sourceLotId: z.string().uuid().nullable().optional(),
  remainQty: z.number().nonnegative().nullable().optional(),
  lines: z.array(lineSchema).max(500),
});

function headData<T extends { expiresAt?: string | null }>(h: T) {
  return { ...h, expiresAt: h.expiresAt ? new Date(h.expiresAt) : h.expiresAt === undefined ? undefined : null };
}

function lineData(l: z.infer<typeof lineSchema>, sort: number) {
  return {
    sort,
    itemId: l.itemId,
    lotId: l.lotId ?? null,
    qty: l.qty,
    unitCost: l.unitCost ?? null,
    supplierLot: l.supplierLot || null,
    expiresAt: l.expiresAt ? new Date(l.expiresAt) : null,
    barrel: l.barrel || null,
    state: l.state ?? 'NONE',
    reason: l.reason || null,
    planQty: l.planQty ?? null,
    stage: l.stage ?? null,
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

// ───────────── Рецептуры ─────────────

const recipeSchema = z.object({
  stages: z.record(z.string().max(300)).nullable().optional(),
  qc: z.string().max(2000).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    percent: z.number().positive().max(100),
    stage: z.number().int().min(1).max(99),
  })).min(1).max(100),
});

// GET /api/stock/recipes — все полуфабрикаты с рецептурами (если есть)
router.get('/recipes', async (_req: AuthRequest, res: Response) => {
  const items = await prisma.item.findMany({
    where: { type: 'SEMI', archived: false },
    orderBy: { name: 'asc' },
    include: { recipe: { include: { lines: { include: { item: true }, orderBy: [{ stage: 'asc' }, { sort: 'asc' }] } } } },
  });
  res.json(items);
});

// PUT /api/stock/recipes/:itemId
router.put('/recipes/:itemId', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = recipeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const item = await prisma.item.findUnique({ where: { id: req.params.itemId } });
  if (item?.type !== 'SEMI') { res.status(400).json({ error: 'Рецептура задаётся только для полуфабриката' }); return; }
  const { lines, stages, ...rest } = parsed.data;
  const recipe = await prisma.$transaction(async (tx) => {
    const data = { ...rest, stages: stages ?? Prisma.JsonNull };
    const r = await tx.recipe.upsert({
      where: { itemId: item.id },
      create: { itemId: item.id, ...data },
      update: data,
    });
    await tx.recipeLine.deleteMany({ where: { recipeId: r.id } });
    await tx.recipeLine.createMany({ data: lines.map((l, i) => ({ ...l, recipeId: r.id, sort: i })) });
    return r;
  });
  res.json(recipe);
});

// GET /api/stock/mix/plan?itemId=…&qty=400 — нормы по рецептуре и лоты по FEFO
router.get('/mix/plan', async (req: AuthRequest, res: Response): Promise<void> => {
  const qty = Number(req.query.qty);
  if (!(qty > 0)) { res.status(400).json({ error: 'Укажите массу замеса' }); return; }
  const recipe = await prisma.recipe.findUnique({
    where: { itemId: String(req.query.itemId) },
    include: { lines: { include: { item: true }, orderBy: [{ stage: 'asc' }, { sort: 'asc' }] } },
  });
  if (!recipe || recipe.lines.length === 0) { res.status(400).json({ error: 'Для полуфабриката нет рецептуры' }); return; }
  const lines = [];
  for (const l of recipe.lines) {
    const need = Math.round(qty * l.percent) / 100;
    const alloc = l.item.noStock
      ? { allocations: [{ lotId: null, lotNumber: null, qty: need }], shortage: 0 }
      : await allocateFefo(prisma, l.itemId, need);
    lines.push({ item: l.item, stage: l.stage, percent: l.percent, need, ...alloc });
  }
  res.json({ stages: recipe.stages, qc: recipe.qc, lines });
});

// ───────────── Карточки SKU ─────────────

const specSchema = z.object({
  semiItemId: z.string().uuid().nullable(),
  netQty: z.number().positive().nullable(),
  materials: z.array(z.object({ itemId: z.string().uuid(), qtyPerUnit: z.number().positive() })).max(30),
});

// GET /api/stock/specs — все SKU с карточками
router.get('/specs', async (_req: AuthRequest, res: Response) => {
  const items = await prisma.item.findMany({
    where: { type: 'PRODUCT', archived: false },
    orderBy: { name: 'asc' },
    include: { spec: { include: { semiItem: true, materials: { include: { item: true }, orderBy: { sort: 'asc' } } } } },
  });
  res.json(items);
});

// PUT /api/stock/specs/:itemId
router.put('/specs/:itemId', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = specSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const item = await prisma.item.findUnique({ where: { id: req.params.itemId } });
  if (item?.type !== 'PRODUCT') { res.status(400).json({ error: 'Карточка задаётся только для готовой продукции' }); return; }
  const { materials, ...data } = parsed.data;
  const spec = await prisma.$transaction(async (tx) => {
    const sp = await tx.productSpec.upsert({ where: { itemId: item.id }, create: { itemId: item.id, ...data }, update: data });
    await tx.productMaterial.deleteMany({ where: { specId: sp.id } });
    await tx.productMaterial.createMany({ data: materials.map((m, i) => ({ ...m, specId: sp.id, sort: i })) });
    return sp;
  });
  res.json(spec);
});

// ───────────── Фасовка ─────────────

// GET /api/stock/barrels — бочки с остатком
router.get('/barrels', async (_req: AuthRequest, res: Response) => {
  const groups = await prisma.stockMove.groupBy({
    by: ['lotId'], where: { lot: { item: { type: 'SEMI' } } }, _sum: { qty: true },
  });
  const live = groups.filter((g) => (g._sum.qty ?? 0) > 1e-6);
  const lots = await prisma.lot.findMany({ where: { id: { in: live.map((g) => g.lotId) } }, include: { item: true }, orderBy: { createdAt: 'asc' } });
  const qty = new Map(live.map((g) => [g.lotId, g._sum.qty ?? 0]));
  res.json(lots.map((l) => ({ ...l, qty: Math.round(qty.get(l.id)! * 1e6) / 1e6 })));
});

const fillPlanSchema = z.object({
  sourceLotId: z.string().uuid(),
  outputs: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().nonnegative() })).max(50),
});

// POST /api/stock/fill/plan — расход полуфабриката и материалов, лоты материалов по FEFO
router.post('/fill/plan', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = fillPlanSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const barrel = await prisma.lot.findUnique({ where: { id: parsed.data.sourceLotId }, include: { item: true } });
  if (!barrel) { res.status(404).json({ error: 'Бочка не найдена' }); return; }
  const balance = await lotBalance(prisma, barrel.id, 'NONE');
  const specs = await prisma.productSpec.findMany({
    where: { itemId: { in: parsed.data.outputs.map((o) => o.itemId) } },
    include: { item: true, materials: { include: { item: true }, orderBy: { sort: 'asc' } } },
  });
  const specOf = new Map(specs.map((sp) => [sp.itemId, sp]));
  const errors: string[] = [];
  const need = new Map<string, { item: any; qty: number }>();
  let usedKg = 0;
  for (const o of parsed.data.outputs) {
    const sp = specOf.get(o.itemId);
    if (!sp?.netQty) { errors.push('Не заполнена карточка SKU (нетто)'); continue; }
    if (sp.semiItemId && sp.semiItemId !== barrel.itemId) errors.push(`«${sp.item.name}» фасуется не из «${barrel.item.name}»`);
    usedKg += o.qty * sp.netQty;
    for (const m of sp.materials) {
      const n = need.get(m.itemId) ?? { item: m.item, qty: 0 };
      n.qty += o.qty * m.qtyPerUnit;
      need.set(m.itemId, n);
    }
  }
  const materials = [];
  for (const [itemId, n] of need) {
    const qty = Math.round(n.qty * 1e6) / 1e6;
    materials.push({ item: n.item, need: qty, ...(await allocateFefo(prisma, itemId, qty)) });
  }
  if (usedKg > balance + 1e-6) errors.push(`В бочке ${Math.round(balance * 1000) / 1000} кг, нужно ${Math.round(usedKg * 1000) / 1000} кг`);
  res.json({ balance, usedKg: Math.round(usedKg * 1e6) / 1e6, materials, errors });
});

// ───────────── Документы ─────────────

// GET /api/stock/docs?type=RECEIPT
router.get('/docs', async (req: AuthRequest, res: Response) => {
  const type = docTypes.includes(req.query.type as any) ? (req.query.type as (typeof docTypes)[number]) : undefined;
  const docs = await prisma.stockDoc.findMany({
    where: { type },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      user: { select: { email: true } },
      outputItem: { select: { name: true } },
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
      outputItem: true,
      lines: { include: { item: true }, orderBy: { sort: 'asc' } },
    },
  });
  if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
  const lotIds = [...doc.lines.map((l) => l.lotId), doc.outputLotId, doc.sourceLotId].filter((x): x is string => !!x);
  const lots = await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, number: true } });
  const num = new Map(lots.map((l) => [l.id, l.number]));
  res.json({
    ...doc,
    outputLotNumber: doc.outputLotId ? num.get(doc.outputLotId) ?? null : null,
    sourceLotNumber: doc.sourceLotId ? num.get(doc.sourceLotId) ?? null : null,
    lines: doc.lines.map((l) => ({ ...l, lotNumber: l.lotId ? num.get(l.lotId) ?? null : null })),
  });
});

// POST /api/stock/docs — создаёт черновик; ?post=1 сразу проводит
router.post('/docs', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = docSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { lines, date, ...head } = parsed.data;
  try {
    let jobs: PdfJob[] = [];
    const doc = await prisma.$transaction(async (tx) => {
      const created = await tx.stockDoc.create({
        data: {
          ...headData(head),
          number: await nextDocNumber(tx, head.type),
          date: date ? new Date(date) : new Date(),
          userId: req.user!.id,
          lines: { create: lines.map((l, i) => lineData(l, i)) },
        },
      });
      if (req.query.post === '1') jobs = await postDoc(tx, created.id);
      return created;
    }, { isolationLevel: 'Serializable' });
    await enqueuePdfJobs(jobs);
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
          ...headData(head),
          date: date ? new Date(date) : undefined,
          lines: { create: lines.map((l, i) => lineData(l, i)) },
        },
      });
    });
    res.json(doc);
  } catch (err) { sendError(res, err); }
});

// POST /api/stock/docs/:id/post
router.post('/docs/:id/post', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const jobs = await prisma.$transaction((tx) => postDoc(tx, req.params.id), { isolationLevel: 'Serializable' });
    await enqueuePdfJobs(jobs);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// POST /api/stock/docs/:id/cancel
router.post('/docs/:id/cancel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const releaseCodes = req.body?.releaseCodes === true;
    await prisma.$transaction((tx) => cancelDoc(tx, req.params.id, { releaseCodes }), { isolationLevel: 'Serializable' });
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
