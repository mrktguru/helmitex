import { useEffect, useState } from 'react';
import { api } from '../api/client';
import CzUploadTab from './CzUploadTab';

interface Props { projectId: string; onCzChange?: () => void; }
interface Stats { total: number; used: number; pending: number; }

/**
 * CZ status card — always shows the full upload UI inline.
 * Compact stats line appears on top once codes exist.
 */
export default function CzStatusCard({ projectId, onCzChange }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);

  // Reload stats whenever parent signals a CZ change
  useEffect(() => {
    api.getCzStats(projectId).then(setStats).catch(() => setStats(null));
  }, [projectId]);

  function handleCzChange() {
    api.getCzStats(projectId).then(setStats).catch(() => {});
    onCzChange?.();
  }

  const percent = stats && stats.total > 0
    ? Math.round((stats.used / stats.total) * 100)
    : 0;

  return (
    <div className="bg-white rounded-xl border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Честный знак</h3>
        {stats && stats.total > 0 && (
          <span className="text-xs text-gray-500">
            <strong className="text-green-600">{stats.pending}</strong> из {stats.total} · {percent}% использовано
          </span>
        )}
      </div>
      {stats && stats.total > 0 && (
        <div className="w-full bg-gray-100 rounded-full h-1.5 mb-4">
          <div
            className="bg-blue-500 h-1.5 rounded-full transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <CzUploadTab projectId={projectId} onUploaded={handleCzChange} />
    </div>
  );
}
