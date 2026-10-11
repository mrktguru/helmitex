import { PDFDocument, PDFPage } from 'pdf-lib';
import ExcelJS from 'exceljs';
import prisma from '../prisma/client';
import { downloadFile } from './s3';
import { StockError } from './stock';
import { printOrder, wb } from './wb';

const MM = 72 / 25.4;

async function pngsToPdf(pngs: Buffer[], wMm = 58, hMm = 40): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const png of pngs) {
    const img = await doc.embedPng(png);
    const page = doc.addPage([wMm * MM, hMm * MM]);
    page.drawImage(img, { x: 0, y: 0, width: wMm * MM, height: hMm * MM });
  }
  return Buffer.from(await doc.save());
}

async function sortedOrders(supplyId: string) {
  const orders = await prisma.wbOrder.findMany({ where: { supplyId, canceled: false }, include: { czCode: true } });
  const items = await prisma.item.findMany({ where: { id: { in: orders.map((o) => o.itemId).filter((x): x is string => !!x) } } });
  const name = new Map(items.map((i) => [i.id, i.name]));
  return printOrder(orders.map((o) => ({ ...o, itemName: o.itemId ? name.get(o.itemId) ?? null : null })));
}

/** Стикеры заданий WB 58×40 в порядке листа подбора. */
export async function wbStickersPdf(supplyId: string): Promise<Buffer> {
  const orders = (await sortedOrders(supplyId)).filter((o) => o.stickerS3Key);
  if (!orders.length) throw new StockError('Стикеры заданий не получены из WB — скачайте их в кабинете WB');
  return pngsToPdf(await Promise.all(orders.map((o) => downloadFile(o.stickerS3Key!))));
}

/**
 * Объединённые стикеры (макет этикетки SKU: EAN-13 + ЧЗ + партия + годен до) в порядке листа подбора.
 * Страницы берутся из уже сгенерированных тиражей: номер страницы = позиция кода в тираже (тот же порядок, что у генератора).
 * pairs — после каждого стикера WB идёт его объединённый стикер.
 */
export async function comboPdf(supplyId: string, pairs = false): Promise<Buffer> {
  const orders = (await sortedOrders(supplyId)).filter((o) => o.czCode?.outputBatchId || (pairs && o.stickerS3Key));
  const batchIds = [...new Set(orders.map((o) => o.czCode?.outputBatchId).filter((x): x is string => !!x))];
  const batches = await prisma.outputBatch.findMany({ where: { id: { in: batchIds } } });
  const notReady = batches.find((b) => b.jobStatus !== 'done' || !b.s3Key);
  if (notReady) throw new StockError(notReady.jobStatus === 'error' ? 'Ошибка генерации этикеток ЧЗ — см. «Маркировка → Промаркированы»' : 'Этикетки ЧЗ ещё генерируются, повторите через минуту');
  const pageOf = new Map<string, number>();
  const pdfOf = new Map<string, PDFDocument>();
  for (const b of batches) {
    const codes = await prisma.czCode.findMany({
      where: { outputBatchId: b.id }, select: { id: true },
      orderBy: [{ czBatch: { uploadedAt: 'asc' } }, { pageIndex: 'asc' }, { id: 'asc' }],
    });
    codes.forEach((c, i) => pageOf.set(c.id, i));
    pdfOf.set(b.id, await PDFDocument.load(await downloadFile(b.s3Key)));
  }
  const out = await PDFDocument.create();
  for (const o of orders) {
    if (pairs && o.stickerS3Key) {
      const img = await out.embedPng(await downloadFile(o.stickerS3Key));
      const page: PDFPage = out.addPage([58 * MM, 40 * MM]);
      page.drawImage(img, { x: 0, y: 0, width: 58 * MM, height: 40 * MM });
    }
    const bid = o.czCode?.outputBatchId;
    if (!bid) continue;
    const src = pdfOf.get(bid)!;
    const idx = pageOf.get(o.czCode!.id);
    if (idx == null || idx >= src.getPageCount()) continue;
    const [p] = await out.copyPages(src, [idx]);
    out.addPage(p);
  }
  if (!out.getPageCount()) throw new StockError('Нет объединённых стикеров: коды ЧЗ ещё не назначены');
  return Buffer.from(await out.save());
}

/** Стикеры грузомест (QR WB). */
export async function trbxPdf(supplyId: string): Promise<Buffer> {
  const { trbxes } = await wb<{ trbxes: { id: string }[] }>('GET', `/api/v3/supplies/${encodeURIComponent(supplyId)}/trbx`, undefined, supplyId, false);
  if (!trbxes?.length) throw new StockError('В поставке нет грузомест');
  const r = await wb<{ stickers: { file: string }[] }>('POST', `/api/v3/supplies/${encodeURIComponent(supplyId)}/trbx/stickers?type=png`,
    { trbxIds: trbxes.map((t) => t.id) }, supplyId, false);
  return pngsToPdf((r.stickers ?? []).map((s) => Buffer.from(s.file, 'base64')));
}

/** QR поставки — доступен после передачи в доставку. */
export async function supplyQrPdf(supplyId: string): Promise<Buffer> {
  const r = await wb<{ file: string }>('GET', `/api/v3/supplies/${encodeURIComponent(supplyId)}/barcode?type=png`, undefined, supplyId, false);
  return pngsToPdf([Buffer.from(r.file, 'base64')]);
}

/** Таблица использованных ЧЗ в формате шаблона WB (template-sgtin): № задания, Стикер, КИЗ, Бренд, Наименование, Артикул. */
export async function czXlsx(supplyIds: string[]): Promise<Buffer> {
  const wbk = new ExcelJS.Workbook();
  const ws = wbk.addWorksheet('Лист1');
  ws.columns = [
    { header: '№ задания', key: 'id', width: 14 },
    { header: 'Стикер', key: 'sticker', width: 14 },
    { header: 'КИЗ', key: 'kiz', width: 40 },
    { header: 'Бренд', key: 'brand', width: 12 },
    { header: 'Наименование', key: 'name', width: 50 },
    { header: 'Артикул продавца', key: 'article', width: 18 },
    { header: 'Поставка', key: 'supply', width: 18 },
    { header: 'Партия', key: 'lot', width: 14 },
    { header: 'Отправлен в WB', key: 'sent', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const supplyId of supplyIds) {
    const orders = await sortedOrders(supplyId);
    const lots = await prisma.lot.findMany({ where: { id: { in: orders.map((o) => o.lotId).filter((x): x is string => !!x) } } });
    const parentIds = lots.map((l) => l.parentLotId).filter((x): x is string => !!x);
    const parents = new Map((await prisma.lot.findMany({ where: { id: { in: parentIds } } })).map((l) => [l.id, l.number]));
    const lotNo = new Map(lots.map((l) => [l.id, (l.parentLotId && parents.get(l.parentLotId)) || l.number]));
    for (const o of orders.filter((x) => x.czCode?.code)) {
      ws.addRow({
        id: Number(o.id), sticker: `${o.stickerA ?? ''}${o.stickerB ?? ''}`,
        // В xlsx нельзя управляющие символы (GS 0x1D): в таблицу идёт идентификатор 01+GTIN+21+серийный номер, без криптохвоста
        kiz: o.czCode!.code!.split('\x1d')[0],
        brand: 'Helmitex', name: o.itemName ?? '', article: o.article, supply: supplyId,
        lot: o.lotId ? lotNo.get(o.lotId) ?? '' : '', sent: o.kizSentAt ? o.kizSentAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '',
      });
    }
  }
  ws.getColumn('kiz').numFmt = '@';
  return Buffer.from(await wbk.xlsx.writeBuffer());
}
