import { Router, Response } from 'express';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

// Маркировка: SKU, которым нужен ЧЗ, — их база кодов (проект этикетки) и выпущенный без ЧЗ остаток
const router = Router();
router.use(authMiddleware);

const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function codeStats(projectIds: string[]) {
  const rows = await prisma.$queryRaw<{ projectId: string; status: string; hasText: boolean; n: bigint }[]>`
    SELECT b."projectId", c.status, (c.code IS NOT NULL) AS "hasText", COUNT(*) AS n
    FROM "CzCode" c JOIN "CzBatch" b ON b.id = c."czBatchId"
    WHERE b."projectId" = ANY(${projectIds}::text[])
    GROUP BY 1, 2, 3`;
  const out = new Map<string, { total: number; pending: number; used: number; spoiled: number; noText: number }>();
  for (const r of rows) {
    const s = out.get(r.projectId) ?? { total: 0, pending: 0, used: 0, spoiled: 0, noText: 0 };
    const n = Number(r.n);
    s.total += n;
    if (r.status === 'PENDING') s.pending += n;
    else if (r.status === 'USED') s.used += n;
    else s.spoiled += n;
    if (!r.hasText && r.status === 'PENDING') s.noText += n;
    out.set(r.projectId, s);
  }
  return out;
}

async function stockByState(itemIds: string[]) {
  const groups = await prisma.stockMove.groupBy({
    by: ['lotId', 'state'],
    where: { lot: { itemId: { in: itemIds } } },
    _sum: { qty: true },
  });
  const lots = await prisma.lot.findMany({ where: { id: { in: groups.map((g) => g.lotId) } }, select: { id: true, itemId: true } });
  const itemOf = new Map(lots.map((l) => [l.id, l.itemId]));
  const out = new Map<string, { unlabeled: number; labeled: number; inQuant: number }>();
  for (const g of groups) {
    const itemId = itemOf.get(g.lotId)!;
    const s = out.get(itemId) ?? { unlabeled: 0, labeled: 0, inQuant: 0 };
    const q = g._sum.qty ?? 0;
    if (g.state === 'UNLABELED') s.unlabeled += q;
    else if (g.state === 'LABELED') s.labeled += q;
    else if (g.state === 'IN_QUANT') s.inQuant += q;
    out.set(itemId, s);
  }
  for (const s of out.values()) { s.unlabeled = r3(s.unlabeled); s.labeled = r3(s.labeled); s.inQuant = r3(s.inQuant); }
  return out;
}

async function load(itemIds?: string[]) {
  const items = await prisma.item.findMany({
    where: { type: 'PRODUCT', archived: false, spec: { requiresCz: true }, ...(itemIds ? { id: { in: itemIds } } : {}) },
    orderBy: { name: 'asc' },
    include: { spec: { include: { czProject: { include: { template: { select: { widthMm: true, heightMm: true, czArea: true } } } } } } },
  });
  const projectIds = items.map((i) => i.spec?.czProjectId).filter((x): x is string => !!x);
  const [codes, stock] = await Promise.all([codeStats(projectIds), stockByState(items.map((i) => i.id))]);
  const empty = { total: 0, pending: 0, used: 0, spoiled: 0, noText: 0 };
  return items.map((i) => {
    const p = i.spec?.czProject ?? null;
    const c = (p && codes.get(p.id)) || empty;
    const s = stock.get(i.id) ?? { unlabeled: 0, labeled: 0, inQuant: 0 };
    return {
      id: i.id,
      name: i.name,
      project: p && {
        id: p.id, name: p.name,
        template: p.template && { widthMm: p.template.widthMm, heightMm: p.template.heightMm, hasCzArea: p.template.czArea != null },
      },
      codes: c,
      stock: s,
      // сколько кодов не хватает на выпущенный без ЧЗ товар
      shortage: Math.max(0, Math.ceil(s.unlabeled) - c.pending),
    };
  });
}

// GET /api/stock/marking — все SKU с обязательной маркировкой
router.get('/marking', async (_req: AuthRequest, res: Response) => {
  res.json(await load());
});

// GET /api/stock/marking/:itemId
router.get('/marking/:itemId', async (req: AuthRequest, res: Response): Promise<void> => {
  const [row] = await load([req.params.itemId]);
  if (!row) { res.status(404).json({ error: 'SKU не найден или для него не включена маркировка ЧЗ' }); return; }
  res.json(row);
});

// POST /api/stock/marking/:itemId/enable — включить ЧЗ для SKU: создаёт проект этикетки (или берёт указанный)
router.post('/marking/:itemId/enable', async (req: AuthRequest, res: Response): Promise<void> => {
  const item = await prisma.item.findUnique({ where: { id: req.params.itemId }, include: { spec: true } });
  if (item?.type !== 'PRODUCT') { res.status(400).json({ error: 'Маркировка включается только для готовой продукции' }); return; }
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : null;
  if (projectId && !(await prisma.project.findUnique({ where: { id: projectId } }))) {
    res.status(400).json({ error: 'Проект этикетки не найден' }); return;
  }
  await prisma.$transaction(async (tx) => {
    const pid = projectId ?? item.spec?.czProjectId
      ?? (await tx.project.create({ data: { name: item.name, userId: req.user!.id } })).id;
    await tx.productSpec.upsert({
      where: { itemId: item.id },
      create: { itemId: item.id, requiresCz: true, czProjectId: pid },
      update: { requiresCz: true, czProjectId: pid },
    });
    // как в PUT /specs: варианты квантов наследуют маркировку
    await tx.quantType.updateMany({ where: { productItemId: item.id }, data: { trackCz: true, projectId: pid } });
  });
  const [row] = await load([item.id]);
  res.json(row);
});

export default router;
