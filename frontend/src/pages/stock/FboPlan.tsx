import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, fmtQty, inputCls } from './common';

const HORIZONS = [14, 28, 42];
const MAX_BOXES = 30;
const GRADE: Record<string, [string, string]> = {
  DEFICIT: ['bg-red-50 text-red-700', 'дефицит'], WAS_DEFICIT: ['bg-red-50 text-red-700', 'нет в наличии'],
  POPULAR: ['bg-emerald-50 text-emerald-700', 'ходовой'], ACTUAL: ['bg-emerald-50 text-emerald-700', 'в норме'],
  SURPLUS: ['bg-amber-50 text-amber-800', 'избыток'], WAS_POPULAR: ['bg-slate-100 text-slate-500', 'нет в наличии'],
  WAS_ACTUAL: ['bg-slate-100 text-slate-500', 'нет в наличии'], WAS_NO_SALES: ['bg-slate-100 text-slate-500', 'без продаж'],
};

const COLLAPSE_KEY = 'fbo-plan-collapsed';
function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); } catch { return new Set(); }
}

// План поставок по потребности Ozon: по умолчанию везде 0, рекомендация подставляется кнопкой
export default function FboPlan() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [h, setH] = useState(28);
  const [src, setSrc] = useState<'calc' | 'ozon'>('calc');
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function load(refresh = false) {
    setLoading(true); setError('');
    try { setData(await api.getFboDemand(refresh)); } catch (e: any) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* приватный режим */ } }, [collapsed]);

  const skus: any[] = data?.skus ?? [];
  const vOf = (s: any) => s.variants.find((v: any) => v.id === variant[s.itemId]) ?? s.variants[0] ?? null;
  const key = (s: any, r: any) => `${s.itemId}|${r.clusterId}`;
  const get = (s: any, r: any) => qty.get(key(s, r)) ?? 0;
  const set = (k: string, v: number) => setQty((m) => { const n = new Map(m); if (v > 0) n.set(k, v); else n.delete(k); return n; });

  function recommend(s: any, r: any): number {
    const v = vOf(s);
    if (!v) return 0;
    const units = src === 'ozon' ? (r.rec ?? 0) : Math.max(0, r.ads * h - r.stock - r.transit);
    return Math.ceil(units / v.units - 1e-9);
  }
  function fill(list: any[], mode: 'rec' | 'zero') {
    setQty((m) => {
      const n = new Map(m);
      for (const s of list) for (const r of s.rows) {
        const q = mode === 'rec' ? recommend(s, r) : 0;
        if (q > 0) n.set(key(s, r), q); else n.delete(key(s, r));
      }
      return n;
    });
  }
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Корзина: по кластерам, нехватка квантов по вариантам
  const cart = useMemo(() => {
    const groups = new Map<string, { name: string; lines: { s: any; v: any; q: number }[]; boxes: number }>();
    const perVariant = new Map<string, { s: any; v: any; q: number }>();
    for (const s of skus) {
      const v = vOf(s);
      if (!v) continue;
      for (const r of s.rows) {
        const q = get(s, r);
        if (!q) continue;
        const g = groups.get(r.clusterId) ?? { name: r.clusterName as string, lines: [] as { s: any; v: any; q: number }[], boxes: 0 };
        g.lines.push({ s, v, q }); g.boxes += q;
        groups.set(r.clusterId, g);
        const pv = perVariant.get(v.id) ?? { s, v, q: 0 };
        pv.q += q; perVariant.set(v.id, pv);
      }
    }
    const list = [...groups.entries()].map(([id, g]) => ({ id, ...g })).sort((a, b) => b.boxes - a.boxes);
    const shortage = [...perVariant.values()].filter((x) => x.q > x.v.inStock);
    return {
      list, shortage,
      boxes: list.reduce((t, g) => t + g.boxes, 0),
      supplies: list.reduce((t, g) => t + Math.ceil(g.boxes / MAX_BOXES), 0),
    };
  }, [skus, qty, variant]);

  async function create() {
    setBusy(true); setError(''); setResult(null);
    try {
      const items = cart.list.flatMap((g) => g.lines.map((l) => ({ clusterId: g.id, clusterName: g.name, quantTypeId: l.v.id, count: l.q })));
      const r = await api.createFboPlan(items);
      setResult(r);
      setQty(new Map());
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  if (!data && loading) return <p className="text-slate-500 p-4">Загружаю потребность из Ozon…</p>;
  if (!data) return <div className="p-4"><p className="text-red-600 mb-3">{error || 'Нет данных'}</p><button onClick={() => load(true)} className={btnSecondary}>Повторить</button></div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <span className="text-sm text-slate-500">Запас на</span>
        <div className="inline-flex border border-slate-200 rounded-lg overflow-hidden">
          {HORIZONS.map((x) => (
            <button key={x} onClick={() => setH(x)} className={clsx('px-3 py-1.5 text-sm', h === x ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{x} дн.</button>
          ))}
        </div>
        <select value={src} onChange={(e) => setSrc(e.target.value as 'calc' | 'ozon')} className={inputCls}>
          <option value="calc">Рекомендация: по продажам за 28 дн.</option>
          <option value="ozon" disabled={!!data.recError}>Рекомендация Ozon{data.recError ? ' (недоступна)' : ''}</option>
        </select>
        <button onClick={() => fill(skus, 'rec')} className="text-sm text-brand-700 hover:underline">Заполнить всё по рекомендации</button>
        <button onClick={() => fill(skus, 'zero')} className="text-sm text-slate-500 hover:underline">Обнулить всё</button>
        <div className="flex-1" />
        <button onClick={() => setCollapsed(new Set(skus.map((s) => s.itemId)))} className="text-sm text-slate-500 hover:underline">Свернуть все</button>
        <button onClick={() => setCollapsed(new Set())} className="text-sm text-slate-500 hover:underline">Развернуть все</button>
        <span className="text-xs text-slate-400">Ozon: {new Date(data.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <button disabled={loading} onClick={() => load(true)} className={btnSecondary}>{loading ? 'Обновляю…' : 'Обновить из Ozon'}</button>
      </div>

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm space-y-1">
          {result.created.length > 0 && <div>Создано поставок: {result.created.map((c: any) => <Link key={c.id} to={`/stock/fbo/${c.id}`} className="font-mono text-brand-700 hover:underline mr-3">{c.number} · {c.clusterName} · {c.boxes} кор.</Link>)}</div>}
          {result.failed.length > 0 && <div className="text-red-700">Не создано: {result.failed.map((f: any) => `${f.clusterName} — ${f.error}`).join('; ')}</div>}
          <div className="text-slate-600">Откройте поставку, чтобы создать черновик в Ozon и выбрать слот — кластер уже выбран.</div>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <div className="space-y-3 min-w-0">
          {skus.length === 0 && <p className="bg-white border border-slate-200 rounded-xl p-5 text-sm text-slate-500">Нет SKU с артикулом Ozon. Задайте артикул в <Link to="/stock/catalog?type=PRODUCT" className="text-brand-700 hover:underline">карточках SKU</Link>.</p>}
          {skus.map((s) => {
            const v = vOf(s);
            const isCol = collapsed.has(s.itemId);
            const total = s.rows.reduce((t: number, r: any) => t + get(s, r), 0);
            const recTotal = s.rows.reduce((t: number, r: any) => t + recommend(s, r), 0);
            const deficit = s.rows.filter((r: any) => r.ads > 0.04 && r.idc < 14).length;
            const lack = v ? Math.max(0, total - v.inStock) : 0;
            return (
              <section key={s.itemId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-slate-50/80 border-b border-slate-200">
                  <button onClick={() => toggle(s.itemId)} className="flex items-center gap-2 text-left min-w-0" aria-expanded={!isCol}>
                    <span className="text-slate-400 w-3">{isCol ? '▸' : '▾'}</span>
                    <span className="font-semibold truncate">{s.name}</span>
                    <span className="font-mono text-xs text-slate-400">{s.offerId}</span>
                  </button>
                  {deficit > 0 && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-700">дефицит в {deficit} кл.</span>}
                  <div className="flex-1" />
                  {s.variants.length > 1 && (
                    <select value={v?.id ?? ''} onChange={(e) => setVariant({ ...variant, [s.itemId]: e.target.value })} className={inputCls + ' text-xs py-1'}>
                      {s.variants.map((x: any) => <option key={x.id} value={x.id}>{x.name} ({x.units} шт)</option>)}
                    </select>
                  )}
                  {v ? (
                    <span className="text-xs text-slate-500 tabular-nums">
                      на складе <b className="text-slate-800">{v.inStock}</b> кв. по {v.units} шт{s.loose > 0 && ` · россыпью ${fmtQty(s.loose, 0)} шт`}
                    </span>
                  ) : <Link to={`/stock/catalog/${s.itemId}`} className="text-xs text-red-600 hover:underline">нет варианта кванта</Link>}
                  <span className={clsx('text-sm tabular-nums', total ? 'font-semibold' : 'text-slate-400')}>к отгрузке {total} кв.</span>
                  {lack > 0 && <span className="text-xs text-amber-700">не хватает {lack} кв.</span>}
                </div>
                {!isCol && (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm tabular-nums">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100">
                            <th className="px-4 py-2 font-medium">Кластер</th>
                            <th className="px-3 py-2 font-medium">Запас, дн.</th>
                            <th className="px-3 py-2 font-medium text-right">Продаж/день</th>
                            <th className="px-3 py-2 font-medium text-right">Остаток Ozon</th>
                            <th className="px-3 py-2 font-medium text-right">Ozon советует</th>
                            <th className="px-3 py-2 font-medium text-right">Рекоменд.</th>
                            <th className="px-4 py-2 font-medium text-right">Квантов</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.rows.map((r: any) => {
                            const k = key(s, r);
                            const q = get(s, r);
                            const rec = recommend(s, r);
                            const sells = r.ads > 0.04;
                            const w = Math.min(100, (r.idc / 90) * 100);
                            const col = !sells ? 'bg-slate-300' : r.idc < 14 ? 'bg-red-500' : r.idc < 28 ? 'bg-amber-500' : 'bg-emerald-500';
                            const g = GRADE[r.grade];
                            return (
                              <tr key={k} className={clsx('border-b border-slate-100 last:border-0', q > 0 && 'bg-brand-50/50')}>
                                <td className="px-4 py-1.5">
                                  {r.clusterName}
                                  {g && <span className={clsx('ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full', g[0])}>{g[1]}</span>}
                                </td>
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <div className="relative h-2 w-28 rounded bg-slate-100" title={`${r.idc} дн., горизонт ${h} дн.`}>
                                      <i className={clsx('absolute inset-y-0 left-0 rounded', col)} style={{ width: `${Math.max(sells ? w : 0, 2)}%` }} />
                                      <u className="absolute -inset-y-0.5 w-0.5 bg-slate-700/50" style={{ left: `${Math.min(100, (h / 90) * 100)}%` }} />
                                    </div>
                                    <span className={clsx('w-10', !sells && 'text-slate-400')}>{sells ? fmtQty(Math.min(r.idc, 999), 0) : '—'}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-right">{fmtQty(r.ads, 1)}</td>
                                <td className="px-3 py-1.5 text-right">{fmtQty(r.stock, 0)}{r.transit > 0 && <span className="text-xs text-slate-400"> +{fmtQty(r.transit, 0)}</span>}</td>
                                <td className="px-3 py-1.5 text-right text-slate-500">{r.rec != null ? `${fmtQty(r.rec, 0)} шт` : '—'}</td>
                                <td className="px-3 py-1.5 text-right">
                                  {rec > 0 ? (
                                    <button onClick={() => set(k, rec)} title="Подставить" className={clsx('text-xs px-2 py-0.5 rounded border', q === rec ? 'border-brand-200 text-brand-700' : 'border-slate-200 text-slate-600 hover:border-brand-500 hover:text-brand-700')}>
                                      {rec} кв.
                                    </button>
                                  ) : <span className="text-slate-300">0</span>}
                                </td>
                                <td className="px-4 py-1.5 text-right">
                                  <span className="inline-flex items-center border border-slate-200 rounded-lg overflow-hidden bg-white">
                                    <button onClick={() => set(k, Math.max(0, q - 1))} className="w-7 py-1 text-slate-500 hover:bg-slate-50" aria-label="Меньше">−</button>
                                    <input value={q || ''} placeholder="0" inputMode="numeric"
                                      onChange={(e) => set(k, Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 0))}
                                      className="w-10 text-center font-semibold outline-none bg-transparent" aria-label={`Квантов в ${r.clusterName}`} />
                                    <button onClick={() => set(k, q + 1)} className="w-7 py-1 text-slate-500 hover:bg-slate-50" aria-label="Больше">+</button>
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex flex-wrap gap-4 px-4 py-2 border-t border-slate-100 text-sm">
                      <button disabled={!recTotal} onClick={() => fill([s], 'rec')} className="text-brand-700 hover:underline disabled:text-slate-300">Заполнить по рекомендации ({recTotal} кв.)</button>
                      <button disabled={!total} onClick={() => fill([s], 'zero')} className="text-slate-500 hover:underline disabled:text-slate-300">Обнулить</button>
                    </div>
                  </>
                )}
              </section>
            );
          })}
        </div>

        <aside className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 xl:sticky xl:top-4">
          <h3 className="font-semibold">Корзина поставок</h3>
          <div className="tabular-nums"><span className="text-2xl font-bold">{cart.boxes}</span> <span className="text-sm text-slate-500">коробок · {cart.supplies} поставок · {cart.list.length} кластеров</span></div>
          {cart.list.length === 0 ? <p className="text-sm text-slate-500">Пусто. Укажите количество квантов или нажмите «Рекоменд.» в нужных строках.</p> : cart.list.map((g) => (
            <div key={g.id} className="border-t border-slate-100 pt-2 space-y-0.5">
              <div className="flex justify-between text-sm"><b>{g.name}</b><span className="tabular-nums">{g.boxes} кор.{g.boxes > MAX_BOXES && ` · ${Math.ceil(g.boxes / MAX_BOXES)} пост.`}</span></div>
              {g.lines.map((l) => <div key={l.v.id} className="flex justify-between text-xs text-slate-500"><span className="truncate pr-2">{l.s.name}</span><span className="tabular-nums">{l.q} кв.</span></div>)}
            </div>
          ))}
          {cart.shortage.length > 0 && (
            <div className="border-t border-slate-100 pt-2 space-y-1">
              <b className="text-sm text-amber-700">Не хватает квантов</b>
              {cart.shortage.map((x) => (
                <div key={x.v.id} className="flex justify-between text-xs"><span className="truncate pr-2">{x.v.name}</span><span className="tabular-nums">нужно {x.q}, есть {x.v.inStock}</span></div>
              ))}
              <Link to="/stock/quant/new" className="text-xs text-brand-700 hover:underline">Собрать кванты →</Link>
            </div>
          )}
          <button disabled={busy || !cart.boxes || cart.shortage.length > 0} onClick={create} className={clsx(btnPrimary, 'w-full')}>
            {busy ? 'Создаю…' : cart.boxes ? `Создать ${cart.supplies} ${cart.supplies === 1 ? 'поставку' : 'поставок'}` : 'Создать поставки'}
          </button>
          <p className="text-xs text-slate-500">Кванты резервируются (старые партии первыми), в каждой поставке уже выбран кластер. Больше 30 коробок в кластер — делится на несколько поставок.</p>
        </aside>
      </div>
    </div>
  );
}
