import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { Switch } from './CampaignsTab';
import { Icon } from './icons';
import { fmt, parseNum } from './util';

const GOALS = [
  { k: 'CART', l: 'Цена корзины', d: 'Решения по корзинам — их в 2–7 раз больше, чем заказов. Цель корзины = цель заказа × конверсия корзины в заказ этой кампании за 28 дней. Если свежая конверсия падает больше чем на треть — перестраховка: ставку не повышает и судит по заказам.', rec: true },
  { k: 'ORDER', l: 'Цена заказа', d: 'Решения по расходу на заказ за 2 полных дня. Точнее по деньгам, но медленнее: заказы приходят с задержкой.' },
  { k: 'DRR', l: 'ДРР', d: 'Доля рекламы в выручке кампании за 2 дня. Удобно, когда цена товара часто меняется.' },
];
const MODS: { k: string; l: string; d: string }[] = [
  { k: 'hours', l: 'Расписание по часам', d: 'Ночью 00–07 ставка ×0,75, вечером 17–23 ×1,1. Когда накопится статистика по часам, множители будут считаться по конверсии каждого часа.' },
  { k: 'pace', l: 'Темп бюджета', d: 'Тратит быстрее плана на этот час — притормаживает (×0,9), чтобы кампания не вставала к вечеру; недотрачивает при хорошей цене — подгоняет (×1,05).' },
  { k: 'stock', l: 'Склад Ozon', d: 'Запаса на складах Ozon меньше чем на 5 дней — ставка ×0,85, меньше 2 дней — ×0,7. Заказы при этом уходят на FBS.' },
  { k: 'elastic', l: 'Отклик показов', d: 'Через 2 часа после повышения ставки сравнивает показы с поправкой на время суток. Не выросли хотя бы на 3% — возвращает прежнюю ставку.' },
  { k: 'budgetUp', l: 'Рост бюджета', d: 'Корзина дешевле цели на 25% и больше, а бюджет кончился или кончится раньше вечера — бюджет +25%, не чаще раза в сутки, без верхнего предела.' },
  { k: 'organic', l: 'Реакция на органику', d: 'Органических заказов за 2 дня в 1,5 раза больше обычного — ставка ×0,8: не платить за то, что придёт само.' },
];
const LIMITS: { k: string; l: string; suf: string }[] = [
  { k: 'minBid', l: 'Мин. ставка', suf: '₽' }, { k: 'maxBid', l: 'Макс. ставка', suf: '₽' }, { k: 'maxStepPct', l: 'Шаг за раз, не больше', suf: '%' },
  { k: 'cooldownMin', l: 'Пауза после изменения', suf: 'мин' }, { k: 'minClicks', l: 'Кликов после изменения', suf: '' }, { k: 'maxChangesPerDay', l: 'Изменений в сутки', suf: '' },
  { k: 'stopLossRub', l: 'Стоп: расход за 3 ч без корзин', suf: '₽' }, { k: 'hourFrom', l: 'Работать с', suf: 'ч' }, { k: 'hourTo', l: 'Работать до', suf: 'ч' },
];
const ACTION: Record<string, [string, string]> = {
  BID_UP: ['Ставка выше', 'bg-green-100 text-green-800'], BID_DOWN: ['Ставка ниже', 'bg-orange-100 text-orange-800'], BUDGET_UP: ['Бюджет выше', 'bg-green-100 text-green-800'],
  HOLD: ['Без изменений', 'bg-slate-100 text-slate-600'], REVERT: ['Откат', 'bg-orange-100 text-orange-800'], ON: ['Включён', 'bg-brand-100 text-brand-800'], OFF: ['Выключен', 'bg-slate-200 text-slate-700'], ERROR: ['Ошибка', 'bg-red-100 text-red-700'],
};

