import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { addDays, fmt, longDate } from './util';

// Эксперимент «включено / выключено»: сколько заказов кампания реально добавляет, а сколько забирает у органики.

type Mode = 'ON' | 'OFF';
interface Block { from: string; to: string; mode: Mode }
interface Stat { on: number | null; off: number | null; diff: number | null; ci90: number | null; nOn: number; nOff: number }
interface Exp {
  id: string; campaignId: string; sku: string; title: string; status: 'PLANNED' | 'RUNNING' | 'DONE' | 'STOPPED';
  blockDays: number; skipDays: number; blocks: Block[]; bid: number | null; endState: Mode; note: string | null; createdBy: string | null; createdAt: string;
  rows: { date: string; mode: Mode; counted: boolean; orders: number; ordersOzon: number; revenue: number; views: number; carts: number; spend: number; clicks: number; adOrders: number; adViews: number; otherSpend: number; position: number | null }[];
  stats: Record<'orders' | 'revenue' | 'views' | 'carts' | 'spend' | 'adOrders' | 'position' | 'otherSpend', Stat>;
  summary: { incrementalOrders: number | null; incrementalOrdersCi: number | null; attributedOrders: number | null; incrementalShare: number | null; incrementalCpo: number | null; attributedCpo: number | null; incrementalDrr: number | null; significant: boolean | null; countedDays: { on: number; off: number } };
}

const STATUS: Record<Exp['status'], [string, string]> = {
  PLANNED: ['Запланирован', 'bg-sky-100 text-sky-800'], RUNNING: ['Идёт', 'bg-emerald-100 text-emerald-800'],
  DONE: ['Завершён', 'bg-slate-200 text-slate-700'], STOPPED: ['Остановлен', 'bg-amber-100 text-amber-800'],
};
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const todayMsk = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

