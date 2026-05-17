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

  // Users (admin)
  getUsers: () => request<any[]>('/users'),
  createUser: (data: { email: string; password: string; role: 'ADMIN' | 'OPERATOR' }) =>
    request<any>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: Partial<{ role: string }>) =>
    request<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) => request<any>(`/users/${id}`, { method: 'DELETE' }),
};
