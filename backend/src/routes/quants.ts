import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { PdfJob, StockError, nextDocNumber } from '../services/stock';
import { availableCodes, postQuant, replaceCode } from '../services/quants';
import { mergePdfs, renderQuantLabels } from '../services/quantLabel';
import { downloadFile } from '../services/s3';
import { pdfQueue } from '../workers/pdfQueue';

const router = Router();
router.use(authMiddleware);

function sendError(res: Response, err: unknown): void {
  if (err instanceof StockError) { res.status(400).json({ error: err.message }); return; }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({ error: 'Такая запись уже есть' }); return;
  }
  throw err;
}

export async function enqueuePdfJobs(jobs: PdfJob[]): Promise<void> {
  for (const j of jobs) await pdfQueue.add('generate-pdf', j);
}

function sendPdf(res: Response, buf: Buffer, name: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

// ───────────── Типы квантов ─────────────

const typeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  productItemId: z.string().uuid(),
  unitsPerQuant: z.number().int().min(1).max(1000),
  boxItemId: z.string().uuid().nullable(),
  trackCz: z.boolean(),
  projectId: z.string().uuid().nullable(),
  labelWidthMm: z.number().min(20).max(200),
  labelHeightMm: z.number().min(15).max(200),
  archived: z.boolean().optional(),
  materials: z.array(z.object({ itemId: z.string().uuid(), qtyPerQuant: z.number().positive() })).max(20),
});

// GET /api/stock/quant-types
router.get('/quant-types', async (_req: AuthRequest, res: Response) => {
  const types = await prisma.quantType.findMany({
    orderBy: [{ archived: 'asc' }, { name: 'asc' }],
    include: {
      productItem: true, boxItem: true, project: { select: { id: true, name: true } },
      materials: { include: { item: true }, orderBy: { sort: 'asc' } },
      _count: { select: { quants: { where: { status: 'ASSEMBLED' } } } },
    },
  });
  const out = [];
  for (const t of types) {
    out.push({ ...t, freeCodes: t.projectId ? await availableCodes(prisma, t.projectId) : null, inStock: t._count.quants });
  }
  res.json(out);
});

async function saveType(req: AuthRequest, res: Response, id?: string): Promise<void> {
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { materials, ...data } = parsed.data;
  if (data.trackCz && !data.projectId) { res.status(400).json({ error: 'Для учёта ЧЗ выберите проект этикетки' }); return; }
  const product = await prisma.item.findUnique({ where: { id: data.productItemId } });
  if (product?.type !== 'PRODUCT') { res.status(400).json({ error: 'Выберите SKU готовой продукции' }); return; }
  try {
    const t = await prisma.$transaction(async (tx) => {
      if (id) {
        const old = await tx.quantType.findUnique({ where: { id }, include: { _count: { select: { quants: true } } } });
        if (!old) throw new StockError('Тип не найден');
        if (old._count.quants > 0 && (old.productItemId !== data.productItemId || old.unitsPerQuant !== data.unitsPerQuant)) {
          throw new StockError('По этому типу уже собраны кванты: SKU и количество менять нельзя. Создайте новый тип, а этот отправьте в архив.');
        }
        await tx.quantTypeMaterial.deleteMany({ where: { quantTypeId: id } });
      }
      const saved = id ? await tx.quantType.update({ where: { id }, data }) : await tx.quantType.create({ data });
      await tx.quantTypeMaterial.createMany({ data: materials.map((m, i) => ({ ...m, quantTypeId: saved.id, sort: i })) });
      return saved;
    });
    res.status(id ? 200 : 201).json(t);
  } catch (err) { sendError(res, err); }
}

router.post('/quant-types', (req: AuthRequest, res: Response) => saveType(req, res));
router.put('/quant-types/:id', (req: AuthRequest, res: Response) => saveType(req, res, req.params.id));

// ───────────── Сборка квантов ─────────────

const assembleSchema = z.object({
  quantTypeId: z.string().uuid(),
  sourceLotId: z.string().uuid(),
  sourceState: z.enum(['UNLABELED', 'LABELED']),
  quantCount: z.number().int().min(1).max(500),
  date: z.string().optional(),
  comment: z.string().max(1000).nullable().optional(),
  // ввод существующих квантов: коды по квантам (для типов с ЧЗ)
  imported: z.boolean().optional(),
  codes: z.array(z.array(z.string().min(10).max(300))).optional(),
});

// POST /api/stock/quant-docs — сборка (или ввод существующих) квантов, сразу проводится
router.post('/quant-docs', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = assembleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { codes, date, imported, ...data } = parsed.data;
  try {
    const { doc, jobs } = await prisma.$transaction(async (tx) => {
      const doc = await tx.stockDoc.create({
        data: {
          ...data,
          imported: imported ?? false,
          type: 'QUANT',
          number: await nextDocNumber(tx, 'QUANT'),
          date: date ? new Date(date) : new Date(),
          userId: req.user!.id,
        },
      });
      const jobs = await postQuant(tx, doc.id, imported ? codes ?? [] : undefined);
      return { doc, jobs };
    }, { isolationLevel: 'Serializable', timeout: 60_000 });
    await enqueuePdfJobs(jobs);
    res.status(201).json(doc);
  } catch (err) { sendError(res, err); }
});

