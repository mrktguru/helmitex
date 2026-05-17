import { useEffect, useState } from 'react';
import { api } from '../api/client';
import CzUploadTab from './CzUploadTab';

interface Props { projectId: string; }
interface Stats { total: number; used: number; pending: number; }

/**
 * Compact CZ status card with a big "available" number + progress bar.
 * Expands into the full CzUploadTab on demand.
 */
export default function CzStatusCard({ projectId }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.getCzStats(projectId).then(setStats).catch(() => setStats(null));
  }, [projectId, expanded]);

  const percent = stats && stats.total > 0
    ? Math.round((stats.used / stats.total) * 100)
    : 0;

  return (
    <div className="bg-white rounded-xl border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Честный знак</h3>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-blue-600 hover:underline"
        >
          {expanded ? 'Свернуть' : 'Управление…'}
        </button>
      </div>
      {!stats || stats.total === 0 ? (
        <div className="text-center py-4">
          <p className="text-sm text-gray-500 mb-2">Коды ЧЗ ещё не загружены</p>
          <button
            onClick={() => setExpanded(true)}
            className="text-sm text-blue-600 hover:underline"
          >Загрузить PDF с кодами →</button>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-3xl font-bold text-green-600">{stats.pending}</span>
            <span className="text-sm text-gray-500">из {stats.total} доступно</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2 mb-1">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="text-xs text-gray-400">Использовано: {stats.used} ({percent}%)</p>
        </>
      )}

      {expanded && (
        <div className="mt-5 -mx-5 -mb-5 border-t pt-1 bg-gray-50/40 rounded-b-xl">
          <div className="px-1 py-1">
            <CzUploadTab projectId={projectId} />
          </div>
        </div>
      )}
    </div>
  );
}
