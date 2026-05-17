import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuthStore } from '../store/useAuthStore';

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

const PAGE_SIZE = 10;

export default function ExportSection({ projectId }: Props) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [batchSize, setBatchSize] = useState<number>(50);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<string>('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const token = useAuthStore((s) => s.accessToken);

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([
        api.getBatches(projectId, PAGE_SIZE, page * PAGE_SIZE),
        api.getCzStats(projectId).catch(() => null),
      ]);
      setBatches(b.items);
      setTotal(b.total);
      if (s) setStats(s);
      // Drop selections that are no longer on the current page
      setSelected((prev) => {
        const ids = new Set(b.items.map((x: Batch) => x.id));
        const next = new Set<string>();
        prev.forEach((id) => { if (ids.has(id)) next.add(id); });
        return next;
      });
    } catch (err: any) {
      setError(err.message ?? 'Ошибка загрузки');
    }
  }, [projectId, page]);

  useEffect(() => { load(); }, [load]);

  const pollStatus = useCallback(async (batchId: string) => {
    try {
      const { status } = await api.getBatchStatus(batchId);
      setActiveStatus(status);
      if (status === 'done') {
        if (pollingRef.current) clearInterval(pollingRef.current);
        await load();
      } else if (status === 'error') {
        setError('Ошибка генерации PDF');
        if (pollingRef.current) clearInterval(pollingRef.current);
      }
    } catch { /* ignore */ }
  }, [load]);

  async function handleGenerate() {
    setError('');
    setActiveStatus('pending');
    try {
      const size = Math.min(2000, Math.max(1, Math.round(batchSize)));
      const { outputBatchId } = await api.createBatch(projectId, size);
      setActiveBatchId(outputBatchId);
      setPage(0);
      pollingRef.current = setInterval(() => pollStatus(outputBatchId), 2000);
    } catch (err: any) {
      setError(err.message);
      setActiveStatus('');
    }
  }

  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current); }, []);

  async function downloadBatch(b: Batch) {
    try {
      const res = await fetch(`/api/batches/${b.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-${b.fromIndex}-${b.toIndex}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      setError(`Ошибка скачивания: ${err.message}`);
    }
  }

  async function handleDelete(b: Batch) {
    if (!confirm(`Удалить экспорт от ${new Date(b.createdAt).toLocaleString('ru')} (${b.count} кодов)? Коды вернутся в "Доступные".`)) return;
    try {
      await api.deleteBatch(b.id);
      await load();
    } catch (err: any) {
      setError(err.message ?? 'Ошибка удаления');
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === batches.length && batches.length > 0) return new Set();
      return new Set(batches.map((b) => b.id));
    });
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    const totalCodes = batches.filter((b) => selected.has(b.id)).reduce((s, b) => s + b.count, 0);
    if (!confirm(`Удалить ${selected.size} экспорт(ов) суммарно на ${totalCodes} кодов? Коды вернутся в "Доступные".`)) return;
    setBulkDeleting(true);
    setError('');
    try {
      // Delete sequentially to keep ordering deterministic and surface first error
      for (const id of Array.from(selected)) {
        await api.deleteBatch(id);
      }
      setSelected(new Set());
      await load();
    } catch (err: any) {
      setError(err.message ?? 'Ошибка массового удаления');
      await load();
    } finally {
      setBulkDeleting(false);
    }
  }

  const isGenerating = activeBatchId && (activeStatus === 'pending' || activeStatus === 'processing');
  const available = stats?.pending ?? 0;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const allOnPageSelected = useMemo(
    () => batches.length > 0 && batches.every((b) => selected.has(b.id)),
    [batches, selected],
  );

  return (
    <div className="bg-white rounded-xl border p-5">
      <h3 className="font-semibold mb-3">Экспорт партии</h3>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Количество кодов</label>
          <input
            type="number"
            min={1}
            max={Math.min(2000, available || 2000)}
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            className="w-28 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="text-sm text-gray-500 flex-1 min-w-[140px]">
          {available > 0
            ? <>Доступно: <strong className="text-green-600">{available}</strong></>
            : <span className="text-amber-600">Нет доступных кодов — загрузите ЧЗ</span>}
        </div>
        <button
          onClick={handleGenerate}
          disabled={!!isGenerating || available === 0 || batchSize < 1}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg font-medium text-sm"
        >
          {isGenerating ? 'Генерация…' : 'Создать экспорт'}
        </button>
      </div>

      {isGenerating && (
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-3">
          <Spinner />
          <span>{activeStatus === 'processing' ? 'Генерация PDF…' : 'В очереди…'}</span>
        </div>
      )}

      {error && <p className="text-red-500 text-sm mb-3">{error}</p>}

      {selected.size > 0 && (
        <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-3 text-sm">
          <span className="text-blue-900">Выбрано: <strong>{selected.size}</strong></span>
          <div className="flex gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-gray-600 hover:underline text-xs"
            >Сбросить</button>
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1 rounded text-xs font-medium"
            >{bulkDeleting ? 'Удаление…' : 'Удалить выбранные'}</button>
          </div>
        </div>
      )}

      {total === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">История экспортов пуста</p>
      ) : (
        <>
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b">
                  <th className="pb-2 pl-5 w-10">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleAll}
                      className="cursor-pointer accent-blue-600"
                      aria-label="Выбрать все на странице"
                    />
                  </th>
                  <th className="pb-2 font-normal">Дата</th>
                  <th className="pb-2 font-normal">Коды</th>
                  <th className="pb-2 font-normal">Диапазон</th>
                  <th className="pb-2 font-normal">Статус</th>
                  <th className="pb-2 pr-5 text-right font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="py-2 pl-5">
                      <input
                        type="checkbox"
                        checked={selected.has(b.id)}
                        onChange={() => toggleOne(b.id)}
                        className="cursor-pointer accent-blue-600"
                        aria-label="Выбрать партию"
                      />
                    </td>
                    <td className="py-2">{new Date(b.createdAt).toLocaleString('ru')}</td>
                    <td className="py-2">{b.count}</td>
                    <td className="py-2 text-gray-500">{b.fromIndex}–{b.toIndex}</td>
                    <td className="py-2"><StatusBadge status={b.jobStatus} /></td>
                    <td className="py-2 pr-5 text-right space-x-3 whitespace-nowrap">
                      {b.jobStatus === 'done' && (
                        <button onClick={() => downloadBatch(b)} className="text-blue-600 hover:underline">Скачать</button>
                      )}
                      <button onClick={() => handleDelete(b)} className="text-red-600 hover:underline">Удалить</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-between mt-3 text-sm">
              <span className="text-gray-500">
                Стр. {page + 1} из {pageCount} · всего {total}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40 text-xs"
                >← Назад</button>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40 text-xs"
                >Вперёд →</button>
              </div>
            </div>
          )}
        </>
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
