import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import prisma from '../prisma/client';
import { downloadFile } from './s3';
import { encodeDataMatrix } from './datamatrix';
import { czCacheKey, getCleanCzPngs } from './czRender';
import { lotLabelVars } from './marking';

// Этикетка на тубу 30×20 мм: код ЧЗ (DataMatrix), знак ЕАС, номер партии и срок годности.
// Печатается из любого тиража ЧЗ (маркировка, кванты, WB) — те же коды, другой формат.

const MM = 72 / 25.4;
const FONT_DIR = path.resolve(__dirname, '../../assets/fonts');
const EAC_SVG = path.resolve(__dirname, '../../assets/eac-icon.svg');
export const TUBE = { widthMm: 30, heightMm: 20 };

let eacPng: Buffer | null = null;
// Знак ЕАС без белых полей — чтобы вписать по размеру самого знака
async function eac(): Promise<Buffer> {
  if (!eacPng) {
    const svg = fs.readFileSync(EAC_SVG, 'utf-8').replace(/width="[^"]*"/, 'width="600"').replace(/height="[^"]*"/, 'height="600"');
    eacPng = await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).trim({ threshold: 10 }).png().toBuffer();
  }
  return eacPng;
}

const fit = (t: string, f: PDFFont, max: number, w: number) => { let s = max; while (s > 3 && f.widthOfTextAtSize(t, s) > w) s -= 0.25; return s; };

export interface TubeLabelVars { lot?: string | null; expiry?: string | null }

/** PDF этикеток 30×20 по кодам ЧЗ (порядок кодов = порядок страниц).
 *  Партия и срок — у каждого кода свои: из тиража, по которому код выдан (переменные на момент печати), иначе из партии ГП. */
export async function tubeLabelsPdf(codeIds: string[], override?: TubeLabelVars): Promise<Buffer> {
  const rows = await prisma.czCode.findMany({
    where: { id: { in: codeIds } },
    select: { id: true, code: true, czBatchId: true, pageIndex: true, outputBatch: { select: { lotId: true, variables: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lotVars = new Map<string, Record<string, string>>();
  const varsOf = async (c: (typeof rows)[number]): Promise<TubeLabelVars> => {
    if (override) return override;
    const v = (c.outputBatch?.variables ?? {}) as Record<string, string>;
    let lv: Record<string, string> = {};
    const lotId = c.outputBatch?.lotId;
    if (lotId && (!v.lot || !v.expiry)) {
      if (!lotVars.has(lotId)) lotVars.set(lotId, await prisma.$transaction((tx) => lotLabelVars(tx, lotId)));
      lv = lotVars.get(lotId)!;
    }
    return { lot: v.lot ?? v.batch ?? lv.lot ?? null, expiry: v.expiry ?? lv.expiry ?? v.expiry_month ?? lv.expiry_month ?? null };
  };
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'PTSans-Regular.ttf')), { subset: false });
  const bold = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'PTSans-Bold.ttf')), { subset: false });
  const eacImg = await doc.embedPng(await eac());
  const W = TUBE.widthMm * MM, H = TUBE.heightMm * MM;
  const black = rgb(0, 0, 0);

  // Раскладка, мм: DataMatrix 15×15 слева; справа колонка 10,5 мм — ЕАС, партия, годен до. Поля ≥1,5 мм.
  const dm = 15 * MM, dmX = 1.6 * MM, dmY = (H - dm) / 2;
  const colX = dmX + dm + 1.4 * MM, colW = W - colX - 1.3 * MM;

  // Коды из PDF Честного знака, которые ещё ни разу не печатались, не расшифрованы — расшифровать заранее, пачкой по исходному PDF
  const raw = new Map<string, Buffer>();
  const undecoded = rows.filter((r) => !r.code);
  for (const czBatchId of [...new Set(undecoded.map((r) => r.czBatchId))]) {
    const pages = undecoded.filter((r) => r.czBatchId === czBatchId).map((r) => r.pageIndex);
    const cb = await prisma.czBatch.findUnique({ where: { id: czBatchId } });
    if (!cb?.s3Key || cb.s3Key.startsWith('csv:')) continue;
    const pngs = await getCleanCzPngs(czBatchId, pages, await downloadFile(cb.s3Key));
    for (const [pg, png] of pngs) raw.set(`${czBatchId}:${pg}`, png);
  }

  for (const id of codeIds) {
    const c = byId.get(id);
    if (!c) continue;
    // Код расшифрован — кодируем заново чисто; нет — очищенная картинка из кэша/расшифровки
    const png = c.code ? await encodeDataMatrix(c.code, 8)
      : raw.get(`${c.czBatchId}:${c.pageIndex}`) ?? await downloadFile(czCacheKey(c.czBatchId, c.pageIndex));
    const vars = await varsOf(c);
    const page = doc.addPage([W, H]);
    page.drawImage(await doc.embedPng(png), { x: dmX, y: dmY, width: dm, height: dm });

    // ЕАС вверху колонки, по ширине колонки
    // ЕАС по высоте 5 мм (знак вытянут вверх), но не шире колонки
    let eH = 5 * MM, eW = eH * eacImg.width / eacImg.height;
    if (eW > colW) { eW = colW; eH = eW * eacImg.height / eacImg.width; }
    const top = dmY + dm;
    page.drawImage(eacImg, { x: colX + (colW - eW) / 2, y: top - eH, width: eW, height: eH });

    let y = top - eH - 1.6 * MM;
    const line = (label: string, value: string | null | undefined) => {
      if (!value) return;
      page.drawText(label, { x: colX, y, size: 4, font: regular, color: black });
      y -= 2.2 * MM;
      const s = fit(value, bold, 6.5, colW);
      page.drawText(value, { x: colX, y, size: s, font: bold, color: black });
      y -= 2.3 * MM;
    };
    line('Партия', vars.lot);
    line('Годен до', vars.expiry);
  }
  if (!doc.getPageCount()) throw new Error('Нет кодов для этикеток');
  return Buffer.from(await doc.save());
}

/** Коды тиражей ЧЗ (OutputBatch) по порядку */
export async function batchCodeIds(batchIds: string[]): Promise<string[]> {
  const batches = await prisma.outputBatch.findMany({ where: { id: { in: batchIds } }, include: { codes: { select: { id: true, pageIndex: true }, orderBy: { pageIndex: 'asc' } } } });
  const order = new Map(batchIds.map((b, i) => [b, i]));
  batches.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return batches.flatMap((b) => b.codes.map((c) => c.id));
}
