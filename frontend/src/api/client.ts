import { useAuthStore } from '../store/useAuthStore';

const BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res = await fetch(BASE + path, { ...options, headers, credentials: 'include' });

  // Try token refresh on 401
  if (res.status === 401) {
    const refreshRes = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshRes.ok) {
      const data = await refreshRes.json() as { accessToken: string };
      useAuthStore.getState().setAuth(data.accessToken, useAuthStore.getState().user!);
      headers['Authorization'] = `Bearer ${data.accessToken}`;
      res = await fetch(BASE + path, { ...options, headers, credentials: 'include' });
    } else {
      useAuthStore.getState().clearAuth();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// Скачивание файла с авторизацией (PDF, CSV): fetch → blob → <a download>
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const api = {
  // Auth
  login: (login: string, password: string) =>
    request<{ accessToken: string; user: { id: string; email: string; role: 'ADMIN' | 'OPERATOR' } }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) }
    ),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  // Projects
  getProjects: () => request<any[]>('/projects'),
  createProject: (name: string) => request<any>('/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  getProject: (id: string) => request<any>(`/projects/${id}`),
  deleteProject: (id: string) => request<any>(`/projects/${id}`, { method: 'DELETE' }),
  copyProject: (id: string, name: string) =>
    request<any>(`/projects/${id}/copy`, { method: 'POST', body: JSON.stringify({ name }) }),

  // Templates
  getTemplate: (projectId: string) => request<any>(`/projects/${projectId}/template`),
  saveTemplate: (projectId: string, data: any) =>
    request<any>(`/projects/${projectId}/template`, { method: 'PUT', body: JSON.stringify(data) }),

  // CZ
  getCzStats: (projectId: string) => request<{ total: number; used: number; pending: number }>(`/projects/${projectId}/cz/stats`),

  // Batches
  getBatches: (projectId: string, limit = 10, offset = 0) =>
    request<{ items: any[]; total: number }>(`/projects/${projectId}/batches?limit=${limit}&offset=${offset}`),
  createBatch: (projectId: string, batchSize: number) =>
    request<{ outputBatchId: string; jobId: string }>(`/projects/${projectId}/batches`, {
      method: 'POST',
      body: JSON.stringify({ batchSize }),
    }),
  deleteBatch: (batchId: string) =>
    request<{ ok: true }>(`/batches/${batchId}`, { method: 'DELETE' }),
  getBatchStatus: (batchId: string) => request<{ status: string; downloadUrl?: string }>(`/batches/${batchId}/status`),

  // Stock
  getItems: (type?: string, archived = false) =>
    request<any[]>(`/stock/items?${new URLSearchParams({ ...(type ? { type } : {}), ...(archived ? { archived: '1' } : {}) })}`),
  createItem: (data: { type: string; name: string; unit: string; minStock?: number | null; noStock?: boolean }) =>
    request<any>('/stock/items', { method: 'POST', body: JSON.stringify(data) }),
  updateItem: (id: string, data: Partial<{ name: string; unit: string; minStock: number | null; noStock: boolean; archived: boolean }>) =>
    request<any>(`/stock/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getBalances: (params: { type?: string; itemId?: string } = {}) =>
    request<any[]>(`/stock/balances?${new URLSearchParams(params as Record<string, string>)}`),
  getMoves: (params: { lotId?: string; limit?: number } = {}) =>
    request<any[]>(`/stock/moves?${new URLSearchParams(params as Record<string, string>)}`),
  getDocs: (type?: string) => request<any[]>(`/stock/docs${type ? `?type=${type}` : ''}`),
  getDoc: (id: string) => request<any>(`/stock/docs/${id}`),
  createDoc: (data: any, post = false) =>
    request<any>(`/stock/docs${post ? '?post=1' : ''}`, { method: 'POST', body: JSON.stringify(data) }),
  updateDoc: (id: string, data: any) =>
    request<any>(`/stock/docs/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  postDoc: (id: string) => request<{ ok: true }>(`/stock/docs/${id}/post`, { method: 'POST' }),
  cancelDoc: (id: string, releaseCodes = false) =>
    request<{ ok: true }>(`/stock/docs/${id}/cancel`, { method: 'POST', body: JSON.stringify({ releaseCodes }) }),
  getQuantTypes: () => request<any[]>('/stock/quant-types'),
  getDashboard: () => request<any>('/stock/dashboard'),
  getCzProjects: () => request<{ id: string; name: string; hasCzArea: boolean; freeCodes: number }[]>('/stock/cz-projects'),
  getItem: (id: string) => request<any>(`/stock/items/${id}`),
  importOzonProducts: (products: { offerId: string; name: string }[]) =>
    request<{ created: number; ids: string[]; notFound: string[] }>('/stock/ozon/import-products', { method: 'POST', body: JSON.stringify({ products }) }),
  // Ozon / FBO
  getOzonSettings: () => request<{ configured: boolean; defaults: any }>('/stock/ozon/settings'),
  saveOzonSettings: (data: any) => request<any>('/stock/ozon/settings', { method: 'PUT', body: JSON.stringify(data) }),
  getOzonClusters: () => request<{ id: string; name: string; country: string }[]>('/stock/ozon/clusters'),
  searchOzonDropoff: (search: string) => request<any[]>(`/stock/ozon/dropoff?search=${encodeURIComponent(search)}`),
  getOzonLastDropoff: () => request<any>('/stock/ozon/last-dropoff'),
  getOzonProducts: () => request<{ offerId: string; name: string }[]>('/stock/ozon/products'),
  setSpecOzon: (itemId: string, ozonOfferId: string | null) =>
    request<{ updated: number; notFound: string[] }>(`/stock/specs/${itemId}/ozon`, { method: 'PUT', body: JSON.stringify({ ozonOfferId }) }),
  syncOzonSkus: () => request<{ updated: number; notFound: string[] }>('/stock/ozon/sync-skus', { method: 'POST' }),
  getFboList: (active = false) => request<any[]>(`/stock/fbo${active ? '?active=1' : ''}`),
  getFbo: (id: string) => request<any>(`/stock/fbo/${id}`),
  createFbo: (data: any) => request<any>('/stock/fbo', { method: 'POST', body: JSON.stringify(data) }),
  fboDraft: (id: string, data: any) => request<any>(`/stock/fbo/${id}/draft`, { method: 'POST', body: JSON.stringify(data) }),
  fboTimeslots: (id: string, storageWarehouseId?: string) =>
    request<{ timezone: string | null; days: { date: string; slots: { from: string; to: string }[] }[] }>(
      `/stock/fbo/${id}/timeslots${storageWarehouseId ? `?storageWarehouseId=${storageWarehouseId}` : ''}`),
  fboBook: (id: string, data: any) => request<any>(`/stock/fbo/${id}/book`, { method: 'POST', body: JSON.stringify(data) }),
  fboAction: (id: string, action: 'cargoes' | 'labels' | 'ship' | 'cancel' | 'sync') =>
    request<any>(`/stock/fbo/${id}/${action}`, { method: 'POST' }),
  fboLog: (id: string) => request<any[]>(`/stock/fbo/${id}/log`),
  saveQuantType: (id: string | null, data: any) =>
    request<any>(id ? `/stock/quant-types/${id}` : '/stock/quant-types', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }),
  assembleQuants: (data: any) => request<any>('/stock/quant-docs', { method: 'POST', body: JSON.stringify(data) }),
  getQuantDoc: (id: string) => request<any>(`/stock/quant-docs/${id}`),
  getQuants: (params: { status?: string; typeId?: string; q?: string } = {}) =>
    request<any[]>(`/stock/quants?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][])}`),
  getQuant: (id: string) => request<any>(`/stock/quants/${id}`),
  replaceQuantCode: (quantId: string, quantCodeId: string) =>
    request<{ outputBatchId: string }>(`/stock/quants/${quantId}/replace-code`, { method: 'POST', body: JSON.stringify({ quantCodeId }) }),
  deleteDoc: (id: string) => request<{ ok: true }>(`/stock/docs/${id}`, { method: 'DELETE' }),
  getRecipes: () => request<any[]>('/stock/recipes'),
  saveRecipe: (itemId: string, data: any) =>
    request<any>(`/stock/recipes/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  getSpecs: () => request<any[]>('/stock/specs'),
  saveSpec: (itemId: string, data: any) =>
    request<any>(`/stock/specs/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  getBarrels: () => request<any[]>('/stock/barrels'),
  getFillPlan: (data: { sourceLotId: string; outputs: { itemId: string; qty: number }[] }) =>
    request<any>('/stock/fill/plan', { method: 'POST', body: JSON.stringify(data) }),
  getMixPlan: (itemId: string, qty: number) =>
    request<any>(`/stock/mix/plan?${new URLSearchParams({ itemId, qty: String(qty) })}`),

  // Users (admin)
  getUsers: () => request<any[]>('/users'),
  createUser: (data: { email: string; password: string; role: 'ADMIN' | 'OPERATOR' }) =>
    request<any>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: Partial<{ role: string }>) =>
    request<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) => request<any>(`/users/${id}`, { method: 'DELETE' }),
};
