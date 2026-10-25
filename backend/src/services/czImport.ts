import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import prisma from '../prisma/client';
import { downloadFile } from './s3';
import { renderPdfPages } from './pdf';
import { decodeDataMatrix } from './datamatrix';
import { StockError } from './stock';

// Загрузка ЧЗ одним файлом на все SKU: код «01 + GTIN(14) + 21 + серийный…» → SKU по GTIN → база кодов SKU (проект этикетки)

export const gtinOf = (code: string): string | null => code.match(/^01(\d{14})/)?.[1] ?? null;

// EAN-13 / GTIN-14 → GTIN-14
const toGtin = (v: string | null | undefined): string | null => {
  const d = (v ?? '').trim();
  if (/^\d{14}$/.test(d)) return d;
  if (/^\d{13}$/.test(d)) return '0' + d;
  return null;
};

interface Target { itemId: string; name: string; projectId: string; source: 'gtin' | 'wb' | 'label' }

/**
 * GTIN → SKU с маркировкой. Приоритет: GTIN в карточке SKU → артикул WB (EAN) → штрихкод в макете этикетки.
 * Штрихкод макета, общий для нескольких SKU, не используется (неоднозначно).
 */
export async function gtinTargets(): Promise<Map<string, Target>> {
  const specs = await prisma.productSpec.findMany({
    where: { requiresCz: true, czProjectId: { not: null }, item: { archived: false } },
    include: { item: true, czProject: { include: { template: true } } },
  });
  const out = new Map<string, Target>();
  const fromLabel = new Map<string, Target[]>();
  for (const s of specs) {
    const t = { itemId: s.itemId, name: s.item.name, projectId: s.czProjectId! };
    const g = toGtin(s.gtin);
    if (g) out.set(g, { ...t, source: 'gtin' });
    const tpl = s.czProject?.template;
    const values = [tpl?.barcodeValue, ...(((tpl?.elements as any[]) ?? []).filter((e) => e.type === 'barcode').map((e) => e.value))];
    for (const v of values) {
      const lg = toGtin(v);
      if (lg) fromLabel.set(lg, [...(fromLabel.get(lg) ?? []).filter((x) => x.itemId !== s.itemId), { ...t, source: 'label' }]);
    }
  }
  for (const s of specs) {
    const g = toGtin(s.wbArticle);
    if (g && !out.has(g)) out.set(g, { itemId: s.itemId, name: s.item.name, projectId: s.czProjectId!, source: 'wb' });
  }
  for (const [g, list] of fromLabel) if (!out.has(g) && list.length === 1) out.set(g, list[0]);
  return out;
}

interface SkuResult { itemId: string; name: string; gtin: string; added: number; duplicates: number }
export interface ImportResult { bySku: SkuResult[]; unassigned: Record<string, string[]>; invalid: number; failedPages: number[] }

/** Раскладывает коды по SKU: новые — в базу SKU отдельной партией загрузки, повторы пропускаются. */
export async function distribute(codes: string[], label: string): Promise<ImportResult> {
  const targets = await gtinTargets();
  const groups = new Map<string, string[]>();
  let invalid = 0;
  for (const c of [...new Set(codes)]) {
    const g = gtinOf(c);
    if (!g) { invalid++; continue; }
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const res: ImportResult = { bySku: [], unassigned: {}, invalid, failedPages: [] };
  for (const [gtin, list] of groups) {
    const t = targets.get(gtin);
    if (!t) { res.unassigned[gtin] = list; continue; }
    res.bySku.push(await addCodes(t, gtin, list, label));
  }
  return res;
}

async function addCodes(t: { itemId: string; name: string; projectId: string }, gtin: string, list: string[], label: string): Promise<SkuResult> {
  // Повтор — код уже есть в базе любого SKU
  const existing = await prisma.czCode.findMany({ where: { code: { in: list } }, select: { code: true } });
  const known = new Set(existing.map((e) => e.code));
  const fresh = list.filter((c) => !known.has(c));
  if (fresh.length) {
    const fileHash = crypto.createHash('sha256').update(fresh.join('\n')).digest('hex');
    await prisma.czBatch.create({
      data: {
        itemId: t.itemId, projectId: t.projectId, s3Key: `csv:${label}`, totalCount: fresh.length, fileHash,
        codes: { createMany: { data: fresh.map((code, i) => ({ pageIndex: i + 1, code })) } },
      },
    });
  }
  return { itemId: t.itemId, name: t.name, gtin, added: fresh.length, duplicates: list.length - fresh.length };
}

/** Коды с неизвестным GTIN → выбранный SKU; GTIN запоминается в карточке SKU. */
export async function assignUnassigned(importId: string, gtin: string, itemId: string): Promise<SkuResult> {
  const imp = await prisma.czImport.findUnique({ where: { id: importId } });
  const result = imp?.result as unknown as ImportResult | null;
  const list = result?.unassigned?.[gtin];
  if (!imp || !result || !list) throw new StockError('Нераспределённых кодов с таким GTIN нет');
  const spec = await prisma.productSpec.findUnique({ where: { itemId }, include: { item: true } });
  if (!spec?.requiresCz || !spec.czProjectId) throw new StockError('Для этого SKU не включена маркировка ЧЗ');
  await prisma.productSpec.updateMany({ where: { gtin }, data: { gtin: null } });
  await prisma.productSpec.update({ where: { itemId }, data: { gtin } });
  const r = await addCodes({ itemId, name: spec.item.name, projectId: spec.czProjectId }, gtin, list, `import-${importId}`);
  delete result.unassigned[gtin];
  result.bySku.push(r);
  await prisma.czImport.update({ where: { id: importId }, data: { result: result as any } });
  return r;
}

/** Фоновая обработка PDF: страницы → DataMatrix → текст кода → раскладка по SKU. */
export async function runPdfImport(importId: string): Promise<void> {
  const imp = await prisma.czImport.findUnique({ where: { id: importId } });
  if (!imp?.s3Key || imp.status !== 'processing') return;
  try {
    const pdf = await downloadFile(imp.s3Key);
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    await prisma.czImport.update({ where: { id: importId }, data: { pages } });
    const codes: string[] = [];
    const failed: number[] = [];
    const CHUNK = 20;
    for (let first = 1; first <= pages; first += CHUNK) {
      const chunk = Array.from({ length: Math.min(CHUNK, pages - first + 1) }, (_, i) => first + i);
      const rasters = await renderPdfPages(pdf, chunk, { density: 250, timeoutMs: 120_000 });
      await Promise.all(chunk.map(async (pg) => {
        try {
          const text = await decodeDataMatrix(rasters.get(pg)!);
          if (text) codes.push(text); else failed.push(pg);
        } catch { failed.push(pg); }
      }));
      await prisma.czImport.update({ where: { id: importId }, data: { decoded: Math.min(pages, first + CHUNK - 1) } });
    }
    const result = await distribute(codes, `import-${importId}`);
    result.failedPages = failed.sort((a, b) => a - b);
    await prisma.czImport.update({ where: { id: importId }, data: { status: 'done', result: result as any, finishedAt: new Date() } });
  } catch (e: any) {
    await prisma.czImport.update({ where: { id: importId }, data: { status: 'error', error: String(e?.message ?? e).slice(0, 500), finishedAt: new Date() } });
  }
}
