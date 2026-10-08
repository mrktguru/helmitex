import { DocType, ItemType, Prisma, ProductState } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export const LOT_PREFIX: Record<ItemType, string> = {
  RAW: 'С',
  CONTAINER: 'Т',
  PACKAGING: 'У',
  LABEL: 'Э',
  SEMI: 'П',
  PRODUCT: 'Г',
};

export const DOC_PREFIX: Record<DocType, string> = {
  RECEIPT: 'ПР',
  OPENING: 'НО',
  ADJUSTMENT: 'КР',
  MIX: 'З',
  FILL: 'Ф',
  QUANT: 'СК',
};

const EPS = 1e-6;

function datePart(d = new Date()): string {
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// Следующий номер вида «С-261007-03»: префикс + дата + порядковый за день.
export async function nextNumber(
  prefix: string,
  findLast: (startsWith: string) => Promise<string | null>,
  pad = 2,
): Promise<string> {
  const base = `${prefix}-${datePart()}-`;
  const last = await findLast(base);
  const n = last ? parseInt(last.slice(base.length), 10) + 1 : 1;
  return base + String(n).padStart(pad, '0');
}

export function nextLotNumber(tx: Tx, type: ItemType) {
  return nextNumber(LOT_PREFIX[type], async (startsWith) => {
    const lot = await tx.lot.findFirst({ where: { number: { startsWith } }, orderBy: { number: 'desc' } });
    return lot?.number ?? null;
  });
}

export function nextDocNumber(tx: Tx, type: DocType) {
  return nextNumber(DOC_PREFIX[type], async (startsWith) => {
    const doc = await tx.stockDoc.findFirst({ where: { number: { startsWith } }, orderBy: { number: 'desc' } });
    return doc?.number ?? null;
  });
}

export async function lotBalance(tx: Tx, lotId: string, state: ProductState): Promise<number> {
  const agg = await tx.stockMove.aggregate({ where: { lotId, state }, _sum: { qty: true } });
  return agg._sum.qty ?? 0;
}

export class StockError extends Error {}

// Задание на генерацию PDF этикеток ЧЗ — ставится в очередь после коммита транзакции
export interface PdfJob { outputBatchId: string; projectId: string; codeIds: string[] }

// Проводит черновик: приход и начальные остатки создают лоты, корректировка двигает существующие.
export async function postDoc(tx: Tx, docId: string): Promise<PdfJob[]> {
  const doc = await tx.stockDoc.findUnique({
    where: { id: docId },
    include: { lines: { include: { item: true } } },
  });
  if (!doc) throw new StockError('Документ не найден');
  if (doc.status !== 'DRAFT') throw new StockError('Провести можно только черновик');

  if (doc.type === 'MIX') {
    await postMix(tx, doc);
    return [];
  }
  if (doc.type === 'FILL') {
    await postFill(tx, doc);
    return [];
  }
  if (doc.type === 'QUANT') {
    const { postQuant } = await import('./quants');
    return postQuant(tx, docId);
  }
  if (doc.lines.length === 0) throw new StockError('В документе нет строк');

  for (const line of doc.lines) {
    if (doc.type === 'ADJUSTMENT') {
      if (!line.lotId) throw new StockError(`Не выбран лот для «${line.item.name}»`);
      const balance = await lotBalance(tx, line.lotId, line.state);
      if (balance + line.qty < -EPS) {
        throw new StockError(`«${line.item.name}»: остаток ${balance}, списать ${-line.qty} нельзя`);
      }
      await tx.stockMove.create({ data: { docId, lotId: line.lotId, state: line.state, qty: line.qty } });
      continue;
    }

    if (line.qty <= 0) throw new StockError(`«${line.item.name}»: количество должно быть больше нуля`);
    const state = line.item.type === 'PRODUCT' ? (line.state === 'NONE' ? 'UNLABELED' : line.state) : 'NONE';
    const lot = await tx.lot.create({
      data: {
        number: await nextLotNumber(tx, line.item.type),
        itemId: line.itemId,
        supplierLot: line.supplierLot,
        expiresAt: line.expiresAt,
        unitCost: line.unitCost,
        barrel: line.barrel,
      },
    });
    await tx.stockDocLine.update({ where: { id: line.id }, data: { lotId: lot.id, state } });
    await tx.stockMove.create({ data: { docId, lotId: lot.id, state, qty: line.qty } });
  }

  await tx.stockDoc.update({ where: { id: docId }, data: { status: 'POSTED', postedAt: new Date() } });
  return [];
}

// Отмена проведённого документа: сторно всех его движений, если остатки позволяют.
export async function cancelDoc(tx: Tx, docId: string, opts: { releaseCodes?: boolean } = {}): Promise<void> {
  const doc = await tx.stockDoc.findUnique({ where: { id: docId }, include: { moves: { include: { lot: { include: { item: true } } } } } });
  if (!doc) throw new StockError('Документ не найден');
  if (doc.status !== 'POSTED') throw new StockError('Отменить можно только проведённый документ');

  for (const m of doc.moves) {
    if (m.qty > 0) {
      const balance = await lotBalance(tx, m.lotId, m.state);
      if (balance - m.qty < -EPS) {
        throw new StockError(`Лот ${m.lot.number} (${m.lot.item.name}) уже израсходован: остаток ${balance}`);
      }
    }
    await tx.stockMove.create({ data: { docId, lotId: m.lotId, state: m.state, qty: -m.qty } });
  }
  if (doc.type === 'QUANT') {
    const { cancelQuants } = await import('./quants');
    await cancelQuants(tx, docId, opts.releaseCodes ?? false);
  }
  await tx.stockDoc.update({ where: { id: docId }, data: { status: 'CANCELLED' } });
}

type DocWithLines = Prisma.StockDocGetPayload<{ include: { lines: { include: { item: true } } } }>;

export async function consume(tx: Tx, docId: string, lotId: string, state: ProductState, qty: number, name: string) {
  await tx.stockMove.create({ data: { docId, lotId, state, qty: -qty } });
  const balance = await lotBalance(tx, lotId, state);
  if (balance < -EPS) {
    const lot = await tx.lot.findUnique({ where: { id: lotId } });
    throw new StockError(`«${name}», лот ${lot?.number}: не хватает ${round(-balance)}`);
  }
}

export const round = (n: number) => Math.round(n * 1e6) / 1e6;

// Замес: списывает сырьё по фактическим лотам, создаёт бочку полуфабриката с выходом и себестоимостью.
async function postMix(tx: Tx, doc: DocWithLines): Promise<void> {
  if (!doc.outputItemId) throw new StockError('Не выбран полуфабрикат');
  if (!doc.lines.some((l) => l.qty > 0)) throw new StockError('В замесе нет компонентов');
  if (!doc.yieldQty || doc.yieldQty <= 0) throw new StockError('Укажите выход в бочку, кг');

  let cost: number | null = 0;
  for (const line of doc.lines) {
    if (line.qty < 0) throw new StockError(`«${line.item.name}»: расход не может быть отрицательным`);
    if (line.qty === 0 || line.item.noStock) continue;
    if (!line.lotId) throw new StockError(`«${line.item.name}»: не выбран лот`);
    await consume(tx, doc.id, line.lotId, 'NONE', line.qty, line.item.name);
    const lot = await tx.lot.findUnique({ where: { id: line.lotId } });
    if (lot?.itemId !== line.itemId) throw new StockError(`«${line.item.name}»: лот от другой позиции`);
    cost = cost == null || lot.unitCost == null ? null : cost + lot.unitCost * line.qty;
  }

  const lot = await tx.lot.create({
    data: {
      number: await nextLotNumber(tx, 'SEMI'),
      itemId: doc.outputItemId,
      barrel: doc.barrel,
      expiresAt: doc.expiresAt,
      unitCost: cost == null ? null : round(cost / doc.yieldQty),
    },
  });
  await tx.stockMove.create({ data: { docId: doc.id, lotId: lot.id, state: 'NONE', qty: doc.yieldQty } });
  await tx.stockDoc.update({ where: { id: doc.id }, data: { status: 'POSTED', postedAt: new Date(), outputLotId: lot.id } });
}

export interface Allocation { lotId: string | null; lotNumber: string | null; qty: number }

// Подбор лотов по FEFO: ближайший срок годности первым, без срока — в конце, затем по дате прихода.
export async function allocateFefo(tx: Tx, itemId: string, need: number): Promise<{ allocations: Allocation[]; shortage: number }> {
  const groups = await tx.stockMove.groupBy({
    by: ['lotId'],
    where: { lot: { itemId }, state: 'NONE' },
    _sum: { qty: true },
  });
  const avail = groups.filter((g) => (g._sum.qty ?? 0) > EPS);
  const lots = await tx.lot.findMany({ where: { id: { in: avail.map((g) => g.lotId) } } });
  const qty = new Map(avail.map((g) => [g.lotId, g._sum.qty ?? 0]));
  lots.sort((a, b) =>
    (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
    a.createdAt.getTime() - b.createdAt.getTime());

  const allocations: Allocation[] = [];
  let left = need;
  for (const lot of lots) {
    if (left <= EPS) break;
    const take = Math.min(left, qty.get(lot.id)!);
    allocations.push({ lotId: lot.id, lotNumber: lot.number, qty: round(take) });
    left -= take;
  }
  return { allocations, shortage: left > EPS ? round(left) : 0 };
}

// Фасовка: из бочки в единицы ГП «без ЧЗ», списание тары и этикеток.
// Себестоимость единицы = полуфабрикат (с учётом потерь) + материалы по карточке SKU.
async function postFill(tx: Tx, doc: DocWithLines): Promise<void> {
  if (!doc.sourceLotId) throw new StockError('Не выбрана бочка');
  const barrel = await tx.lot.findUnique({ where: { id: doc.sourceLotId }, include: { item: true } });
  if (barrel?.item.type !== 'SEMI') throw new StockError('Источник фасовки — не бочка полуфабриката');

  const outputs = doc.lines.filter((l) => l.item.type === 'PRODUCT' && l.qty > 0);
  const materials = doc.lines.filter((l) => l.item.type !== 'PRODUCT' && l.qty > 0);
  if (outputs.length === 0) throw new StockError('Нет фасованной продукции');

  const specs = await tx.productSpec.findMany({
    where: { itemId: { in: outputs.map((o) => o.itemId) } },
    include: { materials: true },
  });
  const specOf = new Map(specs.map((sp) => [sp.itemId, sp]));
  let usedKg = 0;
  for (const o of outputs) {
    const sp = specOf.get(o.itemId);
    if (!sp?.netQty) throw new StockError(`«${o.item.name}»: в карточке SKU не задано нетто`);
    if (sp.semiItemId && sp.semiItemId !== barrel.itemId) {
      throw new StockError(`«${o.item.name}» фасуется не из «${barrel.item.name}»`);
    }
    usedKg += o.qty * sp.netQty;
  }

  // Бочка: списываем расход либо всё, кроме указанного остатка (разница — потери)
  const balance = await lotBalance(tx, barrel.id, 'NONE');
  let consumeKg = usedKg;
  if (doc.remainQty != null) {
    consumeKg = balance - doc.remainQty;
    if (consumeKg < usedKg - EPS) {
      throw new StockError(`В бочке ${round(balance)} кг: расход ${round(usedKg)} кг + остаток ${doc.remainQty} кг больше, чем было`);
    }
  }
  await consume(tx, doc.id, barrel.id, 'NONE', round(consumeKg), barrel.item.name);

  // Материалы и их средняя цена в этом документе
  const matCost = new Map<string, { cost: number | null }>();
  for (const m of materials) {
    if (!m.lotId) throw new StockError(`«${m.item.name}»: не выбран лот`);
    const lot = await tx.lot.findUnique({ where: { id: m.lotId } });
    if (lot?.itemId !== m.itemId) throw new StockError(`«${m.item.name}»: лот от другой позиции`);
    await consume(tx, doc.id, m.lotId, 'NONE', m.qty, m.item.name);
    const c = matCost.get(m.itemId) ?? { cost: 0 };
    c.cost = c.cost == null || lot.unitCost == null ? null : c.cost + lot.unitCost * m.qty;
    matCost.set(m.itemId, c);
  }

  // Полная стоимость материала (включая брак) делится на его норму по всем выпущенным SKU
  const matNorm = new Map<string, number>();
  for (const o of outputs) {
    for (const pm of specOf.get(o.itemId)!.materials) matNorm.set(pm.itemId, (matNorm.get(pm.itemId) ?? 0) + o.qty * pm.qtyPerUnit);
  }
  const semiKgCost = barrel.unitCost == null ? null : (barrel.unitCost * consumeKg) / usedKg;
  for (const o of outputs) {
    const sp = specOf.get(o.itemId)!;
    let unitCost: number | null = semiKgCost == null ? null : semiKgCost * sp.netQty!;
    for (const pm of sp.materials) {
      const c = matCost.get(pm.itemId);
      if (!c) continue;
      unitCost = unitCost == null || c.cost == null ? null : unitCost + (c.cost / matNorm.get(pm.itemId)!) * pm.qtyPerUnit;
    }
    const lot = await tx.lot.create({
      data: {
        number: await nextLotNumber(tx, 'PRODUCT'),
        itemId: o.itemId,
        expiresAt: barrel.expiresAt,
        unitCost: unitCost == null ? null : round(unitCost),
        parentLotId: barrel.id,
      },
    });
    await tx.stockDocLine.update({ where: { id: o.id }, data: { lotId: lot.id, state: 'UNLABELED' } });
    await tx.stockMove.create({ data: { docId: doc.id, lotId: lot.id, state: 'UNLABELED', qty: o.qty } });
  }
  await tx.stockDoc.update({ where: { id: doc.id }, data: { status: 'POSTED', postedAt: new Date() } });
}