// GET /api/stock/quant-docs/:id — документ сборки с квантами и статусом генерации этикеток
router.get('/quant-docs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const doc = await prisma.stockDoc.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { email: true } },
      quantType: { include: { productItem: true, boxItem: true } },
      lines: { include: { item: true }, orderBy: { sort: 'asc' } },
      quants: { orderBy: { number: 'asc' }, include: { outputBatch: { select: { id: true, jobStatus: true } } } },
    },
  });
  if (!doc || doc.type !== 'QUANT') { res.status(404).json({ error: 'Not found' }); return; }
  const lotIds = [doc.sourceLotId, ...doc.lines.map((l) => l.lotId)].filter((x): x is string => !!x);
  const lots = await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, number: true } });
  const num = new Map(lots.map((l) => [l.id, l.number]));
  res.json({
    ...doc,
    sourceLotNumber: doc.sourceLotId ? num.get(doc.sourceLotId) : null,
    lines: doc.lines.map((l) => ({ ...l, lotNumber: l.lotId ? num.get(l.lotId) : null })),
  });
});

// GET /api/stock/quant-docs/:id/cz.pdf — этикетки ЧЗ всех квантов документа одним файлом, по порядку квантов
router.get('/quant-docs/:id/cz.pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  const quants = await prisma.quant.findMany({
    where: { docId: req.params.id }, orderBy: { number: 'asc' }, include: { outputBatch: true },
  });
  const batches = quants.map((q) => q.outputBatch).filter((b): b is NonNullable<typeof b> => !!b);
  if (batches.length === 0) { res.status(404).json({ error: 'В этих квантах нет этикеток ЧЗ' }); return; }
  if (batches.some((b) => b.jobStatus !== 'done' || !b.s3Key)) { res.status(409).json({ error: 'Этикетки ещё генерируются' }); return; }
  const doc = await prisma.stockDoc.findUnique({ where: { id: req.params.id } });
  sendPdf(res, await mergePdfs(batches.map((b) => b.s3Key)), `ЧЗ ${doc?.number ?? ''}.pdf`);
});

// GET /api/stock/quant-labels.pdf?docId=… | ?ids=a,b — этикетки квантов
router.get('/quant-labels.pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  const where = req.query.docId
    ? { docId: String(req.query.docId) }
    : { id: { in: String(req.query.ids ?? '').split(',').filter(Boolean) } };
  const quants = await prisma.quant.findMany({
    where, orderBy: { number: 'asc' }, include: { lot: true, quantType: { include: { productItem: true } } },
  });
  if (quants.length === 0) { res.status(404).json({ error: 'Кванты не найдены' }); return; }
  const t = quants[0].quantType;
  const pdf = await renderQuantLabels(quants.map((q) => ({
    number: q.number, productName: q.quantType.productItem.name, units: q.units,
    lotNumber: q.lot.number, expiresAt: q.lot.expiresAt, createdAt: q.createdAt,
  })), t.labelWidthMm, t.labelHeightMm);
  sendPdf(res, pdf, quants.length === 1 ? `${quants[0].number}.pdf` : `Кванты ${quants[0].number}…${quants[quants.length - 1].number}.pdf`);
});

// GET /api/stock/batches/:id/pdf — PDF одной выдачи (замена кода) без проверки владельца проекта
router.get('/batches/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  const batch = await prisma.outputBatch.findUnique({ where: { id: req.params.id } });
  if (!batch) { res.status(404).json({ error: 'Not found' }); return; }
  if (batch.jobStatus !== 'done' || !batch.s3Key) { res.status(409).json({ error: batch.jobStatus === 'error' ? 'Ошибка генерации' : 'Этикетка ещё генерируется' }); return; }
  sendPdf(res, await downloadFile(batch.s3Key), `ЧЗ-${batch.id.slice(0, 8)}.pdf`);
});

// ───────────── Кванты ─────────────

// GET /api/stock/quants?status=ASSEMBLED&typeId=…&q=К-2610 или код ЧЗ
router.get('/quants', async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  const where: Prisma.QuantWhereInput = {
    status: req.query.status ? (String(req.query.status) as any) : undefined,
    quantTypeId: req.query.typeId ? String(req.query.typeId) : undefined,
  };
  if (q) {
    where.OR = [
      { number: { contains: q, mode: 'insensitive' } },
      { codes: { some: { OR: [{ code: { contains: q } }, { czCode: { code: { contains: q } } }] } } },
    ];
  }
  const quants = await prisma.quant.findMany({
    where, orderBy: { number: 'desc' }, take: 500,
    include: {
      lot: { select: { number: true, expiresAt: true } },
      quantType: { select: { name: true } },
      doc: { select: { id: true, number: true } },
      _count: { select: { codes: { where: { active: true } } } },
    },
  });
  res.json(quants);
});

