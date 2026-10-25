import { Prisma, ProductState } from '@prisma/client';
import { NO_CODES_HINT, claimItemCodes, freeItemCodes } from './czPool';
import { PdfJob, StockError, allocateFefo, consume, nextNumber, round } from './stock';
import { looseCodes, lotLabelVars } from './marking';

type Tx = Prisma.TransactionClient;

export function nextQuantNumber(tx: Tx) {
  return nextNumber('К', async (startsWith) => {
    const q = await tx.quant.findFirst({ where: { number: { startsWith } }, orderBy: { number: 'desc' } });
    return q?.number ?? null;
  }, 3);
}

/** Свободные коды товара в базе ЧЗ */
export const availableCodes = (tx: Tx, itemId: string): Promise<number> => freeItemCodes(tx, itemId);

// projectId — макет этикетки (оформление); коды — из базы ЧЗ товара партии
async function issueBatch(tx: Tx, projectId: string, n: number, _projectName: string, lotId: string): Promise<{ batchId: string; codeIds: string[] }> {
  const lot = await tx.lot.findUnique({ where: { id: lotId }, include: { item: true } });
  if (!lot) throw new StockError('Партия не найдена');
  const codes = await claimItemCodes(tx, lot.itemId, n);
  if (codes.length < n) {
    throw new StockError(`Свободных кодов ЧЗ для «${lot.item.name}»: ${codes.length}, нужно ${n}. ${NO_CODES_HINT}`);
  }
  const batch = await tx.outputBatch.create({
    data: {
      projectId, fromIndex: codes[0].pageIndex, toIndex: codes[codes.length - 1].pageIndex, count: n,
      lotId, variables: await lotLabelVars(tx, lotId),
    },
  });
  await tx.czCode.updateMany({
    where: { id: { in: codes.map((c) => c.id) } },
    data: { status: 'USED', usedAt: new Date(), outputBatchId: batch.id },
  });
  return { batchId: batch.id, codeIds: codes.map((c) => c.id) };
}

/**
 * Сборка квантов: единицы ГП переходят из «без ЧЗ» / «с ЧЗ» в «в кванте», списываются короба и материалы,
 * на каждый квант выдаётся N кодов ЧЗ отдельной выдачей (OutputBatch) — её коды и есть состав кванта.
 * importCodes — ввод уже собранных квантов: коды переданы текстом, ничего не печатается и не списывается.
 */
export async function postQuant(tx: Tx, docId: string, importCodes?: string[][]): Promise<PdfJob[]> {
  const doc = await tx.stockDoc.findUnique({ where: { id: docId } });
  if (!doc || doc.type !== 'QUANT') throw new StockError('Документ не найден');
  if (!doc.quantTypeId) throw new StockError('Не выбран тип кванта');
  if (!doc.sourceLotId) throw new StockError('Не выбрана партия');
  const k = doc.quantCount ?? 0;
  if (k < 1) throw new StockError('Укажите количество квантов');

  const qt = await tx.quantType.findUnique({
    where: { id: doc.quantTypeId },
    include: { materials: { include: { item: true }, orderBy: { sort: 'asc' } }, boxItem: true, project: { include: { template: true } } },
  });
  if (!qt) throw new StockError('Тип кванта не найден');
  const lot = await tx.lot.findUnique({ where: { id: doc.sourceLotId }, include: { item: true } });
  if (lot?.itemId !== qt.productItemId) throw new StockError(`Партия не относится к SKU типа «${qt.name}»`);

  const n = qt.unitsPerQuant;
  const state: ProductState = doc.sourceState ?? (doc.imported ? 'LABELED' : 'UNLABELED');
  // Из «с ЧЗ» коды уже на банках (напечатаны маркировкой) — новые не выдаются, квант получает коды партии россыпью
  const needCz = qt.trackCz && !doc.imported && state === 'UNLABELED';
  const reuseCz = qt.trackCz && !doc.imported && state === 'LABELED';
  if (needCz) {
    if (!qt.project) throw new StockError(`У типа «${qt.name}» не выбран проект этикетки ЧЗ`);
    if (!qt.project.template) throw new StockError(`В проекте «${qt.project.name}» нет макета этикетки`);
    if (qt.project.template.czArea === null) throw new StockError(`В макете проекта «${qt.project.name}» нет поля ЧЗ`);
  }
  if (importCodes && qt.trackCz) {
    if (importCodes.length !== k) throw new StockError(`Передано ${importCodes.length} списков кодов, а квантов ${k}`);
    importCodes.forEach((codes, i) => {
      if (codes.length !== n) throw new StockError(`Квант ${i + 1}: ${codes.length} кодов вместо ${n}`);
    });
    const all = importCodes.flat();
    if (new Set(all).size !== all.length) throw new StockError('Есть повторяющиеся коды');
    const taken = await tx.quantCode.findFirst({ where: { code: { in: all }, active: true }, include: { quant: true } });
    if (taken) throw new StockError(`Код уже числится в кванте ${taken.quant.number}`);
  }

  // Единицы: из исходного состояния — в «в кванте»
  await consume(tx, docId, lot.id, state, k * n, lot.item.name);
  await tx.stockMove.create({ data: { docId, lotId: lot.id, state: 'IN_QUANT', qty: k * n } });

  // Короба и материалы по FEFO (при вводе существующих квантов не списываются)
  let extraCost: number | null = 0;
  if (!doc.imported) {
    const needs = [
      ...(qt.boxItem ? [{ item: qt.boxItem, qty: k }] : []),
      ...qt.materials.map((m) => ({ item: m.item, qty: round(m.qtyPerQuant * k) })),
    ];
    let sort = 0;
    for (const need of needs) {
      const { allocations, shortage } = await allocateFefo(tx, need.item.id, need.qty);
      if (shortage > 0) throw new StockError(`«${need.item.name}»: не хватает ${shortage} ${need.item.unit}`);
      for (const a of allocations) {
        await consume(tx, docId, a.lotId!, 'NONE', a.qty, need.item.name);
        await tx.stockDocLine.create({ data: { docId, itemId: need.item.id, lotId: a.lotId, qty: a.qty, sort: sort++ } });
        const l = await tx.lot.findUnique({ where: { id: a.lotId! } });
        extraCost = extraCost == null || l?.unitCost == null ? null : extraCost + l.unitCost * a.qty;
      }
    }
  }
  const quantCost = lot.unitCost == null || extraCost == null ? null : round(lot.unitCost * n + extraCost / k);

  const jobs: PdfJob[] = [];
  for (let i = 0; i < k; i++) {
    let outputBatchId: string | null = null;
    let codeIds: string[] = [];
    if (needCz) {
      const issued = await issueBatch(tx, qt.project!.id, n, qt.project!.name, lot.id);
      outputBatchId = issued.batchId;
      codeIds = issued.codeIds;
      jobs.push({ outputBatchId, projectId: qt.project!.id, codeIds });
    } else if (reuseCz) {
      // Коды уже на банках. Если портал их знает (партию маркировали здесь) — привязываем к кванту;
      // если нет (например, остатки «с ЧЗ» введены начальными) — квант собирается без списка кодов
      codeIds = await looseCodes(tx, lot.id, n);
    }
    const quant = await tx.quant.create({
      data: {
        number: await nextQuantNumber(tx),
        quantTypeId: qt.id, lotId: lot.id, docId, units: n, unitCost: quantCost, outputBatchId,
      },
    });
    if (codeIds.length) {
      await tx.quantCode.createMany({ data: codeIds.map((czCodeId) => ({ quantId: quant.id, czCodeId })) });
    }
    if (importCodes && qt.trackCz) {
      const texts = importCodes[i];
      // Если код загружен в портал — привязываем и помечаем использованным
      const known = await tx.czCode.findMany({ where: { code: { in: texts } } });
      const byText = new Map(known.map((c) => [c.code!, c]));
      await tx.czCode.updateMany({ where: { id: { in: known.map((c) => c.id) }, status: 'PENDING' }, data: { status: 'USED', usedAt: new Date() } });
      await tx.quantCode.createMany({ data: texts.map((code) => ({ quantId: quant.id, code, czCodeId: byText.get(code)?.id ?? null })) });
    }
  }

  await tx.stockDoc.update({ where: { id: docId }, data: { status: 'POSTED', postedAt: new Date() } });
  return jobs;
}

