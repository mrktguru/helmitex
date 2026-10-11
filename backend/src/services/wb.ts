import prisma from '../prisma/client';
import { StockError } from './stock';
import { sleep } from './ozon';

// Клиент WB Marketplace API (FBS). Ключ — WB_API_TOKEN в .env сервера.
const BASE = 'https://marketplace-api.wildberries.ru';

export function wbConfigured(): boolean {
  return !!process.env.WB_API_TOKEN;
}

// Каждый вызов пишется в OzonApiLog (общий журнал API маркетплейсов): method = «WB PUT /api/…», shipmentId = поставка WB
export async function wb<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, supplyId?: string, log = true): Promise<T> {
  if (!wbConfigured()) throw new StockError('WB API не настроен: нет WB_API_TOKEN в .env сервера');
  const t0 = Date.now();
  let status = 0;
  let data: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { Authorization: process.env.WB_API_TOKEN!, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = res.status;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
    } catch (e: any) {
      data = { networkError: String(e?.message ?? e) };
    }
    // 429 — лимит 300 запросов/мин; повторяем с паузой
    if (status !== 429) break;
    await sleep(1500 * (attempt + 1));
  }
  if (log || status < 200 || status >= 300) {
    await prisma.ozonApiLog.create({
      data: { shipmentId: supplyId, method: `WB ${method} ${path}`, status, request: (body ?? null) as any, response: data, ms: Date.now() - t0 },
    }).catch((e) => console.warn('[wb] log failed', e));
  }
  if (status < 200 || status >= 300) {
    const msg = data?.message ?? data?.detail ?? data?.networkError ?? JSON.stringify(data)?.slice(0, 300);
    throw new WbError(status, `WB ${path}: ${status || 'нет связи'} ${msg ?? ''}`.trim());
  }
  return data as T;
}

export class WbError extends StockError {
  constructor(public status: number, message: string) { super(message); }
}

export interface WbOrderApi {
  id: number;
  article: string;
  nmId: number;
  chrtId: number;
  skus: string[];
  price: number;
  createdAt: string;
  cargoType: number;
  supplyId?: string;
}

export interface WbSupplyApi {
  id: string;
  name: string;
  createdAt: string;
  done: boolean;
  closedAt: string | null;
  cargoType: number | null;
  shippingType: string | null;
  shippingPointId: number | null;
  shippingDt: string | null;
}

export const chunk = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// Все поставки (постранично)
export async function wbSupplies(): Promise<WbSupplyApi[]> {
  const out: WbSupplyApi[] = [];
  let next = 0;
  for (let page = 0; page < 30; page++) {
    const r = await wb<{ supplies: WbSupplyApi[]; next: number }>('GET', `/api/v3/supplies?limit=1000&next=${next}`, undefined, undefined, false);
    out.push(...(r.supplies ?? []));
    if (!r.supplies?.length || !r.next || r.next === next) break;
    next = r.next;
  }
  return out;
}

// Задания по списку id: ищем в /api/v3/orders начиная с даты (WB отдаёт задания за период, постранично)
export async function wbOrdersByIds(ids: number[], since: Date): Promise<WbOrderApi[]> {
  const want = new Set(ids);
  const found: WbOrderApi[] = [];
  let next = 0;
  const dateFrom = Math.floor(since.getTime() / 1000);
  for (let page = 0; page < 30 && found.length < want.size; page++) {
    const r = await wb<{ orders: WbOrderApi[]; next: number }>('GET', `/api/v3/orders?limit=1000&next=${next}&dateFrom=${dateFrom}`, undefined, undefined, false);
    for (const o of r.orders ?? []) if (want.has(o.id)) found.push(o);
    if (!r.orders?.length || !r.next || r.next === next) break;
    next = r.next;
  }
  return found;
}

export const fmtRuDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;

// Порядок печати: по товару, затем по номеру стикера (как в листе подбора WB)
export function printOrder<T extends { id: string; stickerA: string | null; stickerB: string | null; itemName?: string | null; article: string }>(orders: T[]): T[] {
  return [...orders].sort((a, b) =>
    (a.itemName ?? a.article).localeCompare(b.itemName ?? b.article, 'ru') ||
    Number(a.stickerB ?? 0) - Number(b.stickerB ?? 0) ||
    Number(a.stickerA ?? 0) - Number(b.stickerA ?? 0) ||
    a.id.localeCompare(b.id));
}