const codeText = (c: { code: string | null; czCode: { code: string | null } | null }) => c.code ?? c.czCode?.code ?? null;

// GET /api/stock/quants/:id — квант, коды ЧЗ и цепочка до сырья
router.get('/quants/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const quant = await prisma.quant.findUnique({
    where: { id: req.params.id },
    include: {
      quantType: { include: { productItem: true, project: { select: { id: true, name: true } } } },
      lot: { include: { item: true } },
      doc: { select: { id: true, number: true, date: true, imported: true } },
      outputBatch: { select: { id: true, jobStatus: true } },
      codes: { orderBy: { createdAt: 'asc' }, include: { czCode: { select: { code: true, status: true, outputBatchId: true } } } },
    },
  });
  if (!quant) { res.status(404).json({ error: 'Not found' }); return; }

  // Прослеживаемость: партия ГП → бочка → замес → лоты сырья
  const trace: any = { lot: quant.lot.number, barrel: null, mix: null, raw: [] };
  if (quant.lot.parentLotId) {
    const barrel = await prisma.lot.findUnique({ where: { id: quant.lot.parentLotId }, include: { item: true } });
    trace.barrel = barrel && { number: barrel.number, barrel: barrel.barrel, item: barrel.item.name };
    const mix = await prisma.stockDoc.findFirst({
      where: { outputLotId: quant.lot.parentLotId, status: 'POSTED' },
      include: { lines: { include: { item: true } } },
    });
    if (mix) {
      trace.mix = { id: mix.id, number: mix.number, date: mix.date };
      const lots = await prisma.lot.findMany({ where: { id: { in: mix.lines.map((l) => l.lotId).filter((x): x is string => !!x) } } });
      const num = new Map(lots.map((l) => [l.id, l]));
      trace.raw = mix.lines.filter((l) => l.lotId).map((l) => ({
        item: l.item.name, lot: num.get(l.lotId!)?.number, supplierLot: num.get(l.lotId!)?.supplierLot, qty: l.qty,
      }));
    }
  }
  res.json({
    ...quant,
    codes: quant.codes.map((c) => ({ id: c.id, active: c.active, code: codeText(c), czStatus: c.czCode?.status ?? null, outputBatchId: c.czCode?.outputBatchId ?? null, createdAt: c.createdAt })),
    trace,
  });
});

// POST /api/stock/quants/:id/replace-code { quantCodeId }
router.post('/quants/:id/replace-code', async (req: AuthRequest, res: Response): Promise<void> => {
  const quantCodeId = String(req.body?.quantCodeId ?? '');
  try {
    const job = await prisma.$transaction((tx) => replaceCode(tx, req.params.id, quantCodeId), { isolationLevel: 'Serializable' });
    await enqueuePdfJobs([job]);
    res.json({ outputBatchId: job.outputBatchId });
  } catch (err) { sendError(res, err); }
});

// GET /api/stock/quant-codes.csv?docId=… | ?quantId=… | ?ids=a,b — список кодов ЧЗ для УПД
router.get('/quant-codes.csv', async (req: AuthRequest, res: Response) => {
  const where: Prisma.QuantWhereInput = req.query.quantId ? { id: String(req.query.quantId) }
    : req.query.docId ? { docId: String(req.query.docId) }
    : { id: { in: String(req.query.ids ?? '').split(',').filter(Boolean) } };
  const quants = await prisma.quant.findMany({
    where, orderBy: { number: 'asc' },
    include: {
      quantType: { include: { productItem: true } },
      codes: { where: { active: true }, orderBy: { createdAt: 'asc' }, include: { czCode: { select: { code: true } } } },
    },
  });
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  // Код для УПД — без криптохвоста: 01 + GTIN(14) + 21 + серийный номер до разделителя GS
  const short = (full: string) => full.replace(/^\x1d/, '').split('\x1d')[0];
  const rows = ['Квант;SKU;Код маркировки (для УПД);Полный код (GS = \\u001d)'];
  for (const q of quants) {
    for (const c of q.codes) {
      const full = codeText(c);
      rows.push([q.number, q.quantType.productItem.name, full ? short(full) : 'код ещё не распознан', full ? full.replace(/\x1d/g, '\\u001d') : ''].map(esc).join(';'));
    }
  }
  const name = req.query.quantId && quants[0] ? `ЧЗ ${quants[0].number}.csv` : 'ЧЗ квантов.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send('﻿' + rows.join('\r\n'));
});

export default router;
