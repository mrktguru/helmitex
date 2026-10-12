import { Router, Response } from 'express';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { StockError } from '../services/stock';
import { lotLabelVars, markLot } from '../services/marking';
import { pdfQueue } from '../workers/pdfQueue';
import multer from 'multer';
import { assignUnassigned, distribute, gtinTargets } from '../services/czImport';
import { uploadFile } from '../services/s3';
import { unescapeGs } from './cz';
import { kiXlsx } from '../services/wbPdf';

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
  const [codes, stock, targets] = await Promise.all([codeStats(projectIds), stockByState(items.map((i) => i.id)), gtinTargets()]);
  const gtinOfItem = new Map<string, { gtin: string; source: string }>();
  for (const [gtin, t] of targets) if (!gtinOfItem.has(t.itemId)) gtinOfItem.set(t.itemId, { gtin, source: t.source });
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
      gtin: gtinOfItem.get(i.id) ?? null,
      // сколько кодов не хватает на выпущенный без ЧЗ товар
      shortage: Math.max(0, Math.ceil(s.unlabeled) - c.pending),
    };
  });
}

// GET /api/stock/marking — все SKU с обязательной маркировкой
router.get('/marking', async (_req: AuthRequest, res: Response) => {
  res.json(await load());
});

// GET /api/stock/marking/queue — партии ГП «без ЧЗ» у SKU с маркировкой: что ждёт печати
router.get('/marking/queue', async (_req: AuthRequest, res: Response) => {
  const groups = await prisma.stockMove.groupBy({
    by: ['lotId'],
    where: { state: 'UNLABELED', lot: { item: { spec: { requiresCz: true } } } },
    _sum: { qty: true },
  });
  const open = groups.filter((g) => (g._sum.qty ?? 0) > 1e-6);
  const lots = await prisma.lot.findMany({ where: { id: { in: open.map((g) => g.lotId) } }, include: { item: true } });
  const fills = await prisma.stockDocLine.findMany({
    where: { lotId: { in: lots.map((l) => l.id) }, doc: { type: 'FILL', status: 'POSTED' } },
    include: { doc: { select: { id: true, number: true, date: true } } },
  });
  const fillOf = new Map(fills.map((f) => [f.lotId!, f.doc]));
  const skus = new Map((await load([...new Set(lots.map((l) => l.itemId))])).map((r) => [r.id, r]));
  const qty = new Map(open.map((g) => [g.lotId, r3(g._sum.qty ?? 0)]));
  const out = [];
  for (const l of lots) {
    const sku = skus.get(l.itemId);
    if (!sku) continue;
    out.push({
      lotId: l.id, number: l.number, qty: qty.get(l.id)!, createdAt: l.createdAt,
      vars: await lotLabelVars(prisma, l.id), fill: fillOf.get(l.id) ?? null,
      sku: { id: sku.id, name: sku.name, project: sku.project, freeCodes: sku.codes.pending },
    });
  }
  out.sort((a, b) => +a.createdAt - +b.createdAt);
  res.json(out);
});

// GET /api/stock/marking/history — последние маркировки
router.get('/marking/history', async (_req: AuthRequest, res: Response) => {
  const docs = await prisma.stockDoc.findMany({
    where: { type: 'MARK' }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { user: { select: { email: true } }, lines: { include: { item: true } } },
  });
  const batches = await prisma.outputBatch.findMany({ where: { docId: { in: docs.map((d) => d.id) } } });
  const batchOf = new Map(batches.map((b) => [b.docId!, b]));
  const lots = await prisma.lot.findMany({ where: { id: { in: docs.map((d) => d.sourceLotId!).filter(Boolean) } } });
  const lotOf = new Map(lots.map((l) => [l.id, l]));
  res.json(docs.map((d) => {
    const b = batchOf.get(d.id);
    return {
      id: d.id, number: d.number, status: d.status, date: d.createdAt, user: d.user.email,
      itemName: d.lines[0]?.item.name ?? '', qty: d.lines[0]?.qty ?? 0,
      lotNumber: d.sourceLotId ? lotOf.get(d.sourceLotId)?.number ?? null : null,
      vars: (b?.variables as Record<string, string> | null) ?? {},
      batch: b ? { id: b.id, jobStatus: b.jobStatus } : null,
    };
  }));
});

// POST /api/stock/marking/lots/:lotId/mark { count } — напечатать ЧЗ на партию
router.post('/marking/lots/:lotId/mark', async (req: AuthRequest, res: Response): Promise<void> => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 5000) { res.status(400).json({ error: 'Количество — целое от 1 до 5000' }); return; }
  try {
    const r = await prisma.$transaction((tx) => markLot(tx, req.params.lotId, count, req.user!.id), { isolationLevel: 'Serializable', timeout: 30000 });
    await pdfQueue.add('generate-pdf', r.job);
    res.status(201).json({ docId: r.docId, outputBatchId: r.job.outputBatchId });
  } catch (err) {
    if (err instanceof StockError) { res.status(400).json({ error: err.message }); return; }
    throw err;
  }
});

