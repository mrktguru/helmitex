import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { PDFDocument, rgb, StandardFonts, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import prisma from '../prisma/client';
import { downloadFile, uploadFile } from '../services/s3';
import { getCleanCzPng } from '../services/czRender';
import { drawEan13Vector } from '../services/barcode';

const MM_TO_PT = 2.8346;
const EAC_SVG_PATH = path.resolve(__dirname, '../../assets/eac-icon.svg');

async function renderEacPng(color: string, widthPx: number, heightPx: number): Promise<Buffer> {
  let svgText = fs.readFileSync(EAC_SVG_PATH, 'utf-8');
  // Replace intrinsic width/height with pixel values so sharp rasterizes at exactly our dimensions.
  // Without this, librsvg may use the SVG's declared "55mm × 55mm" dimensions before resize.
  svgText = svgText
    .replace(/width="[^"]*"/, `width="${widthPx}"`)
    .replace(/height="[^"]*"/, `height="${heightPx}"`);
  if (color !== '#000000' && color !== '#000') {
    svgText = svgText.replace(/fill:#000000/g, `fill:${color}`);
  }
  // Flatten on white to eliminate semi-transparent edge pixels that PDF viewers
  // render as a gray halo. The SVG already has a white background rect, so this
  // does not change the visible appearance.
  return sharp(Buffer.from(svgText))
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Word-wraps a single paragraph to fit within maxWidthPt.
 * Returns array of lines. Never splits inside a word.
 */
function wrapParagraph(text: string, font: PDFFont, size: number, maxWidthPt: number): string[] {
  if (maxWidthPt <= 0 || !text) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidthPt) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      // If single word is wider than block, just push it as-is (better than dropping)
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [text];
}

/** Split text on \n then word-wrap each paragraph to maxWidthPt. */
function wrapText(rawText: string, font: PDFFont, size: number, maxWidthPt: number): string[] {
  // Apply a correction factor: browser-rendered PT Sans is ~4% wider than
  // what pdf-lib measures from TTF advance widths, causing PDF to fit more
  // words per line than the browser shows. Reducing effective blockW by 4%
  // makes PDF wrapping match the browser layout.
  const effectiveWidth = maxWidthPt * 0.96;
  const paragraphs = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (effectiveWidth <= 0) return paragraphs;
  const result: string[] = [];
  for (const para of paragraphs) {
    if (!para.trim()) { result.push(''); continue; }
    for (const line of wrapParagraph(para, font, size, effectiveWidth)) result.push(line);
  }
  return result;
}

interface JobData {
  outputBatchId: string;
  projectId: string;
  codeIds: string[];
}

interface LabelElement {
  id: string;
  type: 'text' | 'barcode' | 'image' | 'rect' | 'eac' | 'variable';
  xMm: number;
  yMm: number;
  widthMm?: number;
  heightMm?: number;
  text?: string;
  /** Variable key (for type='variable'); looked up in template.variables. */
  key?: string;
  /** Fallback shown if variable value is empty. */
  placeholder?: string;
  fontSizePt?: number;
  bold?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right';
  fitToBlock?: boolean;
  /** Pre-computed line breaks from browser canvas — use directly in PDF for WYSIWYG accuracy. */
  _wrappedLines?: string[];
  /** Browser-resolved font size in pt (accounts for fit-to-block + correct zoom math). */
  _resolvedFontSizePt?: number;
  value?: string;
  s3Key?: string;
  strokeColor?: string;
  fillColor?: string | null;
  strokeWidthPt?: number;
}

interface CzArea {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const worker = new Worker<JobData>(
  'pdf-generation',
  async (job) => {
    const { outputBatchId, projectId } = job.data;

    await prisma.outputBatch.update({
      where: { id: outputBatchId },
      data: { jobStatus: 'processing' },
    });

    try {
      // Load template
      const template = await prisma.labelTemplate.findUnique({ where: { projectId } });
      if (!template) throw new Error('Template not found');

      const elements = template.elements as unknown as LabelElement[];
      const czArea = template.czArea as unknown as CzArea;
      const templateVariables = (template.variables as Record<string, string> | null) ?? {};
      const widthPt = template.widthMm * MM_TO_PT;
      const heightPt = template.heightMm * MM_TO_PT;

      // Load all CZ codes for this batch
      const codes = await prisma.czCode.findMany({
        where: { outputBatchId },
        include: { czBatch: true },
        orderBy: { pageIndex: 'asc' },
      });

      // Group codes by czBatch to avoid downloading same PDF multiple times.
      // CSV-sourced batches (s3Key starts with "csv:") have no PDF to download —
      // their DataMatrix images are re-encoded directly from the stored code text.
      const batchPdfs = new Map<string, Buffer>();
      for (const code of codes) {
        const key = code.czBatch.s3Key;
        if (key.startsWith('csv:') || !key) continue;
        if (!batchPdfs.has(code.czBatchId)) {
          const buf = await downloadFile(key);
          batchPdfs.set(code.czBatchId, buf);
        }
      }

      // Asset cache to avoid redundant S3 downloads
      const assetCache = new Map<string, Buffer>();

      const outputDoc = await PDFDocument.create();
      outputDoc.registerFontkit(fontkit);

      // Bundled PT Sans — same font used in the browser editor for WYSIWYG fidelity.
      // Falls back to DejaVu / Noto (system) if somehow missing, then to Helvetica.
      const BUNDLED_FONT_DIR = path.resolve(__dirname, '../../assets/fonts');
      const ttfCandidates = [
        process.env.PDF_FONT_REGULAR,
        path.join(BUNDLED_FONT_DIR, 'PTSans-Regular.ttf'),
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
      ].filter(Boolean) as string[];
      const ttfBoldCandidates = [
        process.env.PDF_FONT_BOLD,
        path.join(BUNDLED_FONT_DIR, 'PTSans-Bold.ttf'),
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
      ].filter(Boolean) as string[];

      async function loadFont(paths: string[], fallback: StandardFonts): Promise<PDFFont> {
        for (const p of paths) {
          try {
            if (fs.existsSync(p)) {
              const bytes = fs.readFileSync(p);
              return await outputDoc.embedFont(bytes, { subset: false });
            }
          } catch (e) { console.warn('[worker] font load failed:', p, e); }
        }
        console.warn('[worker] no Unicode TTF found, falling back to', fallback);
        return await outputDoc.embedFont(fallback);
      }

      const regularFont = await loadFont(ttfCandidates, StandardFonts.Helvetica);
      const boldFont = await loadFont(ttfBoldCandidates, StandardFonts.HelveticaBold);

      // Pre-warm all CZ PNGs in parallel (6 concurrent) before PDF assembly.
      // This converts Ghostscript + Python decode from sequential to parallel
      // and means the main loop only does cheap in-memory PDF drawing.
      const CONCURRENCY = 6;
      const czPngMap = new Map<string, Buffer>();
      const { encodeDataMatrix } = await import('../services/datamatrix');
      for (let start = 0; start < codes.length; start += CONCURRENCY) {
        const chunk = codes.slice(start, start + CONCURRENCY);
        await Promise.all(chunk.map(async (c) => {
          const mapKey = `${c.czBatchId}:${c.pageIndex}`;
          const isCsv = c.czBatch.s3Key.startsWith('csv:') || !c.czBatch.s3Key;
          if (isCsv) {
            if (!c.code) throw new Error(`CSV code missing payload (codeId=${c.id})`);
            czPngMap.set(mapKey, await encodeDataMatrix(c.code, 10));
          } else {
            const czPdfBuffer = batchPdfs.get(c.czBatchId)!;
            czPngMap.set(mapKey, await getCleanCzPng(c.czBatchId, c.pageIndex, czPdfBuffer));
          }
        }));
        await job.updateProgress(Math.round(((start + chunk.length) / codes.length) * 50));
      }

      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const t0 = Date.now();

        const czPng = czPngMap.get(`${code.czBatchId}:${code.pageIndex}`)!;

        const page = outputDoc.addPage([widthPt, heightPt]);
        const { height } = page.getSize();

        // pdf-lib Y axis is bottom-up; convert top-down mm to bottom-up pt
        const toX = (xMm: number) => xMm * MM_TO_PT;
        const toY = (yMm: number, hMm = 0) => height - (yMm + hMm) * MM_TO_PT;

        // Render template elements
        for (const el of elements) {
          if (el.type === 'rect') {
            const { r, g, b } = hexToRgb(el.strokeColor ?? '#000000');
            const fillRgb = el.fillColor ? hexToRgb(el.fillColor) : null;
            page.drawRectangle({
              x: toX(el.xMm),
              y: toY(el.yMm, el.heightMm ?? 0),
              width: (el.widthMm ?? 0) * MM_TO_PT,
              height: (el.heightMm ?? 0) * MM_TO_PT,
              borderColor: rgb(r, g, b),
              borderWidth: el.strokeWidthPt ?? 1,
              color: fillRgb ? rgb(fillRgb.r, fillRgb.g, fillRgb.b) : undefined,
              opacity: fillRgb ? 1 : 0,
            });
          } else if (el.type === 'eac') {
            const markW = (el.widthMm ?? 15) * MM_TO_PT;
            const markH = (el.heightMm ?? 9) * MM_TO_PT;
            // Render EAC SVG → PNG at 8× resolution for crisp anti-aliasing
            const scale = 8;
            const pngBuf = await renderEacPng(el.color ?? '#000000', Math.round(markW * scale), Math.round(markH * scale));
            const embeddedImg = await outputDoc.embedPng(pngBuf);
            page.drawImage(embeddedImg, {
              x: toX(el.xMm),
              y: toY(el.yMm, el.heightMm ?? 0),
              width: markW,
              height: markH,
            });
          } else if (el.type === 'text' || el.type === 'variable') {
            const { r, g, b } = hexToRgb(el.color ?? '#000000');
            const font: PDFFont = el.bold ? boldFont : regularFont;
            const blockW = (el.widthMm ?? 0) * MM_TO_PT;
            const blockH = (el.heightMm ?? 0) * MM_TO_PT;
            const sourceText = el.type === 'variable'
              ? (templateVariables[el.key ?? ''] ?? el.placeholder ?? '')
              : (el.text ?? '');
            // The browser pre-computes _wrappedLines on the substituted text; if present,
            // they are already final. Only fall back to server-side substitution+wrap
            // when no cached lines are provided (older templates / direct API saves).
            const hasCachedLines = Array.isArray(el._wrappedLines) && el._wrappedLines.length > 0;
            const hasTokens = !hasCachedLines && el.type === 'text' && sourceText.includes('{{');
            const rawText = hasTokens
              ? sourceText.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
                  const v = templateVariables[key];
                  return v !== undefined && v !== '' ? v : m;
                })
              : sourceText;
            // Calculate font size: prefer browser-resolved value (WYSIWYG) when available.
            let size = el._resolvedFontSizePt ?? el.fontSizePt ?? 10;
            if (!el._resolvedFontSizePt && el.fitToBlock && blockW > 0 && blockH > 0) {
              let lo = 1, hi = 200;
              for (let fi = 0; fi < 20; fi++) {
                const mid = (lo + hi) / 2;
                const wrapped = wrapText(rawText, font, mid, blockW);
                const maxLineW = Math.max(...wrapped.map((l) => font.widthOfTextAtSize(l || ' ', mid)));
                const totalH = wrapped.length * mid * 1.3;
                if (maxLineW <= blockW && totalH <= blockH) lo = mid;
                else hi = mid;
              }
              size = Math.max(1, lo * 0.97);
            }
            // Use browser-precomputed line breaks if available (WYSIWYG accurate),
            // otherwise fall back to server-side wrap.
            const lines: string[] = hasCachedLines
              ? (el._wrappedLines as string[])
              : wrapText(rawText, font, size, blockW);
            const lineHeight = size * 1.3;
            const startY = toY(el.yMm) - size * 0.75;
            const clipThreshold = blockH > 0 ? blockH - size * 0.75 : Infinity;
            lines.forEach((line, li) => {
              if (li * lineHeight > clipThreshold) return;
              const lineW = font.widthOfTextAtSize(line || ' ', size);
              let x = toX(el.xMm);
              if (el.align === 'center' && blockW) x = toX(el.xMm) + (blockW - lineW) / 2;
              else if (el.align === 'right' && blockW) x = toX(el.xMm) + blockW - lineW;
              if (line.trim()) page.drawText(line, { x, y: startY - li * lineHeight, size, font, color: rgb(r, g, b) });
            });
          } else if (el.type === 'barcode' && el.value) {
            // Vector rendering: bars = rectangles, digits = drawText — crisp at any scale
            drawEan13Vector(
              page,
              toX(el.xMm),
              toY(el.yMm, el.heightMm ?? 0),
              (el.widthMm ?? 20) * MM_TO_PT,
              (el.heightMm ?? 10) * MM_TO_PT,
              el.value,
              regularFont,
            );
          } else if (el.type === 'image' && el.s3Key) {
            if (!assetCache.has(el.s3Key)) {
              const buf = await downloadFile(el.s3Key);
              assetCache.set(el.s3Key, buf);
            }
            const imgBuf = assetCache.get(el.s3Key)!;
            const ext = el.s3Key.split('.').pop()?.toLowerCase();
            const embeddedImg = ext === 'png'
              ? await outputDoc.embedPng(imgBuf)
              : await outputDoc.embedJpg(imgBuf);
            // Letterbox: preserve aspect ratio inside the declared bounding box
            const boxW = (el.widthMm ?? 20) * MM_TO_PT;
            const boxH = (el.heightMm ?? 20) * MM_TO_PT;
            const imgRatioAsset = embeddedImg.width / embeddedImg.height;
            const boxRatioAsset = boxW / boxH;
            let drawW = boxW;
            let drawH = boxH;
            if (imgRatioAsset > boxRatioAsset) { drawH = boxW / imgRatioAsset; }
            else { drawW = boxH * imgRatioAsset; }
            const offsetX = (boxW - drawW) / 2;
            const offsetY = (boxH - drawH) / 2;
            page.drawImage(embeddedImg, {
              x: toX(el.xMm) + offsetX,
              y: toY(el.yMm, el.heightMm ?? 0) + offsetY,
              width: drawW,
              height: drawH,
            });
          }
        }

        // Embed CZ code as rasterized PNG (critical — never copy vector content)
        const czImage = await outputDoc.embedPng(czPng);
        // Fit into czArea preserving aspect ratio (letterbox / center).
        const areaWpt = czArea.widthMm * MM_TO_PT;
        const areaHpt = czArea.heightMm * MM_TO_PT;
        const imgRatio = czImage.width / czImage.height;
        const areaRatio = areaWpt / areaHpt;
        let drawWpt: number;
        let drawHpt: number;
        if (imgRatio > areaRatio) {
          drawWpt = areaWpt;
          drawHpt = areaWpt / imgRatio;
        } else {
          drawHpt = areaHpt;
          drawWpt = areaHpt * imgRatio;
        }
        const offsetX = (areaWpt - drawWpt) / 2;
        const offsetY = (areaHpt - drawHpt) / 2;
        page.drawImage(czImage, {
          x: toX(czArea.xMm) + offsetX,
          y: toY(czArea.yMm, czArea.heightMm) + offsetY,
          width: drawWpt,
          height: drawHpt,
        });

        await job.updateProgress(50 + Math.round(((i + 1) / codes.length) * 50));
        console.log(`[worker] batch=${outputBatchId} ${i + 1}/${codes.length} page=${code.pageIndex} in ${Date.now() - t0}ms`);
      }

      const pdfBytes = await outputDoc.save();
      const s3Key = `output/${outputBatchId}.pdf`;
      await uploadFile(s3Key, Buffer.from(pdfBytes), 'application/pdf');

      await prisma.outputBatch.update({
        where: { id: outputBatchId },
        data: { jobStatus: 'done', s3Key },
      });
    } catch (err) {
      // Release codes back to PENDING so the user can retry without losing them.
      try {
        await prisma.czCode.updateMany({
          where: { outputBatchId },
          data: { status: 'PENDING', outputBatchId: null },
        });
      } catch (rollbackErr) {
        console.error('[worker] failed to release codes:', rollbackErr);
      }
      await prisma.outputBatch.update({
        where: { id: outputBatchId },
        data: { jobStatus: 'error' },
      });
      throw err;
    }
  },
  { connection, concurrency: 4 }
);

worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err));

console.log('PDF generation worker started');