function Timeline({ blocks, skipDays }: { blocks: Block[]; skipDays: number }) {
  const today = todayMsk();
  return (
    <div className="flex gap-1">
      {blocks.map((b) => {
        const len = Math.round((new Date(b.to).getTime() - new Date(b.from).getTime()) / 86_400_000) + 1;
        const cur = b.from <= today && today <= b.to;
        return (
          <div key={b.from} className="flex-1 min-w-0" style={{ flexGrow: len }}>
            <div className={clsx('h-8 rounded-md flex items-center justify-center text-xs font-semibold relative overflow-hidden', b.mode === 'ON' ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-600', cur && 'ring-2 ring-offset-1 ring-amber-400')}>
              {skipDays > 0 && <i className="absolute left-0 top-0 bottom-0 bg-white/30" style={{ width: `${(skipDays / len) * 100}%` }} title="не учитывается" />}
              <span className="relative">{b.mode === 'ON' ? 'ВКЛ' : 'ВЫКЛ'}</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-1 text-center whitespace-nowrap">{dm(b.from)}–{dm(b.to)}</div>
          </div>
        );
      })}
    </div>
  );
}

function CreateForm({ sku, campaigns, onCreated }: { sku: string; campaigns: { id: string; title: string; state: string; bid: number | null }[]; onCreated: () => void }) {
  const [campaignId, setCampaignId] = useState(campaigns.find((c) => c.state === 'CAMPAIGN_STATE_RUNNING')?.id ?? campaigns[0]?.id ?? '');
  const [start, setStart] = useState(addDays(todayMsk(), 1));
  const [blockDays, setBlockDays] = useState(4);
  const [pairs, setPairs] = useState(2);
  const [skipDays, setSkipDays] = useState(1);
  const [endState, setEndState] = useState<Mode>('ON');
  const [preview, setPreview] = useState<Block[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setPreview(null); api.adsExperimentPreview(start, blockDays, pairs).then(setPreview).catch(() => {}); }, [start, blockDays, pairs]);
  const others = campaigns.filter((c) => c.id !== campaignId && c.state === 'CAMPAIGN_STATE_RUNNING');
  const end = preview?.[preview.length - 1]?.to;

  async function create() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      await api.adsExperimentCreate({ campaignId, sku, start, blockDays, pairs, skipDays, endState, modes: preview.map((b) => b.mode) });
      onCreated();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }
  const inp = 'mt-1 block w-full border border-slate-300 rounded-lg h-9 px-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500';
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
      <div>
        <h2 className="font-semibold">Новый эксперимент «включено / выключено»</h2>
        <p className="text-sm text-slate-500 mt-1 max-w-3xl">Кампания будет включаться и выключаться блоками по расписанию в случайном порядке. Ставку биддер на это время не трогает. В отчёте сравниваются все заказы товара в дни «включено» и «выключено» — так видно, сколько заказов реклама добавляет на самом деле, а сколько пришло бы и без неё.</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <label className="text-xs text-slate-500 col-span-2">Кампания
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={inp}>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}{c.bid != null ? ` · ${fmt(c.bid)} ₽` : ''}{c.state !== 'CAMPAIGN_STATE_RUNNING' ? ' (выкл.)' : ''}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">Начало
          <input type="date" value={start} min={todayMsk()} onChange={(e) => e.target.value && setStart(e.target.value)} className={inp} />
        </label>
        <label className="text-xs text-slate-500">Блок, дней
          <select value={blockDays} onChange={(e) => setBlockDays(+e.target.value)} className={inp}>{[3, 4, 5, 7].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="text-xs text-slate-500">Пар «вкл + выкл»
          <select value={pairs} onChange={(e) => setPairs(+e.target.value)} className={inp}>{[2, 3, 4].map((n) => <option key={n} value={n}>{n} ({n * 2} блока)</option>)}</select>
        </label>
        <label className="text-xs text-slate-500">Не учитывать в начале блока
          <select value={skipDays} onChange={(e) => setSkipDays(+e.target.value)} className={inp}>{[0, 1, 2].filter((n) => n < blockDays).map((n) => <option key={n} value={n}>{n} дн.</option>)}</select>
        </label>
      </div>
      {preview && (
        <div>
          <div className="flex items-baseline justify-between mb-1.5 text-xs text-slate-500">
            <span>Расписание: {dm(preview[0].from)} — {end && dm(end)}, {preview.length * blockDays} дней · светлая часть блока не учитывается</span>
            <button onClick={() => api.adsExperimentPreview(start, blockDays, pairs).then(setPreview)} className="text-brand-700 hover:underline">другой порядок</button>
          </div>
          <Timeline blocks={preview} skipDays={skipDays} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-slate-600">После окончания кампанию
          <select value={endState} onChange={(e) => setEndState(e.target.value as Mode)} className="border border-slate-300 rounded-lg h-8 px-2 text-sm bg-white"><option value="ON">включить</option><option value="OFF">выключить</option></select>
        </label>
      </div>
      <ul className="text-xs text-slate-600 space-y-1 list-disc pl-5">
        <li>На время эксперимента не меняйте цену и участие в акциях — иначе их эффект смешается с эффектом рекламы.</li>
        {others.length > 0 && <li className="text-amber-800">У товара работают другие кампании: {others.map((c) => `«${c.title}»`).join(', ')}. Их расход будет в отчёте; лучше не менять их настройки до конца эксперимента.</li>}
        <li>Точность: заказы Lowtex колеблются день ко дню на ±60. Проверка на прошлых днях (без переключения кампании) дала погрешность ±61 заказ в день при 2 парах блоков. Ориентир: {pairs} пары — разница видна от ~{({ 2: 60, 3: 50, 4: 43 } as Record<number, number>)[pairs] ?? 45} заказов в день; меньше — отчёт покажет «в пределах погрешности».</li>
      </ul>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy || !preview || !campaignId} onClick={create} className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-4 h-9 rounded-lg text-sm font-medium">Запланировать эксперимент</button>
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | null }) {
  return (
    <div className="bg-slate-50 rounded-lg px-3 py-2.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={clsx('text-xl font-semibold font-mono tabular-nums mt-0.5', tone === 'good' && 'text-emerald-700', tone === 'bad' && 'text-red-700')}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Report({ e, onChanged }: { e: Exp; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const s = e.summary; const st = e.stats;
  const active = e.status === 'PLANNED' || e.status === 'RUNNING';
  async function stop() {
    if (!confirm(`Остановить эксперимент? Кампания будет ${e.endState === 'ON' ? 'включена' : 'выключена'}.`)) return;
    setBusy(true); try { await api.adsExperimentStop(e.id); onChanged(); } finally { setBusy(false); }
  }
  const verdict = s.incrementalOrders == null
    ? 'Пока мало данных: нужны учтённые дни и «включено», и «выключено».'
    : s.significant === false
      ? `Разница ${fmt(s.incrementalOrders, 1)} заказа в день — в пределах погрешности (±${fmt(s.incrementalOrdersCi, 1)}). Реклама заметно заказов не добавляет${s.attributedOrders ? `, хотя Ozon приписывает ей ${fmt(s.attributedOrders, 0)} в день` : ''}.`
      : s.incrementalOrders > 0
        ? `Кампания добавляет ~${fmt(s.incrementalOrders, 0)} заказов в день (±${fmt(s.incrementalOrdersCi, 0)}) — ${s.incrementalShare != null ? `${fmt(s.incrementalShare, 0)}% от приписанных Ozon` : ''}. Добавочный заказ стоит ${s.incrementalCpo != null ? `${fmt(s.incrementalCpo)} ₽` : '—'}.`
        : `В дни «включено» заказов меньше на ${fmt(-s.incrementalOrders, 0)} — реклама не добавляет заказов.`;
  const row = (label: string, k: keyof Exp['stats'], unit = '', digits = 0, lowerBetter = false) => {
    const x = st[k];
    const good = x.diff == null ? null : lowerBetter ? x.diff < 0 : x.diff > 0;
    return (
      <tr className="border-t border-slate-100">
        <td className="py-1.5 pr-3 text-slate-600">{label}</td>
        <td className="py-1.5 px-3 text-right font-mono tabular-nums">{x.on != null ? fmt(x.on, digits) + unit : '—'}</td>
        <td className="py-1.5 px-3 text-right font-mono tabular-nums">{x.off != null ? fmt(x.off, digits) + unit : '—'}</td>
        <td className={clsx('py-1.5 px-3 text-right font-mono tabular-nums', x.diff != null && x.ci90 != null && Math.abs(x.diff) > x.ci90 ? (good ? 'text-emerald-700' : 'text-red-700') : 'text-slate-500')}>
          {x.diff != null ? `${x.diff > 0 ? '+' : ''}${fmt(x.diff, digits)}${unit}` : '—'}{x.ci90 != null && <span className="text-[11px] text-slate-400"> ±{fmt(x.ci90, digits)}</span>}
        </td>
      </tr>
    );
  };
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h2 className="font-semibold">{e.title}</h2><span className={clsx('text-[11px] font-medium px-2 py-0.5 rounded-full', STATUS[e.status][1])}>{STATUS[e.status][0]}</span></div>
          <div className="text-xs text-slate-500 mt-0.5">с {longDate(e.blocks[0].from)} по {longDate(e.blocks[e.blocks.length - 1].to)} · не учитывается {e.skipDays} дн. в начале блока{e.bid != null ? ` · ставка заморожена на ${fmt(e.bid)} ₽` : ''} · после окончания кампания {e.endState === 'ON' ? 'включится' : 'выключится'}</div>
        </div>
        {active && <button disabled={busy} onClick={stop} className="text-sm border border-slate-300 hover:border-red-300 hover:text-red-700 rounded-lg px-3 h-8">Остановить</button>}
      </div>
      <Timeline blocks={e.blocks} skipDays={e.skipDays} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Kpi label="Добавочные заказы в день" value={s.incrementalOrders != null ? `${s.incrementalOrders > 0 ? '+' : ''}${fmt(s.incrementalOrders, 0)}` : '—'} sub={s.incrementalOrdersCi != null ? `погрешность ±${fmt(s.incrementalOrdersCi, 0)} (90%)` : 'нужны дни обоих видов'} tone={s.significant ? (s.incrementalOrders! > 0 ? 'good' : 'bad') : null} />
        <Kpi label="Ozon приписывает кампании" value={s.attributedOrders != null ? fmt(s.attributedOrders, 0) : '—'} sub={s.incrementalShare != null ? `реально добавочных ${fmt(s.incrementalShare, 0)}%` : 'заказов в день'} />
        <Kpi label="Цена добавочного заказа" value={s.incrementalCpo != null ? `${fmt(s.incrementalCpo)} ₽` : '—'} sub={`${s.significant === false ? 'не значимо · ' : ''}${s.attributedCpo != null ? `по данным Ozon — ${fmt(s.attributedCpo)} ₽` : ''}`} />
        <Kpi label="Добавочный ДРР" value={s.incrementalDrr != null ? `${fmt(s.incrementalDrr, 1)}%` : '—'} sub={`учтено дней: вкл ${s.countedDays.on} · выкл ${s.countedDays.off}`} />
      </div>
      <p className={clsx('text-sm rounded-lg px-3 py-2', s.significant === false ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-700')}>{verdict}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        <table className="text-sm w-full">
          <thead><tr className="text-[11px] text-slate-500"><th className="text-left font-medium pb-1">В среднем за учтённый день</th><th className="text-right font-medium px-3 pb-1">вкл</th><th className="text-right font-medium px-3 pb-1">выкл</th><th className="text-right font-medium px-3 pb-1">разница</th></tr></thead>
          <tbody>
            {row('Заказы товара, все (без отмен)', 'orders')}
            {row('Выручка товара, ₽', 'revenue')}
            {row('Показы товара, все', 'views')}
            {row('Корзины, все', 'carts')}
            {row('Позиция в поиске (средняя)', 'position', '', 1, true)}
            {row('Расход этой кампании, ₽', 'spend')}
            {row('Заказы, приписанные кампании', 'adOrders')}
            {row('Расход других кампаний товара, ₽', 'otherSpend')}
          </tbody>
        </table>
        <div className="overflow-x-auto">
          <table className="text-xs w-full">
            <thead><tr className="text-[11px] text-slate-500"><th className="text-left font-medium pb-1">День</th><th className="font-medium pb-1" /><th className="text-right font-medium px-2 pb-1">заказы</th><th className="text-right font-medium px-2 pb-1">выручка</th><th className="text-right font-medium px-2 pb-1">расход</th><th className="text-right font-medium px-2 pb-1">рекл. зак.</th><th className="text-right font-medium px-2 pb-1">позиция</th></tr></thead>
            <tbody>
              {[...e.rows].reverse().map((r) => (
                <tr key={r.date} className={clsx('border-t border-slate-100', !r.counted && 'text-slate-400')}>
                  <td className="py-1 pr-2 font-mono">{dm(r.date)}</td>
                  <td className="py-1"><span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded', r.mode === 'ON' ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-600')}>{r.mode === 'ON' ? 'ВКЛ' : 'ВЫКЛ'}</span>{!r.counted && <span className="ml-1 text-[10px]">не учт.</span>}</td>
                  <td className="py-1 px-2 text-right font-mono tabular-nums">{r.orders}</td>
                  <td className="py-1 px-2 text-right font-mono tabular-nums">{fmt(r.revenue)}</td>
                  <td className="py-1 px-2 text-right font-mono tabular-nums">{fmt(r.spend)}</td>
                  <td className="py-1 px-2 text-right font-mono tabular-nums">{r.adOrders}</td>
                  <td className="py-1 px-2 text-right font-mono tabular-nums">{r.position != null ? fmt(r.position, 1) : '—'}</td>
                </tr>
              ))}
              {e.rows.length === 0 && <tr><td colSpan={7} className="py-3 text-slate-500">Эксперимент ещё не начался.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 leading-4">Добавочные заказы = среднее заказов товара за учтённые дни «вкл» − за дни «выкл». Погрешность — 90% доверительный интервал по разбросу дней. Цена добавочного заказа = расход кампании в день «вкл» ÷ добавочные заказы. Сегодняшний неполный день и первые {e.skipDays} дн. каждого блока не учитываются.</p>
    </section>
  );
}

export default function ExperimentTab({ sku, campaigns }: { sku: string; campaigns: { id: string; title: string; state: string; bid: number | null }[] }) {
  const [list, setList] = useState<Exp[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.adsExperiments(sku).then(setList).catch((e) => setError(e.message));
  useEffect(() => { setList(null); load(); }, [sku]);
  if (!list) return <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">{error || 'Загружаю…'}</div>;
  const usable = campaigns.filter((c) => c.state !== 'CAMPAIGN_STATE_ARCHIVED');
  const busyIds = new Set(list.filter((e) => e.status === 'PLANNED' || e.status === 'RUNNING').map((e) => e.campaignId));
  const free = usable.filter((c) => !busyIds.has(c.id));
  return (
    <div className="space-y-4">
      {list.filter((e) => e.status === 'PLANNED' || e.status === 'RUNNING').map((e) => <Report key={e.id} e={e} onChanged={load} />)}
      {free.length > 0 ? <CreateForm sku={sku} campaigns={free} onCreated={load} /> : <p className="text-sm text-slate-500">Все кампании товара уже в эксперименте.</p>}
      {list.filter((e) => e.status === 'DONE' || e.status === 'STOPPED').map((e) => <Report key={e.id} e={e} onChanged={load} />)}
    </div>
  );
}
