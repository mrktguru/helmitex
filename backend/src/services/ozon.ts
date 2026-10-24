import prisma from '../prisma/client';
import { StockError } from './stock';

const BASE = 'https://api-seller.ozon.ru';

export function ozonConfigured(): boolean {
  return !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);
}

function headers() {
  if (!ozonConfigured()) throw new StockError('Ozon API не настроен: нет OZON_CLIENT_ID / OZON_API_KEY в .env сервера');
  return {
    'Client-Id': process.env.OZON_CLIENT_ID!,
    'Api-Key': process.env.OZON_API_KEY!,
    'Content-Type': 'application/json',
  };
}

// Вызов Seller API. Каждый запрос и ответ пишется в OzonApiLog (с привязкой к поставке, если есть).
export async function ozon<T = any>(path: string, body: unknown, shipmentId?: string): Promise<T> {
  return ozonCall<T>('POST', path, body, shipmentId);
}

export async function ozonGet<T = any>(path: string): Promise<T> {
  return ozonCall<T>('GET', path, undefined);
}

// ───── Ограничение скорости: у Ozon лимит запросов В СЕКУНДУ на кабинет (и строже — на аналитику).
// Все процессы портала (синхронизация, сборка, биддер, реклама) идут через одну очередь, чтобы не мешать друг другу.
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const gates = new Map<string, Promise<void>>();
function gate(bucket: string, intervalMs: number): Promise<void> {
  const prev = gates.get(bucket) ?? Promise.resolve();
  const next = prev.then(() => sleepMs(intervalMs));
  gates.set(bucket, next);
  return prev; // стартуем, когда освободилось место; следующий — через intervalMs
}
const bucketOf = (path: string): [string, number] => path.startsWith('/v1/analytics/') || path.startsWith('/v2/analytics/') ? ['analytics', 1200] : ['seller', 120];
// повторять можно чтение; изменения (сборка, отгрузка) — только при 429: Ozon его не выполнял
const READ = /\/(list|get|info|stocks|data|count|status|prices|by-day)(\/|$)/;

// Сколько запросов к Ozon за последний час — для проверки нагрузки
const calls: number[] = [];
export function callsLastHour() { const t = Date.now() - 3600_000; while (calls.length && calls[0] < t) calls.shift(); return calls.length; }

// log = false — для объёмных ответов аналитики и начислений: в журнал пишутся только ошибки
export async function ozonCall<T>(method: 'GET' | 'POST', path: string, body: unknown, shipmentId?: string, log = true): Promise<T> {
  let status = 0;
  let data: any = null;
  let t0 = Date.now();
  const [bucket, interval] = bucketOf(path);
  for (let attempt = 0; ; attempt++) {
    await gate('all', 120);
    if (bucket !== 'seller') await gate(bucket, interval);
    calls.push(Date.now());
    t0 = Date.now();
    status = 0; data = null;
    try {
      const res = await fetch(BASE + path, { method, headers: headers(), body: method === 'POST' ? JSON.stringify(body) : undefined });
      status = res.status;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
    } catch (e: any) {
      data = { networkError: String(e?.message ?? e) };
    }
    const retry = status === 429 || ((status === 0 || status >= 500) && (method === 'GET' || READ.test(path)));
    if (!retry || attempt >= 3) break;
    await sleepMs(1500 * 2 ** attempt + Math.random() * 500);
  }
  if (log || status < 200 || status >= 300) {
    await prisma.ozonApiLog.create({
      data: { shipmentId, method: path, status, request: body as any, response: data, ms: Date.now() - t0 },
    }).catch((e) => console.warn('[ozon] log failed', e));
  }

  if (status === 429) throw new StockError(`Ozon: превышен лимит запросов (${path}). Подождите минуту и повторите.`);
  if (status < 200 || status >= 300) {
    const msg = data?.message ?? data?.error ?? data?.networkError ?? JSON.stringify(data)?.slice(0, 300);
    throw new StockError(`Ozon ${path}: ${status || 'нет связи'} ${msg ?? ''}`.trim());
  }
  return data as T;
}

// Метод, который отвечает PDF-файлом (акт): возвращает байты; ошибка Ozon приходит JSON-ом
export async function ozonPdf(path: string, body: unknown): Promise<Buffer> {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const isPdf = buf.subarray(0, 4).toString() === '%PDF';
  await prisma.ozonApiLog.create({
    data: { method: path, status: res.status, request: body as any, response: isPdf ? { pdfBytes: buf.length } : { raw: buf.toString('utf8').slice(0, 2000) }, ms: Date.now() - t0 },
  }).catch(() => undefined);
  if (res.ok && isPdf) return buf;
  // иногда PDF приходит base64 в JSON
  try {
    const j = JSON.parse(buf.toString('utf8'));
    const b64 = j.content ?? j.file_content ?? j.result?.content;
    if (res.ok && b64) return Buffer.from(b64, 'base64');
    throw new StockError(`Ozon ${path}: ${res.status} ${j.message ?? JSON.stringify(j).slice(0, 300)}`);
  } catch (e) {
    if (e instanceof StockError) throw e;
    throw new StockError(`Ozon ${path}: ${res.status} — не PDF`);
  }
}

export async function ozonGetFile(url: string): Promise<Buffer> {
  // Ссылка на PDF этикеток может требовать те же заголовки авторизации
  let res = await fetch(url);
  if (res.status === 401 || res.status === 403) res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new StockError(`Ozon: не удалось скачать файл этикеток (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Опрос асинхронной операции Ozon, пока статус «в процессе»
export async function poll<T>(fn: () => Promise<T>, isDone: (r: T) => boolean, tries = 15, delayMs = 2000): Promise<T> {
  let r = await fn();
  for (let i = 1; i < tries && !isDone(r); i++) {
    await sleep(delayMs);
    r = await fn();
  }
  return r;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return (row?.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: value as any }, update: { value: value as any } });
}

export interface OzonDefaults {
  supplyType: 'CROSSDOCK' | 'DIRECT';
  clusterId: string | null;
  clusterName: string | null;
  dropOffWarehouseId: string | null;
  dropOffName: string | null;
  dropOffType: string | null;
}

export const OZON_DEFAULTS_KEY = 'ozon.defaults';
export const defaultOzonSettings: OzonDefaults = {
  supplyType: 'CROSSDOCK', clusterId: null, clusterName: null, dropOffWarehouseId: null, dropOffName: null, dropOffType: null,
};

// Человекочитаемые статусы заявки Ozon
export const OZON_STATE_LABEL: Record<string, string> = {
  DATA_FILLING: 'Заполнение данных',
  READY_TO_SUPPLY: 'Готова к отгрузке',
  ACCEPTED_AT_SUPPLY_WAREHOUSE: 'Принята на точке отгрузки',
  IN_TRANSIT: 'В пути',
  ACCEPTANCE_AT_STORAGE_WAREHOUSE: 'Приёмка на складе',
  REPORTS_CONFIRMATION_AWAITING: 'Ожидает подтверждения актов',
  REPORT_REJECTED: 'Акт отклонён',
  COMPLETED: 'Завершена',
  REJECTED_AT_SUPPLY_WAREHOUSE: 'Отказано в приёмке',
  CANCELLED: 'Отменена',
  OVERDUE: 'Просрочена',
};
