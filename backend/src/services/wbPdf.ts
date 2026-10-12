import { PDFDocument, PDFEmbeddedPage, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
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

// Стикеры заданий: «файл.pdf#страница» (загружены из кабинета WB) или PNG из API.
// Страницы одного файла встраиваются одним вызовом — шрифты стикеров не дублируются.
async function stickerSource(out: PDFDocument, keys: string[], embed: boolean) {
  const pdfPages = new Map<string, number[]>();
  for (const k of keys) {
    const [file, page] = k.split('#');
    if (page != null) pdfPages.set(file, [...(pdfPages.get(file) ?? []), Number(page)]);
  }
  const copied = new Map<string, PDFPage>();
  const embedded = new Map<string, PDFEmbeddedPage>();
  for (const [file, pages] of pdfPages) {
    const src = await PDFDocument.load(await downloadFile(file));
    const uniq = [...new Set(pages)];
    if (embed) (await out.embedPages(uniq.map((i) => src.getPage(i)))).forEach((e, j) => embedded.set(`${file}#${uniq[j]}`, e));
    else (await out.copyPages(src, uniq)).forEach((p, j) => copied.set(`${file}#${uniq[j]}`, p));
  }
  return { copied, embedded };
}

async function drawSticker(out: PDFDocument, key: string, src: Awaited<ReturnType<typeof stickerSource>>, size?: [number, number]) {
  const plain = src.copied.get(key);
  if (plain) { out.addPage(plain); return; }
  const [w, h] = size ?? [58 * MM, 40 * MM];
  const emb = src.embedded.get(key);
  const page = out.addPage([w, h]);
  // Вписываем в размер объединённой этикетки — один рулон для обоих стикеров
  const fit = (iw: number, ih: number) => { const k = Math.min(w / iw, h / ih); return { x: (w - iw * k) / 2, y: (h - ih * k) / 2, width: iw * k, height: ih * k }; };
  if (emb) { page.drawPage(emb, fit(emb.width, emb.height)); return; }
  const img = await out.embedPng(await downloadFile(key));
  page.drawImage(img, fit(img.width, img.height));
}

// Номер стикера задания (0503) в правом верхнем углу объединённой этикетки
function stampNumber(page: PDFPage, font: PDFFont, text: string) {
  const { width, height } = page.getSize();
  const size = 7;
  const tw = font.widthOfTextAtSize(text, size);
  page.drawRectangle({ x: width - tw - 4, y: height - size - 3, width: tw + 3, height: size + 2.5, color: rgb(1, 1, 1) });
  page.drawText(text, { x: width - tw - 2.5, y: height - size - 1.5, size, font, color: rgb(0, 0, 0) });
}

/** Стикеры заданий WB в порядке листа подбора (из API или загруженные из кабинета). */
export async function wbStickersPdf(supplyId: string): Promise<Buffer> {
  const orders = (await sortedOrders(supplyId)).filter((o) => o.stickerS3Key);
  if (!orders.length) throw new StockError('Стикеров заданий нет — загрузите PDF стикеров из кабинета WB');
  const out = await PDFDocument.create();
  const src = await stickerSource(out, orders.map((o) => o.stickerS3Key!), false);
  for (const o of orders) await drawSticker(out, o.stickerS3Key!, src);
  return Buffer.from(await out.save());
}

/**
 * Объединённые стикеры (макет этикетки SKU: EAN-13 + ЧЗ + партия + годен до) в порядке листа подбора,
 * с номером стикера задания в углу. Страницы берутся из уже сгенерированных тиражей:
 * номер страницы = позиция кода в тираже (тот же порядок, что у генератора).
 * pairs — перед каждым объединённым стикером идёт стикер задания WB того же размера.
 */
export async function comboPdf(supplyId: string, pairs = false): Promise<Buffer> {
  const all = await sortedOrders(supplyId);
  const orders = all.filter((o) => o.czCode?.outputBatchId);
  const batchIds = [...new Set(orders.map((o) => o.czCode!.outputBatchId!))];
  const batches = await prisma.outputBatch.findMany({ where: { id: { in: batchIds } } });
  const notReady = batches.find((b) => b.jobStatus !== 'done' || !b.s3Key);
  if (notReady) throw new StockError(notReady.jobStatus === 'error' ? 'Ошибка генерации этикеток ЧЗ — см. «Маркировка → Промаркированы»' : 'Этикетки ЧЗ ещё генерируются, повторите через минуту');
  const pageOf = new Map<string, number>();
  const srcOf = new Map<string, PDFDocument>();
  for (const b of batches) {
    const codes = await prisma.czCode.findMany({
      where: { outputBatchId: b.id }, select: { id: true },
      orderBy: [{ czBatch: { uploadedAt: 'asc' } }, { pageIndex: 'asc' }, { id: 'asc' }],
    });
    codes.forEach((c, i) => pageOf.set(c.id, i));
    srcOf.set(b.id, await PDFDocument.load(await downloadFile(b.s3Key)));
  }
  const out = await PDFDocument.create();
  // Страницы одного тиража копируются одним вызовом — шрифты и картинки макета не дублируются на каждую страницу
  const copied = new Map<string, PDFPage>();
  for (const [bid, src] of srcOf) {
    const need = orders.filter((o) => o.czCode!.outputBatchId === bid)
      .map((o) => ({ codeId: o.czCode!.id, idx: pageOf.get(o.czCode!.id) }))
      .filter((x): x is { codeId: string; idx: number } => x.idx != null && x.idx < src.getPageCount());
    const pages = await out.copyPages(src, need.map((x) => x.idx));
    need.forEach((x, i) => copied.set(x.codeId, pages[i]));
  }
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const stickers = pairs ? await stickerSource(out, all.map((o) => o.stickerS3Key).filter((x): x is string => !!x), true) : null;
  for (const o of pairs ? all : orders) {
    const p = o.czCode ? copied.get(o.czCode.id) : undefined;
    // Задание без ЧЗ или без стикера WB — печатается то, что есть
    if (pairs && o.stickerS3Key) {
      const size = p ? [p.getWidth(), p.getHeight()] as [number, number] : undefined;
      await drawSticker(out, o.stickerS3Key, stickers!, size);
    }
    if (!p) continue;
    out.addPage(p);
    if (o.stickerB) stampNumber(p, font, o.stickerB);
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
    { header: 'КИЗ', key: 'kiz', width: 95 },
    { header: 'Бренд', key: 'brand', width: 12 },
    { header: 'Наименование', key: 'name', width: 50 },
    { header: 'Артикул продавца', key: 'article', width: 18 },
    { header: 'Поставка', key: 'supply', width: 18 },
    { header: 'Партия', key: 'lot', width: 14 },
    { header: 'Отправлен в WB', key: 'sent', width: 18 },
    { header: 'КИ (без криптохвоста)', key: 'ki', width: 40 },
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
        kiz: xlsxCode(o.czCode!.code!), ki: kiOf(o.czCode!.code!),
        brand: 'Helmitex', name: o.itemName ?? '', article: o.article, supply: supplyId,
        lot: o.lotId ? lotNo.get(o.lotId) ?? '' : '', sent: o.kizSentAt ? o.kizSentAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '',
      });
    }
  }
  ws.getColumn('kiz').numFmt = '@';
  ws.getColumn('ki').numFmt = '@';
  return Buffer.from(await wbk.xlsx.writeBuffer());
}

// Полный код ЧЗ для ячейки Excel: GS (0x1D) недопустим в XML, в OOXML он записывается как _x001D_ —
// Excel показывает и копирует его как настоящий разделитель (так же он хранит отсканированный код)
const xlsxCode = (code: string) => code.replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_').replace(/\x1d/g, '_x001D_');
const kiOf = (code: string) => code.split('\x1d')[0];

/** Коды ЧЗ в .xlsx: A — код полностью (с проверочным кодом 91 и криптоподписью 92), B — КИ (для ввода в оборот). */
export async function kiXlsx(codes: string[]): Promise<Buffer> {
  const wbk = new ExcelJS.Workbook();
  const ws = wbk.addWorksheet('Коды');
  ws.columns = [
    { header: 'Код маркировки полностью', key: 'full', width: 95, style: { numFmt: '@' } },
    { header: 'КИ (без криптохвоста)', key: 'ki', width: 40, style: { numFmt: '@' } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const c of codes) ws.addRow({ full: xlsxCode(c), ki: kiOf(c) });
  return Buffer.from(await wbk.xlsx.writeBuffer());
}