function BidderPanel({ c, suggestCpo, onChanged }: { c: any; suggestCpo: number | null; onChanged: () => Promise<void> }) {
  const [cfg, setCfg] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const load = () => api.adsBidder(c.id).then((b) => { setCfg(b); setForm({ ...b, targetCpo: String(b.targetCpo), targetDrr: String(Math.round(b.targetDrr * 100)), limits: Object.fromEntries(Object.entries(b.limits).map(([k, v]) => [k, String(v)])) }); });
  useEffect(() => { load(); }, [c.id]);
  if (!form) return <section className="bg-white rounded-xl border border-slate-200 p-5 text-sm text-slate-500">Загружаю биддер…</section>;

  const dirty = cfg && JSON.stringify({ g: cfg.goal, t: String(cfg.targetCpo), m: cfg.mods }) !== JSON.stringify({ g: form.goal, t: form.targetCpo, m: form.mods });
  async function save(enabled: boolean) {
    const targetCpo = parseNum(form.targetCpo);
    if (!targetCpo || targetCpo <= 0) { setMsg({ ok: false, t: 'Укажите целевую цену заказа' }); return; }
    if (enabled && !cfg.enabled && !confirm(`Биддер начнёт сам менять ставку${form.mods.budgetUp ? ' и бюджет' : ''} кампании «${c.title}» в Ozon каждые 30 минут. Включить?`)) return;
    setBusy(true); setMsg(null);
    try {
      const limits = Object.fromEntries(Object.entries(form.limits).map(([k, v]) => [k, parseNum(String(v)) ?? 0]));
      const b = await api.adsBidderSave(c.id, { enabled, goal: form.goal, targetCpo, targetDrr: (parseNum(form.targetDrr) ?? 25) / 100, mods: form.mods, limits });
      setCfg(b); setForm({ ...form, enabled: b.enabled }); setMsg({ ok: true, t: enabled ? 'Сохранено, биддер работает — первое решение после ближайшего снимка (:00 или :30)' : 'Сохранено' });
      await onChanged();
    } catch (e: any) { setMsg({ ok: false, t: e.message }); }
    setBusy(false);
  }
  async function runPreview() { setBusy(true); try { setPreview(await api.adsBidderPreview(c.id)); } catch (e: any) { setMsg({ ok: false, t: e.message }); } setBusy(false); }
  const set = (patch: any) => setForm({ ...form, ...patch });

  return (
    <section className="bg-white rounded-xl border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200">
        <div>
          <h2 className="font-semibold flex items-center gap-2"><Icon name="bolt" />{c.title}</h2>
          <div className="text-xs text-slate-500">№ {c.id} · ставка сейчас {c.bid != null ? `${fmt(c.bid, 1)} ₽` : '—'} · бюджет {fmt(c.weeklyBudget)} ₽/нед</div>
        </div>
        <div className="flex items-center gap-3">
          <span className={clsx('text-sm', cfg.enabled ? 'text-brand-700 font-medium' : 'text-slate-500')}>{cfg.enabled ? 'работает' : 'выключен'}</span>
          <Switch on={cfg.enabled} disabled={busy} onChange={() => save(!cfg.enabled)} label={`Биддер кампании ${c.id}`} />
        </div>
      </div>

      <div className="p-5 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <fieldset>
            <legend className="text-xs font-semibold text-slate-600 mb-2">Цель</legend>
            <div className="grid gap-2" role="radiogroup">
              {GOALS.map((g) => (
                <label key={g.k} className={clsx('rounded-lg border px-3 py-2.5 cursor-pointer transition-colors', form.goal === g.k ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-400')}>
                  <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" name={`goal-${c.id}`} checked={form.goal === g.k} onChange={() => set({ goal: g.k })} className="accent-brand-600" />{g.l}{g.rec && <span className="text-[11px] font-normal text-brand-700">по умолчанию</span>}</span>
                  <span className="block text-xs text-slate-500 mt-1 leading-snug">{g.d}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-500">Целевая цена заказа, ₽
              <input value={form.targetCpo} onChange={(e) => set({ targetCpo: e.target.value })} inputMode="decimal" className="mt-1 block w-32 border rounded-lg px-2.5 h-9 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </label>
            {form.goal === 'DRR' && (
              <label className="text-xs text-slate-500">Целевой ДРР, %
                <input value={form.targetDrr} onChange={(e) => set({ targetDrr: e.target.value })} inputMode="decimal" className="mt-1 block w-24 border rounded-lg px-2.5 h-9 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </label>
            )}
            {suggestCpo != null && <button type="button" onClick={() => set({ targetCpo: String(suggestCpo) })} className="text-xs text-brand-700 hover:underline h-9">по экономике товара: {fmt(suggestCpo)} ₽ (70% от предела)</button>}
          </div>
          <fieldset>
            <legend className="text-xs font-semibold text-slate-600 mb-2">Модификаторы — работают с любой целью</legend>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {MODS.map((m) => (
                <div key={m.k} className="flex items-start gap-3 px-3 py-2.5">
                  <Switch on={!!form.mods[m.k]} onChange={() => set({ mods: { ...form.mods, [m.k]: !form.mods[m.k] } })} label={m.l} />
                  <div><div className="text-sm font-medium">{m.l}</div><div className="text-xs text-slate-500 leading-snug">{m.d}</div></div>
                </div>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="space-y-5">
          <fieldset>
            <legend className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5"><Icon name="shield" size={14} />Ограничители — действуют всегда</legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {LIMITS.map((x) => (
                <label key={x.k} className="text-xs text-slate-500">{x.l}{x.suf && `, ${x.suf}`}
                  <input value={form.limits[x.k]} onChange={(e) => set({ limits: { ...form.limits, [x.k]: e.target.value } })} inputMode="decimal" className="mt-1 block w-full border rounded-lg px-2.5 h-9 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-2">После каждого изменения ставки биддер ждёт паузу и нужное число кликов — кампании Ozon нужно время, чтобы перестроиться под новую ставку.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={busy} onClick={() => save(cfg.enabled)} className="bg-brand-600 hover:bg-brand-700 active:scale-[0.97] transition-transform disabled:opacity-50 text-white px-4 h-9 rounded-lg text-sm font-medium">Сохранить{dirty ? ' изменения' : ''}</button>
            <button disabled={busy} onClick={runPreview} className="border border-slate-300 bg-white hover:bg-slate-50 active:scale-[0.97] transition-transform disabled:opacity-50 text-slate-700 px-4 h-9 rounded-lg text-sm font-medium flex items-center gap-1.5"><Icon name="eye" />Что сделает сейчас</button>
            {msg && <span className={clsx('text-sm', msg.ok ? 'text-green-700' : 'text-red-600')}>{msg.t}</span>}
          </div>
          {preview && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
              <div className="font-medium">{ACTION[preview.action]?.[0] ?? preview.action}{preview.to != null && preview.from !== preview.to && <> · {fmt(preview.from, 1)} → {fmt(preview.to, 1)} {preview.action === 'BUDGET_UP' ? '₽/нед' : '₽'}</>} <span className="text-xs text-slate-400 font-normal">предпросмотр — в Ozon ничего не менялось</span></div>
              {preview.reasons.map((r: string, i: number) => <div key={i} className="text-xs text-slate-600">· {r}</div>)}
            </div>
          )}
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5"><Icon name="list" size={14} />Решения биддера</div>
            <ol className="max-h-[360px] overflow-y-auto thin divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {cfg.logs.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">Пока пусто. Решения появляются каждые 30 минут, когда биддер включён.</li>}
              {cfg.logs.map((l: any) => (
                <li key={l.id} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="tabular-nums">{new Date(l.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span className={clsx('px-1.5 py-0.5 rounded font-medium', ACTION[l.action]?.[1] ?? 'bg-slate-100')}>{ACTION[l.action]?.[0] ?? l.action}</span>
                    {l.fromValue != null && l.toValue != null && l.fromValue !== l.toValue && <span className="tabular-nums text-slate-700">{fmt(l.fromValue, 1)} → {fmt(l.toValue, 1)}</span>}
                  </div>
                  <div className="text-[13px] text-slate-700 leading-snug mt-0.5">{l.reason}</div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function BidderTab({ report, onChanged, focus }: { report: any; onChanged: () => Promise<void>; focus: string | null }) {
  const camps = report.sources.cpc.filter((c: any) => c.state === 'CAMPAIGN_STATE_RUNNING' || c.state === 'CAMPAIGN_STATE_STOPPED');
  const k = report.kpi.cur;
  const suggest = k.breakEvenDrr != null && k.orders ? Math.round(k.breakEvenDrr * (k.revenue / k.orders) * 0.7 / 5) * 5 : null;
  useEffect(() => { if (focus) document.getElementById(`bidder-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [focus]);
  if (!camps.length) return <p className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">Нет работающих кампаний с оплатой за клик — биддеру нечем управлять.</p>;
  return <div className="space-y-4">{camps.map((c: any) => <div key={c.id} id={`bidder-${c.id}`} className="scroll-mt-24"><BidderPanel c={c} suggestCpo={suggest} onChanged={onChanged} /></div>)}</div>;
}
