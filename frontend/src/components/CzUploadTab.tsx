import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { api } from '../api/client';

interface Props { projectId: string; }

interface Stats { total: number; used: number; pending: number; }

export default function CzUploadTab({ projectId }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [czBatchId, setCzBatchId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const token = useAuthStore((s) => s.accessToken);

  async function loadStats() {
    try {
      const s = await api.getCzStats(projectId);
      setStats(s);
    } catch { /* first upload hasn't happened yet */ }
  }

  useEffect(() => { loadStats(); }, [projectId]);

  async function handleUpload(file: File) {
    setError('');
    setUploading(true);
    setProgress(0);
    try {
      const formData = new FormData();
      formData.append('file', file);

      // XHR for progress tracking
      const result = await new Promise<{ czBatchId: string; totalCount: number; previewUrls: string[]; previewErrors?: string[] }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `/api/projects/${projectId}/cz`);
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(JSON.parse(xhr.responseText));
            } else {
              const body = JSON.parse(xhr.responseText || '{}');
              reject(new Error(body.error ?? `HTTP ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error('Upload failed'));
          xhr.send(formData);
        }
      );

      setCzBatchId(result.czBatchId);
      setPreviewUrls(result.previewUrls ?? []);
      setPreviewErrors(result.previewErrors ?? []);
      await loadStats();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') handleUpload(file);
    else setError('Требуется PDF файл');
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }

  return (
    <div className="bg-white rounded-xl border p-6 space-y-6">
      {/* Stats */}
      {stats && (
        <div className="flex gap-6">
          <Stat label="Всего" value={stats.total} />
          <Stat label="Доступно" value={stats.pending} color="green" />
          <Stat label="Использовано" value={stats.used} color="gray" />
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => !uploading && fileRef.current?.click()}
        className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 transition-colors"
      >
        <p className="text-gray-500">
          {uploading ? 'Загрузка...' : 'Перетащите PDF с кодами ЧЗ или нажмите для выбора'}
        </p>
        <p className="text-xs text-gray-400 mt-1">Максимум 50 МБ</p>
        <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={handleFileInput} />
      </div>

      {uploading && (
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <p className="text-red-500 text-sm">{error}</p>}

      {previewUrls.length > 0 && (
        <div>
          <p className="text-sm font-medium mb-2">Предпросмотр первых кодов:</p>
          <div className="flex gap-3">
            {previewUrls.map((url, i) => (
              <img key={i} src={url} alt={`ЧЗ код ${i + 1}`} className="w-24 h-24 object-contain border rounded" />
            ))}
          </div>
        </div>
      )}

      {previewUrls.length === 0 && czBatchId && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm space-y-2">
          <p className="text-amber-800">
            Не удалось сгенерировать предпросмотр (PDF загружен, коды доступны).
          </p>
          {previewErrors.length > 0 && (
            <ul className="text-xs text-amber-700 list-disc list-inside">
              {previewErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <button
            onClick={async () => {
              if (!czBatchId) return;
              setRegenerating(true);
              try {
                const res = await fetch(`/api/projects/${projectId}/cz/${czBatchId}/regenerate-previews`, {
                  method: 'POST', headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                setPreviewUrls(data.previewUrls ?? []);
                setPreviewErrors(data.previewErrors ?? []);
              } catch (err: any) {
                setError(err.message);
              } finally { setRegenerating(false); }
            }}
            disabled={regenerating}
            className="text-amber-900 underline text-sm disabled:opacity-50"
          >
            {regenerating ? 'Генерация…' : 'Попробовать ещё раз'}
          </button>
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
