import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from '../stock/StockLayout';
import ProductList from './ProductList';
import SourceFunnel from './SourceFunnel';
import DailyCharts, { Marker } from './DailyCharts';
import PriceCard from './PriceCard';
import Journal, { entryDay } from './Journal';
import NewCampaignModal from './NewCampaignModal';
import { addDays, delta, deltaPp, longDate, pct, rub, fmt } from './util';

type Preset = { key: string; label: string; range: (last: string) => [string, string] };
const PRESETS: Preset[] = [
  { key: '7', label: '7 дней', range: (l) => [addDays(l, -6), l] },
  { key: '14', label: '14 дней', range: (l) => [addDays(l, -13), l] },
  { key: '28', label: '28 дней', range: (l) => [addDays(l, -27), l] },
  { key: 'month', label: 'Этот месяц', range: (l) => [l.slice(0, 8) + '01', l] },
  { key: 'prev', label: 'Прошлый месяц', range: (l) => { const end = addDays(l.slice(0, 8) + '01', -1); return [end.slice(0, 8) + '01', end]; } },
];

export default function AdsAnalytics() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<{ seller: boolean; perf: boolean; lastDay: string } | null>(null);
  const [products, setProducts] = useState<any[] | null>(null);
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState<'list' | 'report' | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [newCampaign, setNewCampaign] = useState(false);
  const [focus, setFocus] = useState<{ date: string; key: number } | null>(null);
  const reqId = useRef(0);

  const last = status?.lastDay ?? '';
  const from = params.get('from') ?? (last ? addDays(last, -13) : '');
  const to = params.get('to') ?? last;
  const sku = params.get('sku') ?? products?.[0]?.sku ?? null;
  const setParam = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v == null) n.delete(k); else n.set(k, v); }
    setParams(n, { replace: true });
  };

  useEffect(() => { api.adsStatus().then(setStatus).catch((e) => setError(e.message)); }, []);

  async function loadList(refresh = false) {
    if (!from || !to) return;
    setLoading('list'); setError('');
    try { setProducts((await api.adsProducts(from, to, refresh)).products); } catch (e: any) { setError(e.message); }
    setLoading(null);
  }
  async function loadReport() {
    if (!sku || !from || !to) return;
    const id = ++reqId.current;
    setLoading('report'); setError('');
    try {
      const r = await api.adsReport(sku, from, to);
      if (id === reqId.current) setReport(r);
    } catch (e: any) { if (id === reqId.current) setError(e.message); }
    if (id === reqId.current) setLoading(null);
  }
  useEffect(() => { loadList(); }, [from, to]);
  useEffect(() => { if (products) loadReport(); }, [sku, from, to, products != null]);

  async function refresh() { await loadList(true); await loadReport(); }
  async function changed() { await loadReport(); api.adsProducts(from, to).then((r) => setProducts(r.products)).catch(() => {}); }

  const activePreset = PRESETS.find((p) => last && p.range(last)[0] === from && p.range(last)[1] === to)?.key;

  const markers: Marker[] = useMemo(() => {
    if (!report) return [];
    const dates = new Set(report.series.map((s: any) => s.date));
    const numbered = [...report.journal].sort((a: any, b: any) => a.at.localeCompare(b.at)).map((e: any, i: number) => ({ date: entryDay(e.at), n: i + 1, text: e.text, auto: false }));
    return [
      ...numbered.filter((m) => dates.has(m.date)),
      ...report.anomalies.map((a: any, i: number) => ({ date: a.date, n: 1000 + i, text: a.text, auto: true })),
    ];
  }, [report]);

  const k = report?.kpi;
  const tiles = k ? [
    { label: 'Заказы', value: fmt(k.cur.orders), d: delta(k.cur.orders, k.prev.orders), sub: 'шт, по дате заказа' },
    { label: 'Выручка', value: rub(k.cur.revenue), d: delta(k.cur.revenue, k.prev.revenue), sub: 'заказано по цене продавца' },
    { label: 'Реклама', value: rub(k.cur.adSpend), d: delta(k.cur.adSpend, k.prev.adSpend, false), sub: 'клики + оплата за заказ' },
    { label: 'ДРР', value: pct(k.cur.drr), d: deltaPp(k.cur.drr, k.prev.drr, false), sub: k.cur.breakEvenDrr != null ? `предел ${pct(k.cur.breakEvenDrr)}` : 'реклама / выручка', alert: k.cur.drr != null && k.cur.breakEvenDrr != null && k.cur.drr > k.cur.breakEvenDrr },
    { label: 'Выплата Ozon', value: rub(k.cur.payout), d: delta(k.cur.payout, k.prev.payout), sub: `${fmt(k.cur.accrQty)} шт по начислениям, до рекламы` },
    { label: 'Прибыль после рекламы', value: rub(k.cur.profit), d: delta(k.cur.profit, k.prev.profit), sub: 'выплата − реклама − себестоимость', alert: k.cur.profit != null && k.cur.profit < 0 },
  ] : [];

  return (
    <div className="space-y-4">
      <PageHeader title="Аналитика рекламы" hint="Как на продажи влияют кампании, ставки, цена и акции. Данные Ozon загружаются по дням и хранятся в портале; изменения из этого раздела сразу уходят в Ozon и пишутся в журнал." />

      {status && (!status.seller || !status.perf) && (
        <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-3 text-sm">
          {!status.perf && 'Не подключён Ozon Performance API (реклама): нужны OZON_PERF_CLIENT_ID и OZON_PERF_CLIENT_SECRET в .env сервера. '}
          {!status.seller && 'Не подключён Seller API: нужны OZON_CLIENT_ID и OZON_API_KEY.'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="inline-flex flex-wrap border border-slate-200 rounded-lg overflow-hidden">
          {PRESETS.map((p) => (
            <button key={p.key} disabled={!last} onClick={() => { const [f, t] = p.range(last); setParam({ from: f, to: t }); }}
              className={clsx('px-3 py-1.5 text-sm', activePreset === p.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{p.label}</button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span>с</span>
          <input type="date" value={from} max={to || last} onChange={(e) => e.target.value && setParam({ from: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span>по</span>
          <input type="date" value={to} min={from} max={last} onChange={(e) => e.target.value && setParam({ to: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </label>
        <span className="text-xs text-slate-500">сравнение с предыдущими {report ? `${report.series.length} дн. (${longDate(report.period.prevFrom)} — ${longDate(report.period.prevTo)})` : 'днями той же длины'}</span>
        <div className="flex-1" />
        {loading && <span className="text-xs text-slate-500">{loading === 'list' ? 'Загружаю данные Ozon…' : 'Строю отчёт…'}</span>}
        <button disabled={!!loading} onClick={refresh} className="border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium">Обновить из Ozon</button>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{error}</p>}
      {toast && (
        <div className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm">
          <span>{toast}</span><button onClick={() => setToast('')} className="text-slate-500 hover:text-slate-800" aria-label="Скрыть">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)] gap-4 items-start">
        <ProductList products={products} sku={sku} onSelect={(s) => setParam({ sku: s })} loading={loading === 'list'} />

        <div className="space-y-4 min-w-0">
          {!report && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
              {loading ? <>Загружаю данные из Ozon по дням. Первый раз за период это может занять 1–3 минуты — дальше данные берутся из портала.</> : products?.length === 0 ? 'Нет товаров для анализа: свяжите SKU с Ozon в справочнике.' : 'Выберите товар слева.'}
            </div>
          )}

          {report && (
            <div className={clsx('space-y-4 transition-opacity', loading === 'report' && 'opacity-60')}>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold tracking-tight">{report.product.name}</h2>
                  <div className="text-xs text-slate-500 font-mono">SKU {report.product.sku}{report.product.offerId && ` · ${report.product.offerId}`}</div>
                </div>
                <span className="text-xs text-slate-400">{report.syncedAt && `Ozon: ${new Date(report.syncedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}</span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3">
                {tiles.map((t) => (
                  <div key={t.label} className={clsx('bg-white rounded-xl border px-4 py-3', t.alert ? 'border-red-300' : 'border-slate-200')}>
                    <div className="text-xs text-slate-500">{t.label}</div>
                    <div className={clsx('text-xl font-bold tabular-nums tracking-tight mt-0.5', t.alert && 'text-red-600')}>{t.value}</div>
                    <div className="flex flex-wrap gap-x-2 text-xs mt-0.5">
                      {t.d && <span className={clsx('tabular-nums font-medium', t.d.good === true && 'text-green-700', t.d.good === false && 'text-red-600', t.d.good == null && 'text-slate-500')}>{t.d.text}</span>}
                      <span className="text-slate-400">{t.sub}</span>
                    </div>
                  </div>
                ))}
              </div>

              <SourceFunnel report={report} onChanged={changed} onNew={() => setNewCampaign(true)} />

              <DailyCharts series={report.series} markers={markers} onMarker={(date) => setFocus({ date, key: Date.now() })} />

              <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
                <Journal entries={report.journal} anomalies={report.anomalies} series={report.series} sku={report.product.sku} onChanged={changed} focus={focus} />
                <PriceCard report={report} onChanged={changed} />
              </div>
            </div>
          )}
        </div>
      </div>

      {newCampaign && report && products && (
        <NewCampaignModal products={products} sku={report.product.sku} onClose={() => setNewCampaign(false)}
          onCreated={async (msg) => { setNewCampaign(false); setToast(msg); await changed(); }} />
      )}
    </div>
  );
}
