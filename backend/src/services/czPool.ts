import { Prisma } from '@prisma/client';

// База ЧЗ: коды принадлежат товару (CzBatch.itemId), а не макету этикетки. Макет (проект) — только оформление:
// на каком бы макете ни печаталась этикетка, код берётся из базы этого товара.

type Tx = Prisma.TransactionClient;

/** Забрать n свободных кодов товара — старые загрузки первыми; параллельные выдачи не берут одни и те же */
export function claimItemCodes(tx: Tx, itemId: string, n: number) {
  return tx.$queryRaw<{ id: string; pageIndex: number }[]>`
    SELECT c.id, c."pageIndex"
    FROM "CzCode" c JOIN "CzBatch" b ON b.id = c."czBatchId"
    WHERE b."itemId" = ${itemId} AND c.status = 'PENDING'
    ORDER BY b."uploadedAt" ASC, c."pageIndex" ASC
    LIMIT ${n}
    FOR UPDATE OF c SKIP LOCKED`;
}

/** Сколько свободных кодов у товара */
export const freeItemCodes = (tx: Tx | Prisma.DefaultPrismaClient | any, itemId: string): Promise<number> =>
  tx.czCode.count({ where: { status: 'PENDING', czBatch: { itemId } } });

export const NO_CODES_HINT = 'Загрузите коды в «Маркировка → База ЧЗ».';
