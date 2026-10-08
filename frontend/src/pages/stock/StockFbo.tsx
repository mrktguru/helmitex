import { Fragment, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { FBO_STATUS, btnPrimary, btnSecondary, fmtDate } from './common';
import OzonPlacePicker, { Place } from './OzonPlacePicker';

const STEPS = ['Состав', 'Черновик Ozon', 'Слот', 'Грузоместа', 'Этикетки', 'Отгрузка'];
const STEP_OF: Record<string, number> = { DRAFT: 1, OZON_DRAFT: 2, BOOKED: 3, CARGOES_SET: 4, LABELS_READY: 5, SHIPPED: 6, COMPLETED: 6, CANCELLED: -1 };

const hm = (s: string) => s.slice(11, 16);
const dayLabel = (d: string) => new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit' });

export default function StockFbo() {
  const { id } = useParams<{ id: string }>();
  const [s, setS] = useState<any>(null);
  const [defaults, setDefaults] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<{ id: string; name: string } | null>(null);
  const [slots, setSlots] = useState<{ timezone: string | null; days: { date: string; slots: { from: string; to: string }[] }[] } | null>(null);
  const [slot, setSlot] = useState<{ from: string; to: string } | null>(null);
  const [log, setLog] = useState<any[] | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function load() {
    try { setS(await api.getFbo(id!)); } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); api.getOzonSettings().then((x) => setDefaults(x.defaults)); }, [id]);

  async function run(name: string, fn: () => Promise<any>) {
    setBusy(name); setError('');
    try { const r = await fn(); if (r?.id) setS(r); } catch (e: any) { setError(e.message); await load(); }
    setBusy(null);
  }

  async function dl(path: string) {
    setError('');
    try { await downloadFile(path, 'file'); } catch (e: any) { setError(e.message); }
  }

  const draftAgeMin = s?.draftCreatedAt ? (Date.now() - Date.parse(s.draftCreatedAt)) / 60000 : null;
  const draftExpired = draftAgeMin != null && draftAgeMin > 29;
  const warehouses: any[] = s?.draftWarehouses ?? [];

  async function loadSlots(storageId?: string) {
    setSlots(null); setSlot(null);
    await run('slots', async () => { setSlots(await api.fboTimeslots(id!, storageId)); });
  }
  // Для кросс-докинга слоты сразу, для прямой — после выбора склада
  useEffect(() => {
    if (s?.status === 'OZON_DRAFT' && s.supplyType === 'CROSSDOCK' && !draftExpired && !slots) loadSlots();
  }, [s?.status, s?.ozonDraftId]);

  if (error && !s) return <p className="text-red-600">{error}</p>;
  if (!s) return <p className="text-slate-500">Загрузка…</p>;

  const step = STEP_OF[s.status];
  const cancelled = s.status === 'CANCELLED';
  const units = s.cargoes.reduce((t: number, c: any) => t + c.quant.units, 0);
  const bySku = new Map<string, { name: string; offer: string; boxes: number; units: number }>();
  for (const c of s.cargoes) {
    const p = c.quant.quantType.productItem;
    const v = bySku.get(p.id) ?? { name: p.name, offer: p.spec?.ozonOfferId ?? '—', boxes: 0, units: 0 };
    v.boxes++; v.units += c.quant.units;
    bySku.set(p.id, v);
  }
  const quantIds = s.cargoes.map((c: any) => c.quantId).join(',');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/stock/fbo" className="text-slate-500 hover:text-slate-900 text-sm">← Поставки</Link>
        <h2 className="text-xl font-semibold">Поставка FBO <span className="font-mono text-base text-slate-500">{s.number}</span></h2>
        <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', FBO_STATUS[s.status].cls)}>{FBO_STATUS[s.status].label}</span>
        {s.ozonOrderNumber && <span className="text-sm text-slate-600">Заявка Ozon <b className="font-mono">{s.ozonOrderNumber}</b>{s.ozonStateLabel && ` · ${s.ozonStateLabel}`}</span>}
        <div className="flex-1" />
        {s.ozonOrderId && <button disabled={!!busy} onClick={() => run('sync', () => api.fboAction(id!, 'sync'))} className={btnSecondary}>{busy === 'sync' ? 'Обновляю…' : 'Обновить из Ozon'}</button>}
      </div>

      {!cancelled && (
        <div className="flex flex-wrap gap-1.5">
          {STEPS.map((t, i) => (
            <span key={t} className={clsx('text-xs px-2.5 py-1 rounded', i + 1 < step || s.status === 'COMPLETED' ? 'bg-green-100 text-green-800' : i + 1 === step ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>
              {i + 1} · {t}
            </span>
          ))}
        </div>
      )}

      {s.lastError && !cancelled && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">Последняя ошибка: {s.lastError}</div>
      )}

      {/* Состав */}
      <div className="bg-white rounded-xl border p-4 space-y-2">
        <h3 className="font-semibold text-sm">Состав: {s.cargoes.length} коробок · {units} шт</h3>
        <table className="w-full text-sm tabular-nums">
          <tbody>
            {[...bySku.values()].map((v) => (
              <tr key={v.offer} className="border-b last:border-0">
                <td className="py-1">{v.name}</td>
                <td className="py-1 font-mono text-xs text-slate-500">{v.offer}</td>
                <td className="py-1 text-right">{v.boxes} кор.</td>
                <td className="py-1 text-right">{v.units} шт</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.clusterName && (
          <p className="text-sm text-slate-600">
            {s.supplyType === 'CROSSDOCK' ? 'Кросс-докинг' : 'Прямая'} · {s.clusterName}
            {s.dropOffName && ` · отгрузка в ${s.dropOffName}`}{s.storageName && ` · склад ${s.storageName}`}
            {s.timeslotFrom && <> · слот <b>{dayLabel(s.timeslotFrom)} {hm(s.timeslotFrom)}–{hm(s.timeslotTo)}</b></>}
          </p>
        )}
      </div>

      {/* 2. Черновик */}
      {(s.status === 'DRAFT' || (s.status === 'OZON_DRAFT' && draftExpired)) && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <h3 className="font-semibold text-sm">{draftExpired ? 'Черновик Ozon устарел — создайте заново' : 'Куда везём'}</h3>
          {defaults !== null && (
            <OzonPlacePicker
              initial={s.ozonDraftId
                ? { supplyType: s.supplyType, clusterId: s.clusterId, clusterName: s.clusterName, dropOffWarehouseId: s.dropOffWarehouseId, dropOffName: s.dropOffName, dropOffType: s.dropOffType }
                : { ...defaults, ...(s.clusterId ? { clusterId: s.clusterId, clusterName: s.clusterName } : {}) }}
              busy={!!busy}
              saveLabel={busy === 'draft' ? 'Создаю черновик в Ozon…' : 'Создать черновик в Ozon'}
              onSave={(p: Place) => run('draft', () => api.fboDraft(id!, p))}
            />
          )}
          <p className="text-xs text-slate-500">Ozon проверит товары и рассчитает склады. Черновик живёт 30 минут — после него сразу выбирайте слот.</p>
        </div>
      )}

      {/* 3. Склад и слот */}
      {s.status === 'OZON_DRAFT' && !draftExpired && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Слот поставки</h3>
            <span className="text-xs text-slate-500">черновик действует ещё ~{Math.max(0, Math.round(29 - (draftAgeMin ?? 0)))} мин</span>
          </div>
          {s.supplyType === 'DIRECT' && (
            <div className="flex flex-wrap gap-2">
              {warehouses.filter((w) => w.storage_warehouse).map((w) => {
                const wid = String(w.storage_warehouse.warehouse_id);
                const ok = w.availability_status?.state === 'FULL_AVAILABLE';
                return (
                  <button key={wid} disabled={!ok} onClick={() => { setStorage({ id: wid, name: w.storage_warehouse.name }); loadSlots(wid); }}
                    className={clsx('border rounded-lg px-3 py-2 text-left text-sm', storage?.id === wid ? 'border-brand-500 bg-brand-50' : 'hover:bg-slate-50', !ok && 'opacity-40')}>
                    {w.storage_warehouse.name}<div className="text-xs text-slate-500">{ok ? 'доступен' : w.availability_status?.invalid_reason}</div>
                  </button>
                );
              })}
            </div>
          )}
          {busy === 'slots' && <p className="text-sm text-slate-500">Загружаю слоты…</p>}
          {slots && (slots.days.length === 0 ? <p className="text-sm text-amber-700">Свободных слотов на 4 недели нет.</p> : (
            <div className="space-y-2 max-h-96 overflow-auto">
              {slots.days.map((d) => (
                <div key={d.date} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-24 text-sm text-slate-600 shrink-0">{dayLabel(d.date)}</span>
                  {d.slots.map((x) => (
                    <button key={x.from} onClick={() => setSlot(x)}
                      className={clsx('text-xs border rounded px-2 py-1 tabular-nums', slot?.from === x.from ? 'bg-brand-600 border-brand-600 text-white' : 'hover:bg-brand-50')}>
                      {hm(x.from)}–{hm(x.to)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
          {slots?.timezone && <p className="text-xs text-slate-500">Время местное для пункта отгрузки ({slots.timezone}).</p>}
          <div className="flex gap-2">
            <button disabled={!slot || !!busy || (s.supplyType === 'DIRECT' && !storage)}
              onClick={() => run('book', () => api.fboBook(id!, { from: slot!.from, to: slot!.to, storageWarehouseId: storage?.id ?? null, storageName: storage?.name ?? null }))}
              className={btnPrimary}>
              {busy === 'book' ? 'Создаю заявку в Ozon…' : slot ? `Создать заявку на ${dayLabel(slot.from)} ${hm(slot.from)}` : 'Выберите слот'}
            </button>
          </div>
        </div>
      )}

      {/* 4–6. Грузоместа, этикетки, отгрузка */}
      {['BOOKED', 'CARGOES_SET', 'LABELS_READY', 'SHIPPED', 'COMPLETED'].includes(s.status) && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <h3 className="font-semibold text-sm">Грузоместа и этикетки</h3>
          <div className="flex flex-wrap gap-2">
            {['BOOKED', 'CARGOES_SET'].includes(s.status) && (
              <button disabled={!!busy} onClick={() => run('cargoes', () => api.fboAction(id!, 'cargoes'))} className={s.status === 'BOOKED' ? btnPrimary : btnSecondary}>
                {busy === 'cargoes' ? 'Передаю…' : s.status === 'BOOKED' ? `Передать ${s.cargoes.length} грузомест в Ozon` : 'Передать грузоместа заново'}
              </button>
            )}
            {['CARGOES_SET', 'LABELS_READY'].includes(s.status) && (
              <button disabled={!!busy} onClick={() => run('labels', () => api.fboAction(id!, 'labels'))} className={s.status === 'CARGOES_SET' ? btnPrimary : btnSecondary}>
                {busy === 'labels' ? 'Получаю этикетки…' : s.status === 'CARGOES_SET' ? 'Получить этикетки грузомест' : 'Получить этикетки заново'}
              </button>
            )}
            {s.labelS3Key && <button onClick={() => dl(`/stock/fbo/${id}/labels.pdf`)} className={btnPrimary}>Скачать стикеры Ozon ({s.cargoes.length})</button>}
            <button onClick={() => dl(`/stock/quant-labels.pdf?ids=${quantIds}`)} className={btnSecondary}>Этикетки квантов</button>
            <button onClick={() => dl(`/stock/quant-codes.csv?ids=${quantIds}`)} className={btnSecondary}>Коды ЧЗ поставки (CSV)</button>
          </div>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="py-1.5 font-medium w-10">№</th>
                <th className="py-1.5 font-medium">Квант (коробка)</th>
                <th className="py-1.5 font-medium">SKU</th>
                <th className="py-1.5 font-medium text-right">Шт</th>
                <th className="py-1.5 font-medium">Годен до</th>
                <th className="py-1.5 font-medium">Грузоместо Ozon</th>
              </tr>
            </thead>
            <tbody>
              {s.cargoes.map((c: any, i: number) => (
                <Fragment key={c.id}>
                  <tr className="border-b last:border-0">
                    <td className="py-1 text-slate-500">{i + 1}</td>
                    <td className="py-1"><Link to={`/stock/quants/${c.quantId}`} className="font-mono text-xs text-brand-700 hover:underline">{c.quant.number}</Link></td>
                    <td className="py-1">{c.quant.quantType.productItem.name}</td>
                    <td className="py-1 text-right">{c.quant.units}</td>
                    <td className="py-1">{fmtDate(c.quant.lot.expiresAt)}</td>
                    <td className="py-1 font-mono text-xs">{c.ozonCargoId ?? '—'}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
          {s.labelS3Key && <p className="text-xs text-slate-500">Стикеры Ozon в PDF идут в том же порядке, что строки таблицы: первый стикер — на коробку №1 и т. д.</p>}

          {['BOOKED', 'CARGOES_SET', 'LABELS_READY'].includes(s.status) && (
            <div className="border-t pt-3 flex flex-wrap items-center gap-3">
              <button disabled={!!busy || s.status !== 'LABELS_READY'} onClick={() => { if (confirm(`Отгрузить ${s.cargoes.length} коробок? Кванты будут списаны со склада.`)) run('ship', () => api.fboAction(id!, 'ship')); }} className={btnPrimary}>
                {busy === 'ship' ? 'Списываю…' : 'Отгружено — списать со склада'}
              </button>
              {s.status !== 'LABELS_READY' && <span className="text-xs text-slate-500">Сначала передайте грузоместа и получите стикеры.</span>}
            </div>
          )}
          {(s.status === 'SHIPPED' || s.status === 'COMPLETED') && (
            <p className="text-sm text-green-800">Отгружено {fmtDate(s.shippedAt)}. Статус заявки обновляется из Ozon автоматически каждые 15 минут.</p>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-3 items-center">
        {!['SHIPPED', 'COMPLETED', 'CANCELLED'].includes(s.status) && !confirmCancel && (
          <button onClick={() => setConfirmCancel(true)} className="text-sm text-red-600 hover:underline">Отменить поставку</button>
        )}
        {confirmCancel && (
          <span className="text-sm flex items-center gap-2">
            {s.ozonOrderId ? 'Заявка будет отменена в Ozon, кванты вернутся на склад.' : 'Кванты вернутся на склад.'}
            <button disabled={!!busy} onClick={() => { setConfirmCancel(false); run('cancel', () => api.fboAction(id!, 'cancel')); }} className="text-red-600 font-medium hover:underline">Да, отменить</button>
            <button onClick={() => setConfirmCancel(false)} className="text-slate-500 hover:underline">Нет</button>
          </span>
        )}
        <button onClick={async () => setLog(log ? null : await api.fboLog(id!))} className="text-sm text-slate-500 hover:underline">{log ? 'Скрыть журнал Ozon' : 'Журнал запросов Ozon'}</button>
      </div>
      {log && (
        <div className="bg-white rounded-xl border p-3 text-xs font-mono space-y-1 max-h-96 overflow-auto">
          {log.length === 0 ? 'Запросов не было' : log.map((l) => (
            <details key={l.id}>
              <summary className={clsx('cursor-pointer', l.status >= 400 || l.status === 0 ? 'text-red-600' : 'text-slate-700')}>
                {new Date(l.createdAt).toLocaleTimeString('ru-RU')} · {l.method} · {l.status} · {l.ms} мс
              </summary>
              <pre className="whitespace-pre-wrap break-all text-slate-600 bg-slate-50 p-2 rounded">{JSON.stringify({ request: l.request, response: l.response }, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
