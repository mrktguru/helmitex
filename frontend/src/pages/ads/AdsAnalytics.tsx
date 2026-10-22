import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from '../stock/StockLayout';
import HeatTable from './HeatTable';
import CampaignsTab, { Seg } from './CampaignsTab';
import BidderTab from './BidderTab';
import PriceCard from './PriceCard';
import Journal, { entryDay } from './Journal';
import NewCampaignModal from './NewCampaignModal';
import { Gran, PRODUCT_METRICS, productBuckets } from './periods';
import { addDays } from './util';
import SyncBar, { useSyncPoll } from '../stock/SyncBar';
import { Icon } from './icons';

type Tab = 'table' | 'camps' | 'bidder' | 'price' | 'journal';
const TABS: [Tab, string, string][] = [['table', 'Таблица', 'table'], ['camps', 'Кампании', 'target'], ['bidder', 'Биддер', 'bolt'], ['price', 'Цена', 'tag'], ['journal', 'Журнал', 'list']];
const GRANS: [Gran, string][] = [['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']];
// период по умолчанию под детализацию (Ozon и портал — не больше 92 дней)
const SPAN: Record<Gran, number> = { day: 28, week: 91, month: 92 };

export default function AdsAnalytics() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<{ seller: boolean; perf: boolean; lastDay: string } | null>(null);
  const [products, setProducts] = useState<any[] | null>(null);
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState<'list' | 'report' | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [newCampaign, setNewCampaign] = useState(false);
  const [bidderFocus, setBidderFocus] = useState<string | null>(null);
  const reqId = useRef(0);

  const last = status?.lastDay ?? '';
  const gran = (params.get('g') as Gran) || 'day';
  const tab = (params.get('tab') as Tab) || 'table';
  const to = params.get('to') ?? last;
  const from = params.get('from') ?? (last ? addDays(last, -(SPAN[gran] - 1)) : '');
  const sku = params.get('sku') ?? products?.[0]?.sku ?? null;
  const setParam = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v == null) n.delete(k); else n.set(k, v); }
    setParams(n, { replace: true });
  };

  useEffect(() => { api.adsStatus().then(setStatus).catch((e) => setError(e.message)); }, []);
  // Данные из базы портала — сразу; устаревшее Ozon догружает в фоне, после чего таблица тихо обновляется
  const [syncInit, setSyncInit] = useState<any[] | null>(null);
  const { sync } = useSyncPoll(syncInit, api.adsSyncStatus, () => { loadList(false, true); loadReport(true); });
  async function loadList(refresh = false, silent = false) {
    if (!from || !to) return;
    if (!silent) setLoading('list');
    setError('');
    try { const r = await api.adsProducts(from, to, refresh); setProducts(r.products); setSyncInit(r.sync); } catch (e: any) { setError(e.message); }
    if (!silent) setLoading(null);
  }
  async function loadReport(silent = false) {
    if (!sku || !from || !to) return;
    const id = ++reqId.current;
    if (!silent) setLoading('report');
    setError('');
    try { const r = await api.adsReport(sku, from, to); if (id === reqId.current) setReport(r); } catch (e: any) { if (id === reqId.current) setError(e.message); }
    if (id === reqId.current) setLoading(null);
  }
  useEffect(() => { loadList(); }, [from, to]);
  useEffect(() => { if (products) loadReport(); }, [sku, from, to, products != null]);
  async function changed() { await loadReport(); }

  const net = report?.product?.price?.netPrice ?? 0;
  const rows = useMemo(() => (report ? productBuckets(report.series, gran, net) : []), [report, gran]);
  const notes = (dates: string[]) => {
    if (!report) return [];
    const set = new Set(dates); const seen = new Set<string>();
    return report.journal.filter((j: any) => set.has(entryDay(j.at)) && !seen.has(j.text) && seen.add(j.text)).map((j: any) => j.text.replace(' — в кабинете Ozon', ' (кабинет Ozon)'));
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Аналитика рекламы" hint="Все данные товара по периодам, кампании с настройками и биддером, цена и журнал изменений. Изменения отсюда сразу уходят в Ozon и пишутся в журнал." />
      <div className="-mt-3"><SyncBar sync={sync} busy={loading === 'list'} onRefresh={() => loadList(true, true)} /></div>

      {status && (!status.seller || !status.perf) && (
        <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-3 text-sm">
          {!status.perf && 'Не подключён Ozon Performance API (реклама): нужны OZON_PERF_CLIENT_ID и OZON_PERF_CLIENT_SECRET в .env сервера. '}
          {!status.seller && 'Не подключён Seller API: нужны OZON_CLIENT_ID и OZON_API_KEY.'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600">Товар
          <select value={sku ?? ''} onChange={(e) => setParam({ sku: e.target.value })} className="border border-slate-300 rounded-lg h-9 px-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
            {(products ?? []).map((p) => <option key={p.sku} value={p.sku}>{p.name}</option>)}
          </select>
        </label>
        <Seg value={gran} options={GRANS} onChange={(g) => setParam({ g, from: null, to: null })} label="Детализация" />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">с
          <input type="date" value={from} max={to || last} onChange={(e) => e.target.value && setParam({ from: e.target.value })} className="border border-slate-300 rounded-lg h-9 px-2 text-sm bg-white" />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">по
          <input type="date" value={to} min={from} max={last} onChange={(e) => e.target.value && setParam({ to: e.target.value })} className="border border-slate-300 rounded-lg h-9 px-2 text-sm bg-white" />
        </label>
        <div className="flex-1" />
        {loading && <span className="text-xs text-slate-500">{loading === 'list' ? 'Загружаю…' : 'Строю отчёт…'}</span>}
        <button disabled={!report} onClick={() => setNewCampaign(true)} className="bg-brand-600 hover:bg-brand-700 active:scale-[0.97] transition-transform disabled:opacity-50 text-white px-4 h-9 rounded-lg text-sm font-medium flex items-center gap-1.5"><Icon name="plus" />Новая кампания</button>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{error}</p>}
      {toast && (
        <div className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm">
          <span>{toast}</span><button onClick={() => setToast('')} className="text-slate-500 hover:text-slate-800" aria-label="Скрыть">✕</button>
        </div>
      )}

      <div role="tablist" className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {TABS.map(([k, l, ic]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParam({ tab: k })}
            className={clsx('flex items-center gap-2 px-4 h-10 text-sm -mb-px border-b-2 whitespace-nowrap transition-colors', tab === k ? 'border-brand-600 text-slate-900 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800')}>
            <Icon name={ic} />{l}{k === 'camps' && report && <span className="text-[11px] bg-slate-100 rounded px-1.5 tabular-nums">{report.sources.cpc.filter((c: any) => c.spend > 0 || c.state === 'CAMPAIGN_STATE_RUNNING' || c.state === 'CAMPAIGN_STATE_STOPPED').length}</span>}
          </button>
        ))}
      </div>

      {!report ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
          {loading ? 'Загружаю данные из Ozon по дням. Первый раз за период это может занять 1–3 минуты — дальше данные берутся из портала.' : products?.length === 0 ? 'Нет товаров для анализа: свяжите SKU с Ozon в справочнике.' : 'Выберите товар.'}
        </div>
      ) : (
        <div className={clsx('transition-opacity', loading === 'report' && 'opacity-60')}>
          {tab === 'table' && (
            <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
                <h2 className="font-semibold">{report.product.name}</h2>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                  <span className="flex items-center gap-1.5"><i className="w-3.5 h-3 rounded-sm" style={{ background: 'rgba(21,128,61,.18)' }} />лучше</span>
                  <span className="flex items-center gap-1.5"><i className="w-3.5 h-3 rounded-sm" style={{ background: 'rgba(234,88,12,.18)' }} />хуже</span>
                  <span>к предыдущему периоду · неполные — по среднему в день · цифра над периодом — записи журнала</span>
                </div>
              </div>
              <HeatTable rows={rows} metrics={PRODUCT_METRICS} gran={gran} notes={(b) => notes(b.dates)} />
            </section>
          )}
          {tab === 'camps' && <CampaignsTab report={report} gran={gran} onChanged={changed} onBidder={(id) => { setBidderFocus(id); setParam({ tab: 'bidder' }); }} />}
          {tab === 'bidder' && <BidderTab report={report} onChanged={changed} focus={bidderFocus} />}
          {tab === 'price' && <div className="max-w-xl"><PriceCard report={report} onChanged={changed} /></div>}
          {tab === 'journal' && <div className="max-w-4xl"><Journal entries={report.journal} anomalies={report.anomalies} series={report.series} sku={report.product.sku} onChanged={changed} focus={null} /></div>}
        </div>
      )}

      {newCampaign && report && products && (
        <NewCampaignModal products={products} sku={report.product.sku} suggestCpo={report.kpi.cur.breakEvenDrr != null && report.kpi.cur.orders ? Math.round(report.kpi.cur.breakEvenDrr * (report.kpi.cur.revenue / report.kpi.cur.orders) * 0.7 / 5) * 5 : null}
          onClose={() => setNewCampaign(false)} onCreated={async (msg) => { setNewCampaign(false); setToast(msg); await changed(); }} />
      )}
    </div>
  );
}
