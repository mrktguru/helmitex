import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from './StockLayout';
import { FBO_STATUS, btnPrimary, btnSecondary, fmtDate, inputCls } from './common';
import OzonPlacePicker, { Place } from './OzonPlacePicker';

export default function StockFboList() {
  const navigate = useNavigate();
  const [list, setList] = useState<any[] | null>(null);
  const [types, setTypes] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [settings, setSettings] = useState<{ configured: boolean; defaults: any } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const [l, t, st] = await Promise.all([api.getFboList(), api.getQuantTypes(), api.getOzonSettings()]);
    setList(l); setTypes(t.filter((x: any) => !x.archived && x.inStock > 0)); setSettings(st);
  }
  useEffect(() => { load(); }, []);

  const total = Object.values(counts).reduce((s, v) => s + (Number(v) || 0), 0);

  async function create() {
    setError(''); setBusy(true);
    try {
      const s = await api.createFbo({
        picks: Object.entries(counts).map(([quantTypeId, v]) => ({ quantTypeId, count: Number(v) || 0 })).filter((p) => p.count > 0),
        comment: comment || null,
      });
      navigate(`/stock/fbo/${s.id}`);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function saveSettings(p: Place) {
    await api.saveOzonSettings(p);
    setSettings((s) => (s ? { ...s, defaults: p } : s));
    setShowSettings(false);
  }

  const d = settings?.defaults;

  return (
    <div className="space-y-4">
      <PageHeader title="Отгрузки FBO" hint="Поставки на склады Ozon: кванты → черновик → слот → грузоместа → стикеры → отгрузка." />
      {settings && !settings.configured && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">Ozon API не настроен на сервере (OZON_CLIENT_ID / OZON_API_KEY).</p>
      )}

      <div className="bg-white rounded-xl border p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Новая поставка FBO</h3>
          <div className="text-sm text-slate-600">
            По умолчанию: {d?.clusterName ? <>{d.supplyType === 'CROSSDOCK' ? 'кросс-докинг' : 'прямая'} · {d.clusterName}{d.dropOffName && ` · через ${d.dropOffName}`}</> : 'не задано'}
            <button onClick={() => setShowSettings((v) => !v)} className="ml-3 text-brand-600 hover:underline">{showSettings ? 'Скрыть' : 'Настроить'}</button>
          </div>
        </div>
        {showSettings && settings && (
          <div className="border rounded-lg p-3 bg-slate-50">
            <OzonPlacePicker initial={d} onSave={saveSettings} saveLabel="Сохранить по умолчанию" />
          </div>
        )}
        {types.length === 0 ? (
          <p className="text-sm text-slate-500">Нет собранных квантов на складе. <Link to="/stock/quant/new" className="text-brand-600 hover:underline">Собрать кванты</Link></p>
        ) : (
          <>
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                  <th className="py-2 font-medium">Тип кванта</th>
                  <th className="py-2 font-medium">Артикул Ozon</th>
                  <th className="py-2 font-medium text-right">На складе</th>
                  <th className="py-2 font-medium text-right w-32">В поставку, кв.</th>
                  <th className="py-2 font-medium text-right">Единиц</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => {
                  const offer = t.productItem.spec?.ozonOfferId;
                  const ok = !!t.productItem.spec?.ozonSku;
                  return (
                    <tr key={t.id} className="border-b last:border-0">
                      <td className="py-1.5">{t.name}</td>
                      <td className="py-1.5 font-mono text-xs">{ok ? offer : <Link to={`/stock/catalog/${t.productItemId}`} className="text-red-600 hover:underline font-sans">не задан</Link>}</td>
                      <td className="py-1.5 text-right">{t.inStock}</td>
                      <td className="py-1.5 text-right">
                        <input disabled={!ok} value={counts[t.id] ?? ''} placeholder="0"
                          onChange={(e) => setCounts({ ...counts, [t.id]: String(Math.min(Number(e.target.value.replace(/\D/g, '')) || 0, t.inStock) || '') })}
                          className={inputCls + ' w-20 text-right'} />
                      </td>
                      <td className="py-1.5 text-right">{(Number(counts[t.id]) || 0) * t.unitsPerQuant || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-slate-500 flex-1 min-w-[200px]">Комментарий
                <input value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} />
              </label>
              <button disabled={busy || total === 0 || total > 30} onClick={create} className={btnPrimary}>Подобрать {total || ''} кв. и продолжить</button>
            </div>
            {total > 30 && <p className="text-sm text-red-600">Ozon принимает не больше 30 коробок в одной поставке.</p>}
            <p className="text-xs text-slate-500">Кванты подбираются по FEFO и резервируются. 1 квант = 1 коробка = 1 грузоместо со своим стикером Ozon.</p>
          </>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        {!list ? <p className="p-6 text-slate-500">Загрузка…</p> : list.length === 0 ? <p className="p-6 text-slate-500">Поставок пока нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="px-3 py-2 font-medium">Поставка</th>
                <th className="px-3 py-2 font-medium">Заявка Ozon</th>
                <th className="px-3 py-2 font-medium">Куда</th>
                <th className="px-3 py-2 font-medium">Слот</th>
                <th className="px-3 py-2 font-medium text-right">Коробок / ед.</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">Ozon</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} onClick={() => navigate(`/stock/fbo/${s.id}`)} className="border-b last:border-0 cursor-pointer hover:bg-brand-50/40">
                  <td className="px-3 py-2"><span className="font-mono text-xs">{s.number}</span><div className="text-xs text-slate-400">{fmtDate(s.createdAt)}</div></td>
                  <td className="px-3 py-2 font-mono text-xs">{s.ozonOrderNumber ?? '—'}</td>
                  <td className="px-3 py-2">{s.clusterName ?? '—'}{s.dropOffName && <div className="text-xs text-slate-500">через {s.dropOffName}</div>}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{s.timeslotFrom ? `${s.timeslotFrom.slice(8, 10)}.${s.timeslotFrom.slice(5, 7)} ${s.timeslotFrom.slice(11, 16)}` : '—'}</td>
                  <td className="px-3 py-2 text-right">{s.boxes} / {s.units}</td>
                  <td className="px-3 py-2"><span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', FBO_STATUS[s.status].cls)}>{FBO_STATUS[s.status].label}</span></td>
                  <td className="px-3 py-2 text-slate-600">{s.ozonStateLabel ?? '—'}{s.lastError && <span className="text-red-600" title={s.lastError}> ⚠</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <button onClick={load} className={btnSecondary}>Обновить</button>
    </div>
  );
}
