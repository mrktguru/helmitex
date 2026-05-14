import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import bwipjs from 'bwip-js';

const PY_SCRIPT = path.resolve(__dirname, '../../scripts/decode_datamatrix.py');
const PYTHON = process.env.PYTHON_BIN ?? 'python3';

/**
 * Decode a single DataMatrix from a PNG buffer. Returns the raw payload as a
 * UTF-8 string. FNC1 / GS separators (0x1d) are preserved verbatim.
 */
export async function decodeDataMatrix(pngBuffer: Buffer, timeoutMs = 15000): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dm-'));
  const file = path.join(dir, 'in.png');
  writeFileSync(file, pngBuffer);
  try {
    const b64 = await new Promise<string>((resolve, reject) => {
      const proc = spawn(PYTHON, [PY_SCRIPT, file]);
      let out = '';
      let err = '';
      const killer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('decode timeout'));
      }, timeoutMs);
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => { clearTimeout(killer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new Error(`decode_datamatrix.py exit=${code}: ${err.trim() || 'no output'}`));
      });
    });
    return Buffer.from(b64, 'base64').toString('binary');
  } finally {
    try { unlinkSync(file); } catch { /* ignore */ }
    try { rmdirSync(dir); } catch { /* ignore */ }
  }
}

/**
 * Encode arbitrary bytes as a clean square DataMatrix PNG via bwip-js.
 * 0x1d bytes are translated to bwip-js' ^029 FNC1 escape so GS1 boundaries
 * survive the round trip.
 */
export async function encodeDataMatrix(payload: string, scale = 8): Promise<Buffer> {
  // Escape 0x1d (GS / FNC1) for bwip-js parser
  let parsed = false;
  let text = payload;
  if (text.includes('\x1d')) {
    parsed = true;
    text = text.replace(/\x1d/g, '^029');
  }
  // Also escape literal ^ when parse mode is on
  if (parsed) text = text.replace(/(?<!\^)\^(?!029)/g, '^^');

  const png = await bwipjs.toBuffer({
    bcid: 'datamatrix',
    text,
    scale,
    // No padding / quiet zone — the template czArea defines the exact
    // size of the DataMatrix. Quiet zone, if needed, must be reserved
    // in the template layout itself.
    padding: 0,
    parse: parsed,
    backgroundcolor: 'FFFFFF',
  } as any);
  return Buffer.from(png as Buffer);
}
