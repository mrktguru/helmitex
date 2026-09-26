import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir, cpus } from 'os';
import path from 'path';
import bwipjs from 'bwip-js';

const PY_SCRIPT = path.resolve(__dirname, '../../scripts/decode_datamatrix.py');
const PYTHON = process.env.PYTHON_BIN ?? 'python3';
const POOL_SIZE = Math.max(1, Number(process.env.DECODER_POOL_SIZE) || cpus().length);

/**
 * Long-lived `decode_datamatrix.py --serve` child. Importing PIL + pylibdmtx costs
 * ~0.5 s per interpreter start, far more than decoding itself, so the process is
 * reused: one path per line in, one "OK <base64>" / "ERR <msg>" line out.
 */
class DecoderProc {
  private proc: ChildProcessWithoutNullStreams;
  private pending: { resolve: (b64: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private buf = '';
  dead = false;
  private reserved = false;

  constructor(private onIdle: (p: DecoderProc) => void) {
    this.proc = spawn(PYTHON, [PY_SCRIPT, '--serve']);
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        this.settle(line);
      }
    });
    this.proc.stderr.on('data', () => { /* python tracebacks: surfaced via exit below */ });
    this.proc.stdin.on('error', (e) => this.die(e));
    this.proc.on('error', (e) => this.die(e));
    this.proc.on('close', (code) => this.die(new Error(`decode_datamatrix.py exited (code ${code})`)));
  }

  private settle(line: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (line.startsWith('OK ')) p.resolve(line.slice(3));
    else p.reject(new Error(`decode_datamatrix.py: ${line.replace(/^ERR /, '') || 'no output'}`));
    this.onIdle(this);
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    const p = this.pending;
    this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(err); }
    this.proc.kill('SIGKILL');
    this.onIdle(this);
  }

  get idle(): boolean { return !this.dead && this.pending === null && !this.reserved; }

  /** Claim this decoder synchronously so concurrent callers can't pick it before run() starts. */
  reserve(): this { this.reserved = true; return this; }

  run(file: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.reserved = false;
      if (this.dead) { reject(new Error('decoder process is not running')); return; }
      const timer = setTimeout(() => this.die(new Error('decode timeout')), timeoutMs);
      this.pending = { resolve, reject, timer };
      this.proc.stdin.write(file + '\n');
    });
  }
}

const decoders: DecoderProc[] = [];
const waiting: Array<() => void> = [];

function releaseWaiter(): void {
  for (let i = decoders.length - 1; i >= 0; i--) if (decoders[i].dead) decoders.splice(i, 1);
  const next = waiting.shift();
  if (next) next();
}

async function acquireDecoder(): Promise<DecoderProc> {
  for (;;) {
    for (let i = decoders.length - 1; i >= 0; i--) if (decoders[i].dead) decoders.splice(i, 1);
    const free = decoders.find((d) => d.idle);
    if (free) return free.reserve();
    if (decoders.length < POOL_SIZE) {
      const d = new DecoderProc(releaseWaiter);
      decoders.push(d);
      return d.reserve();
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
}

/**
 * Decode a single DataMatrix from a PNG buffer. Returns the raw payload as a
 * UTF-8 string. FNC1 / GS separators (0x1d) are preserved verbatim.
 * Requests are spread over a small pool of persistent Python decoders.
 */
export async function decodeDataMatrix(pngBuffer: Buffer, timeoutMs = 15000): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dm-'));
  const file = path.join(dir, 'in.png');
  writeFileSync(file, pngBuffer);
  try {
    let b64: string;
    try {
      b64 = await (await acquireDecoder()).run(file, timeoutMs);
    } catch (e) {
      // A decoder that died between being picked and used (or was killed by another
      // request's timeout) is not this image's fault — retry once on a fresh one.
      if (!(e instanceof Error) || !/not running|exited/.test(e.message)) throw e;
      b64 = await (await acquireDecoder()).run(file, timeoutMs);
    }
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
