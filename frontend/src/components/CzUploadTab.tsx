import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { api } from '../api/client';

interface Props { projectId: string; onUploaded?: () => void; }

interface Stats { total: number; used: number; pending: number; }

interface CzBatchInfo {
  id: string;
  uploadedAt: string;
  totalCount: number;
  pageCount: number;
  used: number;
}

export default function CzUploadTab({ projectId, onUploaded }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [batches, setBatches] = useState<CzBatchInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previews, setPreviews] = useState<string[]>([]);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [czBatchId, setCzBatchId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const token = useAuthStore((s) => s.accessToken);

  const loadAll = useCallback(async () => {
    try { setStats(await api.getCzStats(projectId)); } catch { /* ignore */ }
    try {
      const res = await fetch(`/api/projects/${projectId}/cz/batches`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setBatches(await res.json());
    } catch { /* ignore */ }
  }, [projectId, token]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleUpload(file: File) {
    setError('');
    setUploading(true);
    setProgress(0);
    setPreviews([]);
    setPreviewErrors([]);
    try {
      const isCsv = /\.csv$/i.test(file.name)
        || file.type === 'text/csv'
        || file.type === 'application/vnd.ms-excel'
        || file.type === 'text/plain';
      const endpoint = isCsv
        ? `/api/projects/${projectId}/cz/csv`
        : `/api/projects/${projectId}/cz`;

      const formData = new FormData();
      formData.append('file', file);

      const result = await new Promise<{ czBatchId: string; totalCount: number; pageCount: number; previews: string[]; previewErrors?: string[] }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', endpoint);
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(JSON.parse(xhr.responseText));
            } else {
              let body: any = {};
              try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
              const msg = body.message ?? (typeof body.error === 'string' ? body.error : null) ?? `HTTP ${xhr.status}`;
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error('Upload failed'));
          xhr.send(formData);
        }
      );

      setCzBatchId(result.czBatchId);
      setPreviews(result.previews ?? []);
      setPreviewErrors(result.previewErrors ?? []);
      await loadAll();
      onUploaded?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  async function regenerate(targetId?: string) {
    const id = targetId ?? czBatchId;
    if (!id) return;
    setRegenerating(true);
    setError('');
    if (targetId) setCzBatchId(targetId);
    try {
      const res = await fetch(`/api/projects/${projectId}/cz/${id}/regenerate-previews`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPreviews(data.previews ?? []);
      setPreviewErrors(data.previewErrors ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally { setRegenerating(false); }
  }

  async function deleteBatch(id: string) {
    const batch = batches.find((b) => b.id === id);
    const usedCount = batch?.used ?? 0;
    const msg = usedCount > 0
      ? `В этой партии ${usedCount} использованных кодов. Удалить? Коды будут удалены принудительно.`
      : 'Удалить эту партию ЧЗ? Это действие необратимо.';
    if (!confirm(msg)) return;
    setError('');
    try {
      // Always send force=1 — avoids the 409 "pass force=1" error for used codes
      const url = `/api/projects/${projectId}/cz/${id}?force=1`;
      const res = await fetch(url, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      if (czBatchId === id) { setCzBatchId(null); setPreviews([]); }
      await loadAll();
      onUploaded?.();
    } catch (err: any) { setError(err.message); }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const isCsv = /\.csv$/i.test(file.name)
      || file.type === 'text/csv'
      || file.type === 'application/vnd.ms-excel'
      || file.type === 'text/plain';
    if (file.type === 'application/pdf' || isCsv) handleUpload(file);
    else setError('Требуется PDF или CSV файл');
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }

  return (
    <div className="bg-white rounded-xl border p-6 space-y-6">
      {stats && (
        <div className="flex gap-6">
          <Stat label="Всего" value={stats.total} />
          <Stat label="Доступно" value={stats.pending} color="green" />
          <Stat label="Использовано" value={stats.used} color="gray" />
        </div>
      )}

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => !uploading && fileRef.current?.click()}
        className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 transition-colors"
      >
        <p className="text-gray-500">
          {uploading ? 'Загрузка...' : 'Перетащите PDF или CSV с кодами ЧЗ или нажмите для выбора'}
        </p>
        <p className="text-xs text-gray-400 mt-1">PDF до 50 МБ · CSV до 10 МБ · GS-разделители (\u001d, &lt;GS&gt;) распознаются автоматически · дубликаты отклоняются</p>
        <input ref={fileRef} type="file" accept="application/pdf,text/csv,.csv" className="hidden" onChange={handleFileInput} />
      </div>

      {uploading && (
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <p className="text-red-500 text-sm">{error}</p>}

      {previews.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Предпросмотр первых кодов:</p>
            {czBatchId && (
              <button
                onClick={() => regenerate()}
                disabled={regenerating}
                className="text-xs text-blue-600 hover:underline disabled:opacity-50"
              >{regenerating ? 'Обновление…' : 'Обновить превью'}</button>
            )}
          </div>
          <div className="flex gap-3">
            {previews.map((src, i) => (
              <img key={i} src={src} alt={`ЧЗ код ${i + 1}`} className="w-24 h-24 object-contain border rounded bg-white" />
            ))}
          </div>
        </div>
      )}

      {previews.length === 0 && czBatchId && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm space-y-2">
          <p className="text-amber-800">Не удалось сгенерировать предпросмотр (PDF загружен, коды доступны).</p>
          {previewErrors.length > 0 && (
            <ul className="text-xs text-amber-700 list-disc list-inside">
              {previewErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <button onClick={() => regenerate()} disabled={regenerating} className="text-amber-900 underline text-sm disabled:opacity-50">
            {regenerating ? 'Генерация…' : 'Попробовать ещё раз'}
          </button>
        </div>
      )}

      {batches.length > 0 && (
        <div>
          <h3 className="font-medium mb-2 text-sm">Загруженные партии ЧЗ</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="pb-2 font-normal">Дата</th>
                <th className="pb-2 font-normal">Кодов</th>
                <th className="pb-2 font-normal">Использовано</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="py-2">{new Date(b.uploadedAt).toLocaleString('ru')}</td>
                  <td className="py-2">{b.pageCount}</td>
                  <td className="py-2">{b.used}</td>
                  <td className="py-2 text-right space-x-3">
                    <button onClick={() => regenerate(b.id)} className="text-blue-600 hover:underline">Превью</button>
                    <button
                      onClick={() => deleteBatch(b.id)}
                      className={b.used > 0 ? 'text-orange-600 hover:underline' : 'text-red-600 hover:underline'}
                      title={b.used > 0 ? 'В партии есть использованные коды — будут удалены принудительно' : ''}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color = 'blue' }: { label: string; value: number; color?: string }) {
  const colors: Record<string, string> = { blue: 'text-blue-600', green: 'text-green-600', gray: 'text-gray-500' };
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-2xl font-bold ${colors[color]}`}>{value}</p>
    </div>
  );
}
