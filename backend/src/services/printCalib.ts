import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getSetting, setSetting } from './ozon';

// Калибровка принтера этикеток: у термопринтера по краям непечатаемая полоса и сдвиг начала печати —
// в превью всё на месте, а на этикетке срезается край. Сдвиг и масштаб применяются ко всем PDF этикеток
// при скачивании (уже сформированные тиражи перегенерировать не нужно). Большие страницы (акты, A4) не трогаем.

export interface PrintCalib { dxMm: number; dyMm: number; scalePct: number }
const KEY = 'print.calibration';
const DEF: PrintCalib = { dxMm: 0, dyMm: 0, scalePct: 100 };
const MM = 72 / 25.4;
const LABEL_MAX_MM = 80; // только этикетки 58×40, 75×… — не акты и не A4

export const getCalib = async (): Promise<PrintCalib> => ({ ...DEF, ...(await getSetting<Partial<PrintCalib>>(KEY, DEF)) });
export const setCalib = (c: PrintCalib) => setSetting(KEY, c);
const identity = (c: PrintCalib) => !c.dxMm && !c.dyMm && c.scalePct === 100;

/** Применить калибровку к PDF этикеток: dx — вправо, dy — вверх (мм), масштаб — от центра страницы */
export async function calibrate(buf: Buffer | Uint8Array, c?: PrintCalib): Promise<Buffer> {
  c ??= await getCalib();
  if (identity(c)) return Buffer.from(buf);
  const src = await PDFDocument.load(buf);
  const pages = src.getPages();
  // повёрнутые страницы при переносе потеряли бы поворот — такой файл отдаём как есть
  if (pages.some((p) => p.getRotation().angle % 360 !== 0)) return Buffer.from(buf);
  const out = await PDFDocument.create();
  const embedded = await out.embedPages(pages);
  const s = c.scalePct / 100;
  pages.forEach((p, i) => {
    const { width: w, height: h } = p.getSize();
    const page = out.addPage([w, h]);
    if (w > LABEL_MAX_MM * MM || h > LABEL_MAX_MM * MM) { page.drawPage(embedded[i]); return; }
    page.drawPage(embedded[i], { x: (w - w * s) / 2 + c!.dxMm * MM, y: (h - h * s) / 2 + c!.dyMm * MM, xScale: s, yScale: s });
  });
  return Buffer.from(await out.save());
}

/** Тестовая этикетка: рамки в 1, 2 и 3 мм от края и подписи — по отпечатку видно, сколько срезает принтер с каждой стороны */
export async function testLabel(widthMm = 58, heightMm = 40): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const W = widthMm * MM, H = heightMm * MM;
  const page = doc.addPage([W, H]);
  const black = rgb(0, 0, 0);
  for (const mm of [0.3, 1, 2, 3]) {
    const d = mm * MM;
    page.drawRectangle({ x: d, y: d, width: W - 2 * d, height: H - 2 * d, borderColor: black, borderWidth: mm === 0.3 ? 0.8 : 0.4, borderDashArray: mm === 3 ? [2, 2] : undefined });
  }
  // подписи у левого и нижнего края: какая рамка видна — столько мм принтер печатает
  const t = (s: string, x: number, y: number, size = 4.5) => page.drawText(s, { x, y, size, font, color: black });
  t('1', 1.1 * MM, H / 2, 3.5); t('2', 2.1 * MM, H / 2 - 5, 3.5); t('3', 3.1 * MM, H / 2 - 10, 3.5);
  t('1', W / 2, 1.1 * MM, 3.5); t('2', W / 2 + 5, 2.1 * MM, 3.5); t('3', W / 2 + 10, 3.1 * MM, 3.5);
  t(`TEST ${widthMm}x${heightMm} mm`, W / 2 - 22, H / 2 + 4, 6);
  t('outer line = label edge; 1/2/3 = mm from edge', W / 2 - 50, H / 2 - 4, 4);
  // перекрестие в центре — для проверки сдвига
  page.drawLine({ start: { x: W / 2 - 6, y: H / 2 - 12 }, end: { x: W / 2 + 6, y: H / 2 - 12 }, thickness: 0.4, color: black });
  page.drawLine({ start: { x: W / 2, y: H / 2 - 18 }, end: { x: W / 2, y: H / 2 - 6 }, thickness: 0.4, color: black });
  return calibrate(Buffer.from(await doc.save()));
}
