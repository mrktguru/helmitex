import 'dotenv/config';
import fs from 'fs';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { PDFDocument, rgb, StandardFonts, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import prisma from '../prisma/client';
import { downloadFile, uploadFile, objectExists } from '../services/s3';
import { convertPdfPageToPng } from '../services/pdf';
import { generateEan13Png } from '../services/barcode';

const MM_TO_PT = 2.8346;

interface JobData {
  outputBatchId: string;
  projectId: string;
  codeIds: string[];
}

interface LabelElement {
  id: string;
  type: 'text' | 'barcode' | 'image' | 'rect';
  xMm: number;
  yMm: number;
  widthMm?: number;
  heightMm?: number;
  text?: string;
  fontSizePt?: number;
  bold?: boolean;
  color?: string;
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
      const widthPt = template.widthMm * MM_TO_PT;
      const heightPt = template.heightMm * MM_TO_PT;

      // Load all CZ codes for this batch
      const codes = await prisma.czCode.findMany({
        where: { outputBatchId },
        include: { czBatch: true },
        orderBy: { pageIndex: 'asc' },
      });

      // Group codes by czBatch to avoid downloading same PDF multiple times
      const batchPdfs = new Map<string, Buffer>();
      for (const code of codes) {
        if (!batchPdfs.has(code.czBatchId)) {
          const buf = await downloadFile(code.czBatch.s3Key);
          batchPdfs.set(code.czBatchId, buf);
        }
      }

      // Asset cache to avoid redundant S3 downloads
      const assetCache = new Map<string, Buffer>();

      const outputDoc = await PDFDocument.create();
      outputDoc.registerFontkit(fontkit);

      // Try Unicode TTFs (Cyrillic support); fall back to Helvetica if missing.
      const ttfCandidates = [
        process.env.PDF_FONT_REGULAR,
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
      ].filter(Boolean) as string[];
      const ttfBoldCandidates = [
        process.env.PDF_FONT_BOLD,
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
      ].filter(Boolean) as string[];

      async function loadFont(paths: string[], fallback: StandardFonts): Promise<PDFFont> {
        for (const p of paths) {
          try {
            if (fs.existsSync(p)) {
              const bytes = fs.readFileSync(p);
              return await outputDoc.embedFont(bytes, { subset: true });
            }
          } catch (e) { console.warn('[worker] font load failed:', p, e); }
        }
        console.warn('[worker] no Unicode TTF found, falling back to', fallback);
        return await outputDoc.embedFont(fallback);
      }

      const regularFont = await loadFont(ttfCandidates, StandardFonts.Helvetica);
      const boldFont = await loadFont(ttfBoldCandidates, StandardFonts.HelveticaBold);

      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const t0 = Date.now();
        const cacheKey = `cache/cz-png-v10/${code.czBatchId}/page-${code.pageIndex}.png`;

        // Try cache first; fall back to converting and write to cache.
        let czPng: Buffer;
        try {
          if (await objectExists(cacheKey)) {
            czPng = await downloadFile(cacheKey);
          } else {
            const czPdfBuffer = batchPdfs.get(code.czBatchId)!;
            czPng = await convertPdfPageToPng(czPdfBuffer, code.pageIndex, { timeoutMs: 60_000 });
            try { await uploadFile(cacheKey, czPng, 'image/png'); } catch (e) { console.warn('[worker] cache write failed:', e); }
          }
        } catch (err: any) {
          console.error(`[worker] batch=${outputBatchId} page=${code.pageIndex} convert failed:`, err?.message ?? err);
          throw err;
        }

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
          } else if (el.type === 'text') {
            const { r, g, b } = hexToRgb(el.color ?? '#000000');
            const font: PDFFont = el.bold ? boldFont : regularFont;
            page.drawText(el.text ?? '', {
              x: toX(el.xMm),
              y: toY(el.yMm),
              size: el.fontSizePt ?? 10,
              font,
              color: rgb(r, g, b),
            });
          } else if (el.type === 'barcode' && el.value) {
            const barPng = await generateEan13Png(el.value);
            const barImage = await outputDoc.embedPng(barPng);
            page.drawImage(barImage, {
              x: toX(el.xMm),
              y: toY(el.yMm, el.heightMm ?? 0),
              width: (el.widthMm ?? 20) * MM_TO_PT,
              height: (el.heightMm ?? 10) * MM_TO_PT,
            });
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
            page.drawImage(embeddedImg, {
              x: toX(el.xMm),
              y: toY(el.yMm, el.heightMm ?? 0),
              width: (el.widthMm ?? 20) * MM_TO_PT,
              height: (el.heightMm ?? 20) * MM_TO_PT,
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

        await job.updateProgress(Math.round(((i + 1) / codes.length) * 100));
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
  { connection, concurrency: 2 }
);

worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err));

console.log('PDF generation worker started');
