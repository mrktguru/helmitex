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
  const t0 = Date.now();
  let status = 0;
  let data: any = null;
  try {
    const res = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    status = res.status;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
  } catch (e: any) {
    data = { networkError: String(e?.message ?? e) };
  }
  await prisma.ozonApiLog.create({
    data: { shipmentId, method: path, status, request: body as any, response: data, ms: Date.now() - t0 },
  }).catch((e) => console.warn('[ozon] log failed', e));

  if (status === 429) throw new StockError(`Ozon: превышен лимит запросов (${path}). Подождите минуту и повторите.`);
  if (status < 200 || status >= 300) {
    const msg = data?.message ?? data?.error ?? data?.networkError ?? JSON.stringify(data)?.slice(0, 300);
    throw new StockError(`Ozon ${path}: ${status || 'нет связи'} ${msg ?? ''}`.trim());
  }
  return data as T;
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
