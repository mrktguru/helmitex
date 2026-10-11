import { Prisma } from '@prisma/client';
import { PdfJob, StockError, consume, lotBalance, nextDocNumber } from './stock';

type Tx = Prisma.TransactionClient;

const fmtDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;

/**
 * Переменные макета, которые берутся из партии ГП:
 *   {{lot}}    — номер бочки полуфабриката, из которой фасовали (П-…), иначе номер самой партии
 *   {{expiry}} — годен до
 */
export async function lotLabelVars(tx: Tx, lotId: string): Promise<Record<string, string>> {
  const lot = await tx.lot.findUnique({ where: { id: lotId } });
  if (!lot) return {};
  const parent = lot.parentLotId ? await tx.lot.findUnique({ where: { id: lot.parentLotId } }) : null;
  return { lot: parent?.number ?? lot.number, expiry: lot.expiresAt ? fmtDate(lot.expiresAt) : '' };
}

/** Маркировка партии: n кодов из пула SKU → тираж этикеток, n шт. «без ЧЗ» → «с ЧЗ». */
export async function markLot(tx: Tx, lotId: string, n: number, userId: string): Promise<{ docId: string; job: PdfJob }> {
  const lot = await tx.lot.findUnique({
    where: { id: lotId },
    include: { item: { include: { spec: { include: { czProject: { include: { template: true } } } } } } },
  });
  if (!lot || lot.item.type !== 'PRODUCT') throw new StockError('Партия готовой продукции не найдена');
  const project = lot.item.spec?.requiresCz ? lot.item.spec.czProject : null;
  if (!project) throw new StockError(`Для «${lot.item.name}» не включена маркировка ЧЗ`);
  if (!project.template) throw new StockError(`Для «${lot.item.name}» не создан макет этикетки`);
  if (project.template.czArea === null) throw new StockError(`В макете «${lot.item.name}» нет поля ЧЗ`);

  const balance = await lotBalance(tx, lot.id, 'UNLABELED');
  if (n > balance + 1e-6) throw new StockError(`В партии ${lot.number} без ЧЗ только ${balance} шт.`);

  const codes = await tx.$queryRaw<{ id: string; pageIndex: number }[]>`
    SELECT c.id, c."pageIndex"
    FROM "CzCode" c JOIN "CzBatch" b ON b.id = c."czBatchId"
    WHERE b."projectId" = ${project.id} AND c.status = 'PENDING'
    ORDER BY b."uploadedAt" ASC, c."pageIndex" ASC
    LIMIT ${n}
    FOR UPDATE OF c SKIP LOCKED`;
  if (codes.length < n) {
    throw new StockError(`Свободных кодов ЧЗ для «${lot.item.name}»: ${codes.length}, нужно ${n}. Загрузите коды.`);
  }

  const doc = await tx.stockDoc.create({
    data: {
      type: 'MARK', status: 'POSTED', postedAt: new Date(), number: await nextDocNumber(tx, 'MARK'), userId,
      sourceLotId: lot.id, comment: `Маркировка партии ${lot.number}: ${n} шт.`,
    },
  });
  await tx.stockDocLine.create({ data: { docId: doc.id, itemId: lot.itemId, lotId: lot.id, qty: n, state: 'LABELED' } });
  await consume(tx, doc.id, lot.id, 'UNLABELED', n, lot.item.name);
  await tx.stockMove.create({ data: { docId: doc.id, lotId: lot.id, state: 'LABELED', qty: n } });

  const batch = await tx.outputBatch.create({
    data: {
      projectId: project.id, fromIndex: codes[0].pageIndex, toIndex: codes[codes.length - 1].pageIndex, count: n,
      lotId: lot.id, docId: doc.id, variables: await lotLabelVars(tx, lot.id),
    },
  });
  await tx.czCode.updateMany({
    where: { id: { in: codes.map((c) => c.id) } },
    data: { status: 'USED', usedAt: new Date(), outputBatchId: batch.id },
  });
  return { docId: doc.id, job: { outputBatchId: batch.id, projectId: project.id, codeIds: codes.map((c) => c.id) } };
}

/** Напечатанные коды партии, которые сейчас на банках россыпью (не в активном кванте). */
export async function looseCodes(tx: Tx, lotId: string, n: number): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT c.id
    FROM "CzCode" c
    JOIN "OutputBatch" b ON b.id = c."outputBatchId"
    LEFT JOIN "Quant" q ON q."outputBatchId" = b.id
    WHERE c.status = 'USED'
      AND (b."lotId" = ${lotId} OR q."lotId" = ${lotId})
      AND NOT EXISTS (SELECT 1 FROM "QuantCode" qc WHERE qc."czCodeId" = c.id AND qc.active)
    ORDER BY c."usedAt" ASC, c."pageIndex" ASC
    LIMIT ${n}
    FOR UPDATE OF c`;
  return rows.map((r) => r.id);
}

/** Отмена маркировки: коды — в брак (этикетки напечатаны) или обратно в пул (не печатались). */
export async function cancelMark(tx: Tx, docId: string, releaseCodes: boolean): Promise<void> {
  const batches = await tx.outputBatch.findMany({ where: { docId }, select: { id: true } });
  const ids = batches.map((b) => b.id);
  const inQuant = await tx.quantCode.findFirst({
    where: { active: true, czCode: { outputBatchId: { in: ids } } }, include: { quant: true },
  });
  if (inQuant) throw new StockError(`Коды этой маркировки уже в кванте ${inQuant.quant.number}`);
  await tx.czCode.updateMany({
    where: { outputBatchId: { in: ids } },
    data: releaseCodes ? { status: 'PENDING', usedAt: null, outputBatchId: null } : { status: 'SPOILED' },
  });
}