// ───────────── Загрузка ЧЗ на все SKU (раскладка по GTIN) ─────────────

const uploadAny = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// POST /api/stock/marking/import — PDF (распознаётся в фоне) или CSV/TXT (сразу)
router.post('/marking/import', uploadAny.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  const f = req.file;
  if (!f) { res.status(400).json({ error: 'Нужен файл PDF или CSV' }); return; }
  const isPdf = f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname);
  const fileName = Buffer.from(f.originalname, 'latin1').toString('utf8');
  if (isPdf) {
    const imp = await prisma.czImport.create({ data: { fileName, kind: 'pdf', userId: req.user!.id } });
    const s3Key = `cz-import/${imp.id}.pdf`;
    await uploadFile(s3Key, f.buffer, 'application/pdf');
    await prisma.czImport.update({ where: { id: imp.id }, data: { s3Key } });
    await pdfQueue.add('cz-import', { importId: imp.id } as any, { jobId: `cz-import-${imp.id}` });
    res.status(201).json(await prisma.czImport.findUnique({ where: { id: imp.id } }));
    return;
  }
  const lines = f.buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const codes = lines.map((l) => unescapeGs(l.split(/[,;\t]/)[0].trim().replace(/^"|"$/g, ''))).filter((c) => /^01\d{14}/.test(c));
  if (!codes.length) { res.status(400).json({ error: 'В файле не найдено кодов ЧЗ (строки должны начинаться с 01 и GTIN)' }); return; }
  const imp = await prisma.czImport.create({ data: { fileName, kind: 'csv', userId: req.user!.id, pages: lines.length, decoded: lines.length } });
  const result = await distribute(codes, `import-${imp.id}`);
  res.status(201).json(await prisma.czImport.update({ where: { id: imp.id }, data: { status: 'done', result: result as any, finishedAt: new Date() } }));
});

// GET /api/stock/marking/imports — последние загрузки
router.get('/marking/imports', async (_req: AuthRequest, res: Response) => {
  const rows = await prisma.czImport.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  // коды нераспределённых GTIN наружу не отдаём — только количество
  res.json(rows.map((r) => {
    const result = r.result as any;
    return {
      ...r,
      result: result && { ...result, unassigned: Object.fromEntries(Object.entries(result.unassigned ?? {}).map(([g, l]) => [g, (l as string[]).length])) },
    };
  }));
});

// POST /api/stock/marking/imports/:id/assign { gtin, itemId }
router.post('/marking/imports/:id/assign', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json(await assignUnassigned(req.params.id, String(req.body?.gtin ?? ''), String(req.body?.itemId ?? '')));
  } catch (err) {
    if (err instanceof StockError) { res.status(400).json({ error: err.message }); return; }
    throw err;
  }
});

// PUT /api/stock/marking/:itemId/gtin { gtin }
router.put('/marking/:itemId/gtin', async (req: AuthRequest, res: Response): Promise<void> => {
  const raw = String(req.body?.gtin ?? '').trim();
  const gtin = raw === '' ? null : /^\d{13}$/.test(raw) ? '0' + raw : /^\d{14}$/.test(raw) ? raw : undefined;
  if (gtin === undefined) { res.status(400).json({ error: 'GTIN — 14 цифр (или EAN-13)' }); return; }
  await prisma.$transaction(async (tx) => {
    if (gtin) await tx.productSpec.updateMany({ where: { gtin, itemId: { not: req.params.itemId } }, data: { gtin: null } });
    await tx.productSpec.update({ where: { itemId: req.params.itemId }, data: { gtin } });
  });
  res.json({ ok: true });
});

// GET /api/stock/marking/docs/:id/ki.xlsx — коды маркировки списком (КИ без криптохвоста) для ввода в оборот в Честном знаке
router.get('/marking/docs/:id/ki.xlsx', async (req: AuthRequest, res: Response): Promise<void> => {
  const doc = await prisma.stockDoc.findUnique({ where: { id: req.params.id } });
  if (doc?.type !== 'MARK') { res.status(404).json({ error: 'Документ маркировки не найден' }); return; }
  const codes = await prisma.czCode.findMany({
    where: { outputBatch: { docId: doc.id } }, select: { code: true },
    orderBy: [{ czBatch: { uploadedAt: 'asc' } }, { pageIndex: 'asc' }, { id: 'asc' }],
  });
  const buf = await kiXlsx(codes.map((c) => c.code?.split('\x1d')[0]).filter((x): x is string => !!x));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`КИ ${doc.number}.xlsx`)}`);
  res.end(buf);
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