// Отмена сборки: кванты разбираются, коды ЧЗ — в брак (напечатаны) или обратно в пул (не печатались)
export async function cancelQuants(tx: Tx, docId: string, releaseCodes: boolean): Promise<void> {
  const quants = await tx.quant.findMany({ where: { docId }, include: { codes: true } });
  const busy = quants.find((q) => q.status !== 'ASSEMBLED');
  if (busy) throw new StockError(`Квант ${busy.number} уже в поставке или отгружен`);
  const czIds = quants.flatMap((q) => q.codes.filter((c) => c.active).map((c) => c.czCodeId)).filter((x): x is string => !!x);
  const doc = await tx.stockDoc.findUnique({ where: { id: docId } });
  // Коды введённых вручную квантов и квантов из «с ЧЗ» уже нанесены на банки — их статус не меняем
  if (czIds.length && !doc?.imported && doc?.sourceState !== 'LABELED') {
    await tx.czCode.updateMany({
      where: { id: { in: czIds } },
      data: releaseCodes ? { status: 'PENDING', usedAt: null, outputBatchId: null } : { status: 'SPOILED' },
    });
  }
  await tx.quantCode.updateMany({ where: { quantId: { in: quants.map((q) => q.id) } }, data: { active: false } });
  await tx.quant.updateMany({ where: { docId }, data: { status: 'DISASSEMBLED' } });
}

// Замена испорченной этикетки: старый код — в брак, из пула выдаётся новый (отдельная выдача на 1 этикетку)
export async function replaceCode(tx: Tx, quantId: string, quantCodeId: string): Promise<PdfJob> {
  const quant = await tx.quant.findUnique({ where: { id: quantId }, include: { quantType: { include: { project: true } } } });
  if (!quant) throw new StockError('Квант не найден');
  if (quant.status !== 'ASSEMBLED') throw new StockError('Квант уже в поставке или отгружен');
  const qc = await tx.quantCode.findUnique({ where: { id: quantCodeId } });
  if (!qc || qc.quantId !== quantId || !qc.active) throw new StockError('Код не найден в кванте');
  const project = quant.quantType.project;
  if (!project) throw new StockError('У типа кванта не выбран проект этикетки ЧЗ');

  await tx.quantCode.update({ where: { id: qc.id }, data: { active: false } });
  if (qc.czCodeId) await tx.czCode.update({ where: { id: qc.czCodeId }, data: { status: 'SPOILED' } });
  const issued = await issueBatch(tx, project.id, 1, project.name, quant.lotId);
  await tx.quantCode.create({ data: { quantId, czCodeId: issued.codeIds[0] } });
  return { outputBatchId: issued.batchId, projectId: project.id, codeIds: issued.codeIds };
}
