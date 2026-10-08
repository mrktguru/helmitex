import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, inputCls } from './common';

export interface Place {
  supplyType: 'CROSSDOCK' | 'DIRECT';
  clusterId: string | null;
  clusterName: string | null;
  dropOffWarehouseId: string | null;
  dropOffName: string | null;
  dropOffType: string | null;
}

// Выбор схемы поставки, кластера и пункта отгрузки (для кросс-докинга)
export default function OzonPlacePicker({ initial, onSave, saveLabel, busy }: {
  initial?: Partial<Place> | null; onSave: (p: Place) => void | Promise<void>; saveLabel: string; busy?: boolean;
}) {
  const [p, setP] = useState<Place>({
    supplyType: initial?.supplyType ?? 'CROSSDOCK', clusterId: initial?.clusterId ?? null, clusterName: initial?.clusterName ?? null,
    dropOffWarehouseId: initial?.dropOffWarehouseId ?? null, dropOffName: initial?.dropOffName ?? null, dropOffType: initial?.dropOffType ?? null,
  });
  const [clusters, setClusters] = useState<{ id: string; name: string; country: string }[]>([]);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => { api.getOzonClusters().then(setClusters).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (search.trim().length < 4) { setFound([]); return; }
    const t = setTimeout(() => api.searchOzonDropoff(search.trim()).then(setFound).catch((e) => setError(e.message)), 400);
    return () => clearTimeout(t);
  }, [search]);

  async function fromLast() {
    setError('');
    try {
      const w = await api.getOzonLastDropoff();
      if (!w) { setError('Не нашёл прошлых кросс-докинг заявок'); return; }
      const c = clusters.find((x) => x.id === w.clusterId);
      setP({ ...p, supplyType: 'CROSSDOCK', dropOffWarehouseId: w.id, dropOffName: w.name, dropOffType: w.type, ...(c ? { clusterId: c.id, clusterName: c.name } : {}) });
    } catch (e: any) { setError(e.message); }
  }

  const ready = p.clusterId && (p.supplyType === 'DIRECT' || p.dropOffWarehouseId);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Схема
          <select value={p.supplyType} onChange={(e) => setP({ ...p, supplyType: e.target.value as Place['supplyType'] })} className={inputCls}>
            <option value="CROSSDOCK">Кросс-докинг (через пункт отгрузки)</option>
            <option value="DIRECT">Прямая (на склад Ozon)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Кластер размещения
          <select value={p.clusterId ?? ''} onChange={(e) => setP({ ...p, clusterId: e.target.value || null, clusterName: clusters.find((c) => c.id === e.target.value)?.name ?? null })} className={inputCls}>
            <option value="">— выберите —</option>
            {clusters.filter((c) => c.country === 'Россия').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <optgroup label="СНГ">{clusters.filter((c) => c.country !== 'Россия').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
          </select>
        </label>
        {p.supplyType === 'CROSSDOCK' && (
          <div className="flex flex-col gap-1 text-xs text-slate-500">Пункт отгрузки
            {p.dropOffWarehouseId ? (
              <div className="flex items-center gap-2 text-sm text-slate-900 py-1.5">
                <span>{p.dropOffName}</span>
                <button onClick={() => setP({ ...p, dropOffWarehouseId: null, dropOffName: null, dropOffType: null })} className="text-xs text-brand-600 hover:underline">сменить</button>
              </div>
            ) : (
              <div className="relative">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Точное название, напр. РОЩИНО_31" className={inputCls + ' w-full'} />
                {found.length > 0 && (
                  <div className="absolute z-10 bg-white border rounded-lg shadow mt-1 w-full max-h-60 overflow-auto">
                    {found.map((w) => (
                      <button key={w.id} onClick={() => { setP({ ...p, dropOffWarehouseId: w.id, dropOffName: w.name, dropOffType: w.type }); setSearch(''); }}
                        className="block w-full text-left px-3 py-2 hover:bg-brand-50 text-sm text-slate-900">
                        {w.name}<div className="text-xs text-slate-500">{w.address}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={!ready || busy} onClick={() => onSave(p)} className={btnPrimary}>{saveLabel}</button>
        <button onClick={fromLast} className={btnSecondary}>Как в последней заявке Ozon</button>
      </div>
    </div>
  );
}
