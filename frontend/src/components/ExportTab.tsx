import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

interface Props { projectId: string; }

interface Batch {
  id: string;
  createdAt: string;
  fromIndex: number;
  toIndex: number;
  count: number;
  jobStatus: string;
  s3Key: string;
}

interface Stats { total: number; used: number; pending: number; }

export default function ExportTab({ projectId }: Props) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [batchSize, setBatchSize] = useState<50 | 100>(50);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<string>('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    const [b, s] = await Promise.all([api.getBatches(projectId), api.getCzStats(projectId).catch(() => null)]);
    setBatches(b);
    if (s) setStats(s);
  }

  useEffect(() => { load(); }, [projectId]);

  const pollStatus = useCallback(async (batchId: string) => {
    try {
      const { status, downloadUrl: url } = await api.getBatchStatus(batchId);
      setActiveStatus(status);
      if (status === 'done') {
        setDownloadUrl(url ?? null);
        if (pollingRef.current) clearInterval(pollingRef.current);
        await load();
      } else if (status === 'error') {
        setError('Ошибка генерации PDF');
        if (pollingRef.current) clearInterval(pollingRef.current);
      }
    } catch { /* ignore */ }
  }, [projectId]);

  async function handleGenerate() {
    setError('');
    setDownloadUrl(null);
    setActiveStatus('pending');
    try {
      const { outputBatchId } = await api.createBatch(projectId, batchSize);
      setActiveBatchId(outputBatchId);
      pollingRef.current = setInterval(() => pollStatus(outputBatchId), 2000);
    } catch (err: any) {
      setError(err.message);
      setActiveStatus('');
    }
  }

  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current); }, []);

  const isGenerating = activeBatchId && (activeStatus === 'pending' || activeStatus === 'processing');

  return (
    <div className="bg-white rounded-xl border p-6 space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-4">
        <div>
          <label className="text-sm font-medium mr-2">Размер батча:</label>
          <select
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value) as 50 | 100)}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
        {stats && (
          <p className="text-sm text-gray-500">Доступно: <strong>{stats.pending}</strong></p>
        )}
        <button
          onClick={handleGenerate}
          disabled={!!isGenerating || (stats?.pending ?? 0) === 0}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg font-medium text-sm"
        >
          Сгенерировать батч
        </button>
      </div>

      {isGenerating && (
        <div className="flex items-center gap-3 text-sm text-gray-600">
          <Spinner />
          <span>{activeStatus === 'processing' ? 'Генерация PDF...' : 'В очереди...'}</span>
        </div>
      )}

      {downloadUrl && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg font-medium text-sm"
        >
          Скачать PDF
        </a>
      )}

      {error && <p className="text-red-500 text-sm">{error}</p>}

      {/* History */}
      {batches.length > 0 && (
        <div>
          <h3 className="font-medium mb-3">История батчей</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="pb-2">Дата</th>
                <th className="pb-2">Коды</th>
                <th className="pb-2">Страницы</th>
                <th className="pb-2">Статус</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="py-2">{new Date(b.createdAt).toLocaleString('ru')}</td>
                  <td className="py-2">{b.count}</td>
                  <td className="py-2">{b.fromIndex}–{b.toIndex}</td>
                  <td className="py-2">
                    <StatusBadge status={b.jobStatus} />
                  </td>
                  <td className="py-2">
                    {b.jobStatus === 'done' && (
                      <a href={`/api/batches/${b.id}/download`} className="text-blue-600 hover:underline">Скачать</a>
                    )}
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    processing: 'bg-blue-100 text-blue-700',
    done: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  };
  const labels: Record<string, string> = {
    pending: 'В очереди', processing: 'Генерация', done: 'Готово', error: 'Ошибка',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[status] ?? ''}`}>
      {labels[status] ?? status}
    </span>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}
