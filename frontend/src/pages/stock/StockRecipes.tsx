import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, fmtQty, inputCls, parseNum } from './common';

interface Line { key: string; itemId: string; percent: string; stage: string }

let seq = 0;
const newLine = (stage = '1'): Line => ({ key: String(++seq), itemId: '', percent: '', stage });

// itemId — встроенный режим в карточке позиции: одна рецептура, без списка слева
export default function StockRecipes({ itemId }: { itemId?: string } = {}) {
  const [semis, setSemis] = useState<any[]>([]);
  const [raws, setRaws] = useState<any[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [stages, setStages] = useState<Record<string, string>>({});
  const [qc, setQc] = useState('');
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(keep?: string) {
    const [s, r] = await Promise.all([api.getRecipes(), api.getItems('RAW')]);
    setSemis(s);
    setRaws(r);
    const id = keep ?? itemId ?? s[0]?.id ?? null;
    if (id) select(s.find((x: any) => x.id === id) ?? s[0]);
  }
  useEffect(() => { load(); }, []);

  function select(semi: any) {
    setSelId(semi.id);
    setMsg(null);
    const r = semi.recipe;
    setLines(r?.lines.length ? r.lines.map((l: any) => ({
      key: String(++seq), itemId: l.itemId, percent: String(l.percent).replace('.', ','), stage: String(l.stage),
    })) : [newLine()]);
    setStages(r?.stages ?? {});
    setQc(r?.qc ?? '');
    setComment(r?.comment ?? '');
  }

  const patch = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const sum = lines.reduce((s, l) => s + (parseNum(l.percent) ?? 0), 0);
  const stageNums = [...new Set(lines.map((l) => l.stage).filter(Boolean))].sort((a, b) => Number(a) - Number(b));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const used = lines.filter((l) => l.itemId);
      if (used.some((l) => !(parseNum(l.percent)! > 0))) throw new Error('У каждого компонента должен быть процент больше нуля');
      await api.saveRecipe(selId!, {
        lines: used.map((l) => ({ itemId: l.itemId, percent: parseNum(l.percent)!, stage: Number(l.stage) || 1 })),
        stages: Object.fromEntries(stageNums.map((n) => [n, stages[n] ?? ''])),
        qc: qc || null,
        comment: comment || null,
      });
      await load(selId!);
      setMsg({ ok: true, text: 'Рецептура сохранена' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  if (semis.length === 0) {
    return <p className="text-slate-500 text-center mt-10">Нет полуфабрикатов. Добавьте их в <Link to="/stock/catalog" className="text-brand-600 hover:underline">справочниках</Link> с типом «Полуфабрикаты».</p>;
  }

  const sel = semis.find((s) => s.id === selId);

  return (
    <div className={clsx('grid grid-cols-1 gap-4', !itemId && 'lg:grid-cols-[260px_minmax(0,1fr)]')}>
      <div className={clsx('bg-white rounded-xl border p-2 h-fit', itemId && 'hidden')}>
        {semis.map((s) => (
          <button key={s.id} onClick={() => select(s)}
            className={clsx('w-full text-left px-3 py-2 rounded-lg text-sm flex justify-between gap-2',
              s.id === selId ? 'bg-brand-50 text-brand-800 font-medium' : 'hover:bg-slate-50')}>
            <span>{s.name}</span>
            {!s.recipe && <span className="text-xs text-amber-700">нет</span>}
          </button>
        ))}
      </div>

      {sel && (
        <div className="space-y-4 min-w-0">
          <div className="flex flex-wrap items-baseline gap-3">
            {!itemId && <h2 className="text-xl font-semibold">{sel.name}</h2>}
            {sel.recipe && <span className="text-xs text-slate-500">изменена {new Date(sel.recipe.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>}
          </div>

          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                  <th className="px-3 py-2 font-medium w-20">Этап</th>
                  <th className="px-3 py-2 font-medium min-w-[220px]">Компонент</th>
                  <th className="px-3 py-2 font-medium text-right w-28">%</th>
                  <th className="px-3 py-2 font-medium text-right w-32">На 100 кг</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const pct = parseNum(l.percent);
                  return (
                    <tr key={l.key} className="border-b last:border-0">
                      <td className="px-3 py-1.5"><input value={l.stage} onChange={(e) => patch(l.key, { stage: e.target.value.replace(/\D/g, '') })} className={inputCls + ' w-14 text-center'} /></td>
                      <td className="px-3 py-1.5">
                        <select value={l.itemId} onChange={(e) => patch(l.key, { itemId: e.target.value })} className={inputCls + ' w-full'}>
                          <option value="">— сырьё —</option>
                          {raws.map((r) => <option key={r.id} value={r.id}>{r.name}{r.noStock ? ' (без учёта)' : ''}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-right"><input value={l.percent} onChange={(e) => patch(l.key, { percent: e.target.value })} className={inputCls + ' w-24 text-right'} /></td>
                      <td className="px-3 py-1.5 text-right text-slate-600">{pct != null ? (pct < 1 ? `${fmtQty(pct * 1000, 0)} г` : `${fmtQty(pct, 2)} кг`) : '—'}</td>
                      <td className="px-2 py-1.5">
                        <button onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newLine()]))} className="text-slate-400 hover:text-red-600" title="Удалить">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t">
                  <td className="px-3 py-2">
                    <button onClick={() => setLines((ls) => [...ls, newLine(ls[ls.length - 1]?.stage || '1')])} className="text-brand-600 hover:underline text-sm whitespace-nowrap">+ Компонент</button>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">Сумма</td>
                  <td className={clsx('px-3 py-2 text-right font-semibold', Math.abs(sum - 100) > 0.005 ? 'text-red-600' : 'text-green-700')}>{fmtQty(sum, 3)} %</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>

          {stageNums.length > 0 && (
            <div className="bg-white rounded-xl border p-4 space-y-2">
              <h3 className="font-semibold text-sm">Описание этапов <span className="font-normal text-slate-500">— печатается в карте замеса</span></h3>
              {stageNums.map((n) => (
                <label key={n} className="flex items-center gap-3 text-sm">
                  <span className="w-16 text-slate-500 shrink-0">Этап {n}</span>
                  <input value={stages[n] ?? ''} onChange={(e) => setStages({ ...stages, [n]: e.target.value })} className={inputCls + ' flex-1'}
                    placeholder="Напр. мин. обороты, 3 мин · стоп: pH 8,5–9,2" />
                </label>
              ))}
            </div>
          )}

          <div className="bg-white rounded-xl border p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-500">Нормы ОТК
              <textarea value={qc} onChange={(e) => setQc(e.target.value)} rows={2} className={inputCls} placeholder="pH 8,5–9,2 · вязкость 95–110 KU · плотность 1,42–1,46" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Комментарий
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} className={inputCls} />
            </label>
          </div>

          {msg && <p className={clsx('text-sm', msg.ok ? 'text-green-700' : 'text-red-600')}>{msg.text}</p>}
          <div className="flex gap-2">
            <button disabled={busy} onClick={save} className={btnPrimary}>Сохранить рецептуру</button>
            <Link to="/stock/mix/new" className={btnSecondary}>Замес по рецептуре →</Link>
          </div>
          {Math.abs(sum - 100) > 0.005 && <p className="text-xs text-amber-700">Сумма не равна 100 %. Сохранить можно, но при расчёте замеса масса не сойдётся с планом.</p>}
        </div>
      )}
    </div>
  );
}
