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
};

const EPS = 1e-6;

function datePart(d = new Date()): string {
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// Следующий номер вида «С-261007-03»: префикс + дата + порядковый за день.
async function nextNumber(
  prefix: string,
  findLast: (startsWith: string) => Promise<string | null>,
): Promise<string> {
  const base = `${prefix}-${datePart()}-`;
  const last = await findLast(base);
  const n = last ? parseInt(last.slice(base.length), 10) + 1 : 1;
  return base + String(n).padStart(2, '0');
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

// Проводит черновик: приход и начальные остатки создают лоты, корректировка двигает существующие.
export async function postDoc(tx: Tx, docId: string): Promise<void> {
  const doc = await tx.stockDoc.findUnique({
    where: { id: docId },
    include: { lines: { include: { item: true } } },
  });
  if (!doc) throw new StockError('Документ не найден');
  if (doc.status !== 'DRAFT') throw new StockError('Провести можно только черновик');
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
}

// Отмена проведённого документа: сторно всех его движений, если остатки позволяют.
export async function cancelDoc(tx: Tx, docId: string): Promise<void> {
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
  await tx.stockDoc.update({ where: { id: docId }, data: { status: 'CANCELLED' } });
}
