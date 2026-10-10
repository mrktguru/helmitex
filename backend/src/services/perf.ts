import prisma from '../prisma/client';
import { StockError } from './stock';
import { sleep } from './ozon';

// Ozon Performance API (реклама). Ключи — OZON_PERF_CLIENT_ID / OZON_PERF_CLIENT_SECRET в .env сервера.
const BASE = 'https://api-performance.ozon.ru';

export function perfConfigured(): boolean {
  return !!(process.env.OZON_PERF_CLIENT_ID && process.env.OZON_PERF_CLIENT_SECRET);
}

let token: { value: string; until: number } | null = null;

async function getToken(): Promise<string> {
  if (!perfConfigured()) throw new StockError('Performance API не настроен: нет OZON_PERF_CLIENT_ID / OZON_PERF_CLIENT_SECRET в .env сервера');
  if (token && Date.now() < token.until) return token.value;
  const res = await fetch(BASE + '/api/client/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.OZON_PERF_CLIENT_ID, client_secret: process.env.OZON_PERF_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null;
  if (!res.ok || !j?.access_token) throw new StockError(`Performance API: не удалось получить токен (${res.status})`);
  token = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 1800) - 120) * 1000 };
  return token.value;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

// Изменения (не GET) и ошибки пишутся в OzonApiLog с префиксом «perf »
export async function perf<T = any>(method: Method, path: string, body?: unknown, raw = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await getToken() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 401 && attempt === 0) { token = null; continue; }
    if (res.status === 429 && attempt < 4) { await sleep(3000 * (attempt + 1)); continue; }
    let data: any = null;
    if (!raw) { try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; } }
    if (method !== 'GET' || !res.ok) {
      await prisma.ozonApiLog.create({
        data: { method: `perf ${method} ${path}`, status: res.status, request: (body ?? null) as any, response: raw ? { raw: text.slice(0, 2000) } : data, ms: Date.now() - t0 },
      }).catch((e) => console.warn('[perf] log failed', e));
    }
    if (!res.ok) {
      const msg = data?.error ?? data?.message ?? text.slice(0, 300);
      throw new StockError(`Ozon Реклама ${path}: ${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return (raw ? text : data) as T;
  }
}

// Асинхронный отчёт: запрос → UUID → ожидание → JSON
export async function perfReport<T = any>(path: string, body: unknown): Promise<T> {
  const { UUID } = await perf<{ UUID: string }>('POST', path, body);
  for (let i = 0; i < 90; i++) {
    const s = await perf<{ state: string; error?: string }>('GET', `/api/client/statistics/${UUID}`);
    if (s.state === 'OK') break;
    if (s.state === 'ERROR') throw new StockError(`Ozon Реклама: отчёт не построен — ${s.error ?? 'ошибка'}`);
    await sleep(i < 5 ? 2000 : 5000);
  }
  const text = await perf<string>('GET', `/api/client/statistics/report?UUID=${UUID}`, undefined, true);
  return JSON.parse(text) as T;
}

// Ставки и бюджеты в Performance API — миллионные доли рубля
export const toMicro = (rub: number) => String(Math.round(rub * 100) * 10_000);
export const fromMicro = (v: string | number | null | undefined) => (v == null || v === '' ? 0 : Number(v) / 1_000_000);
