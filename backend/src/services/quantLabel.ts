import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bwipjs from 'bwip-js';
import { downloadFile } from './s3';

const MM_TO_PT = 2.8346;
const FONT_DIR = path.resolve(__dirname, '../../assets/fonts');

export interface QuantLabelData {
  number: string;
  productName: string;
  units: number;
  lotNumber: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export const barcodeText = (number: string) => number.replace(/^К/, 'K');

function fitText(text: string, font: PDFFont, maxSize: number, maxWidth: number): number {
  let size = maxSize;
  while (size > 4 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

// Этикетка кванта: номер крупно, Code128 номера, SKU, количество, партия, даты. Одна страница на квант.
export async function renderQuantLabels(quants: QuantLabelData[], widthMm: number, heightMm: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'PTSans-Regular.ttf')), { subset: false });
  const bold = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'PTSans-Bold.ttf')), { subset: false });
  const W = widthMm * MM_TO_PT;
  const H = heightMm * MM_TO_PT;
  const pad = 2.5 * MM_TO_PT;
  const inner = W - 2 * pad;
  const black = rgb(0, 0, 0);
  const d = (x: Date | null) => (x ? x.toLocaleDateString('ru-RU') : '—');

  for (const q of quants) {
    const page = doc.addPage([W, H]);
    let y = H - pad;

    const numSize = fitText(q.number, bold, H * 0.16, inner);
    y -= numSize * 0.8;
    page.drawText(q.number, { x: pad, y, size: numSize, font: bold, color: black });

    // Code128 не кодирует кириллицу: в штрихкоде «К» заменяется латинской K (поиск понимает оба варианта)
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: barcodeText(q.number), scale: 4, height: 10, includetext: false });
    const img = await doc.embedPng(png);
    const bcH = H * 0.3;
    y -= 1.5 * MM_TO_PT + bcH;
    page.drawImage(img, { x: pad, y, width: inner, height: bcH });

    const nameSize = fitText(q.productName, bold, H * 0.09, inner);
    y -= 1.5 * MM_TO_PT + nameSize * 0.8;
    page.drawText(q.productName, { x: pad, y, size: nameSize, font: bold, color: black });

    const lines = [
      `${q.units} шт · партия ${q.lotNumber}`,
      `Собран ${d(q.createdAt)} · годен до ${d(q.expiresAt)}`,
    ];
    for (const line of lines) {
      const s = fitText(line, regular, H * 0.075, inner);
      y -= s * 1.25;
      if (y < pad * 0.5) break;
      page.drawText(line, { x: pad, y, size: s, font: regular, color: black });
    }
  }
  return Buffer.from(await doc.save());
}

// Склейка готовых PDF этикеток ЧЗ (по кванту) в один файл в заданном порядке
export async function mergePdfs(s3Keys: string[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const key of s3Keys) {
    const src = await PDFDocument.load(await downloadFile(key));
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}
