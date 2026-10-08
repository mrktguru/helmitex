import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { DOC_STATUS, btnPrimary, btnSecondary, deviation, fmtDate, fmtMoney, fmtQty, inputCls, parseNum } from './common';

interface Line {
  key: string;
  itemId: string;
  stage: number;
  planQty: number | null;   // null — корректировка сверх рецептуры
  qty: string;              // факт
  lotId: string;
  reason: string;
  lotNumber?: string | null;
}

let seq = 0;
const numStr = (n: number | null | undefined) => (n == null ? '' : String(Math.round(n * 1e6) / 1e6).replace('.', ','));
const kgStr = (n: number) => (n < 1 ? `${fmtQty(n * 1000, 0)} г` : `${fmtQty(n, 2)} кг`);

export default function StockMixEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;

  const [status, setStatus] = useState('DRAFT');
  const [number, setNumber] = useState('');
  const [semis, setSemis] = useState<any[]>([]);
  const [raws, setRaws] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [head, setHead] = useState({
    date: new Date().toISOString().slice(0, 10), outputItemId: '', plannedQty: '', barrel: '',
    yieldQty: '', expiresAt: '', comment: '',
  });
  const [lines, setLines] = useState<Line[]>([]);
  const [stages, setStages] = useState<Record<string, string>>({});
  const [qc, setQc] = useState('');
  const [output, setOutput] = useState<{ number: string | null; unitCost: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');

  const readOnly = status !== 'DRAFT';

  function applyDoc(d: any) {
    setStatus(d.status); setNumber(d.number);
    setHead({
      date: d.date.slice(0, 10), outputItemId: d.outputItemId ?? '', plannedQty: numStr(d.plannedQty), barrel: d.barrel ?? '',
      yieldQty: numStr(d.yieldQty), expiresAt: d.expiresAt ? d.expiresAt.slice(0, 10) : '', comment: d.comment ?? '',
    });
    setLines(d.lines.map((l: any) => ({
      key: String(++seq), itemId: l.itemId, stage: l.stage ?? 1, planQty: l.planQty, qty: numStr(l.qty),
      lotId: l.lotId ?? '', reason: l.reason ?? '', lotNumber: l.lotNumber,
    })));
    setOutput(d.outputLotNumber ? { number: d.outputLotNumber, unitCost: null } : null);
  }

  useEffect(() => {
    api.getRecipes().then(setSemis);
    api.getItems('RAW').then(setRaws);
    api.getBalances({ type: 'RAW' }).then(setBalances);
    if (id) api.getDoc(id).then(applyDoc).catch((e) => setError(e.message));
  }, [id]);

  // Описание этапов и нормы ОТК берём из текущей рецептуры
  const semi = semis.find((s) => s.id === head.outputItemId);
  useEffect(() => {
    setStages(semi?.recipe?.stages ?? {});
    setQc(semi?.recipe?.qc ?? '');
  }, [semi]);

  // Себестоимость бочки после проведения
  useEffect(() => {
    if (status !== 'POSTED' || !output?.number || output.unitCost != null || !head.outputItemId) return;
    api.getBalances({ itemId: head.outputItemId }).then((b) => {
      const row = b.find((x: any) => x.lot.number === output.number);
      if (row) setOutput({ number: output.number, unitCost: row.lot.unitCost });
    });
  }, [status, output, head.outputItemId]);

  const rawById = useMemo(() => new Map(raws.map((r) => [r.id, r])), [raws]);
  const patch = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  async function calc() {
    setError(''); setWarn('');
    const qty = parseNum(head.plannedQty);
    if (!head.outputItemId || !qty) { setError('Выберите полуфабрикат и укажите массу замеса'); return; }
    try {
      const plan = await api.getMixPlan(head.outputItemId, qty);
      const next: Line[] = [];
      const short: string[] = [];
      for (const pl of plan.lines) {
        for (const a of pl.allocations) {
          next.push({ key: String(++seq), itemId: pl.item.id, stage: pl.stage, planQty: a.qty, qty: numStr(a.qty), lotId: a.lotId ?? '', reason: '' });
        }
        if (pl.shortage > 0) {
          short.push(`${pl.item.name}: не хватает ${kgStr(pl.shortage)}`);
          next.push({ key: String(++seq), itemId: pl.item.id, stage: pl.stage, planQty: pl.shortage, qty: numStr(pl.shortage), lotId: '', reason: '' });
        }
      }
      setLines(next);
      if (short.length) setWarn('Сырья на складе недостаточно — ' + short.join('; '));
    } catch (e: any) { setError(e.message); }
  }

  function addCorrection() {
    const stage = lines.length ? lines[lines.length - 1].stage : 1;
    setLines((ls) => [...ls, { key: String(++seq), itemId: '', stage, planQty: null, qty: '', lotId: '', reason: '' }]);
  }

  const planTotal = lines.reduce((s, l) => s + (l.planQty ?? 0), 0);
  const factTotal = lines.reduce((s, l) => s + (parseNum(l.qty) ?? 0), 0);
  const yieldQty = parseNum(head.yieldQty);

  // Отклонение считаем по компоненту целиком (он может быть разбит на несколько лотов)
  const devByItem = useMemo(() => {
    const m = new Map<string, { plan: number; fact: number }>();
    for (const l of lines) {
      if (l.planQty == null || !l.itemId) continue;
      const v = m.get(l.itemId) ?? { plan: 0, fact: 0 };
      v.plan += l.planQty;
      v.fact += parseNum(l.qty) ?? 0;
      m.set(l.itemId, v);
    }
    return m;
  }, [lines]);
  const corrByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) if (l.planQty == null && l.itemId) m.set(l.itemId, (m.get(l.itemId) ?? 0) + (parseNum(l.qty) ?? 0));
    return m;
  }, [lines]);
  const bigDev = [...devByItem.entries()].filter(([i, v]) => Math.abs(deviation(v.plan, v.fact + (corrByItem.get(i) ?? 0))?.pct ?? 0) > 3);

  function payload() {
    for (const l of lines) {
      const it = rawById.get(l.itemId);
      if (!l.itemId) throw new Error('В корректировке не выбран компонент');
      if (parseNum(l.qty) == null || parseNum(l.qty)! < 0) throw new Error(`Укажите факт: ${it?.name}`);
    }
    return {
      type: 'MIX',
      date: head.date,
      outputItemId: head.outputItemId || null,
      plannedQty: parseNum(head.plannedQty),
      barrel: head.barrel || null,
      yieldQty: yieldQty,
      expiresAt: head.expiresAt || null,
      comment: head.comment || null,
      lines: lines.map((l) => ({
        itemId: l.itemId, lotId: l.lotId || null, qty: parseNum(l.qty)!, planQty: l.planQty, stage: l.stage, reason: l.reason || null,
      })),
    };
  }

  async function save(post: boolean) {
    setError(''); setBusy(true);
    try {
      const data = payload();
      if (post) {
        const missing = lines.find((l) => (parseNum(l.qty) ?? 0) > 0 && !l.lotId && !rawById.get(l.itemId)?.noStock);
        if (missing) throw new Error(`Выберите лот: ${rawById.get(missing.itemId)?.name}`);
        if (!yieldQty) throw new Error('Укажите выход в бочку, кг');
        if (bigDev.length && !confirm(`Отклонение больше 3 %: ${bigDev.map(([i]) => rawById.get(i)?.name).join(', ')}. Провести всё равно?`)) { setBusy(false); return; }
      }
      if (isNew) {
        const doc = await api.createDoc(data, post);
        navigate(`/stock/mix/${doc.id}`, { replace: true });
      } else {
        await api.updateDoc(id!, data);
        if (post) await api.postDoc(id!);
        applyDoc(await api.getDoc(id!));
      }
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function cancel() {
    if (!confirm('Отменить проведение замеса? Сырьё вернётся на склад, бочка обнулится.')) return;
    setError(''); setBusy(true);
    try { await api.cancelDoc(id!); applyDoc(await api.getDoc(id!)); } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function remove() {
    if (!confirm('Удалить черновик замеса?')) return;
    await api.deleteDoc(id!);
    navigate('/stock/mixes');
  }

  const lotsFor = (itemId: string) => balances.filter((b) => b.lot.item.id === itemId)
    .sort((a, b) => (a.lot.expiresAt ? Date.parse(a.lot.expiresAt) : Infinity) - (b.lot.expiresAt ? Date.parse(b.lot.expiresAt) : Infinity));

  let lastStage = -1;

  return (
    <>
      <div className="space-y-4 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/stock/mixes" className="text-slate-500 hover:text-slate-900 text-sm">← Замесы</Link>
          <h2 className="text-xl font-semibold">Замес {number && <span className="font-mono text-base text-slate-500">{number}</span>}</h2>
          {!isNew && <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', DOC_STATUS[status].cls)}>{DOC_STATUS[status].label}</span>}
          <div className="flex-1" />
          {lines.length > 0 && <button onClick={() => window.print()} className={btnSecondary}>Печать карты A4</button>}
        </div>

        <div className="bg-white rounded-xl border p-4 grid grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs text-slate-500 col-span-2">Полуфабрикат
            <select disabled={readOnly} value={head.outputItemId} onChange={(e) => setHead({ ...head, outputItemId: e.target.value })} className={inputCls}>
              <option value="">— выберите —</option>
              {semis.map((s) => <option key={s.id} value={s.id} disabled={!s.recipe}>{s.name}{!s.recipe ? ' (нет рецептуры)' : ''}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">Масса замеса, кг
            <input disabled={readOnly} value={head.plannedQty} onChange={(e) => setHead({ ...head, plannedQty: e.target.value })} className={inputCls + ' text-right'} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">Бочка
            <input disabled={readOnly} value={head.barrel} onChange={(e) => setHead({ ...head, barrel: e.target.value })} className={inputCls} placeholder="Б-07" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">Дата
            <input type="date" disabled={readOnly} value={head.date} onChange={(e) => setHead({ ...head, date: e.target.value })} className={inputCls} />
          </label>
          {!readOnly && <button onClick={calc} className={btnSecondary}>{lines.length ? 'Пересчитать' : 'Рассчитать'}</button>}
        </div>

        {warn && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{warn}</p>}

        {lines.length > 0 && (
          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                  <th className="px-3 py-2 font-medium min-w-[200px]">Компонент</th>
                  <th className="px-3 py-2 font-medium text-right">Норма</th>
                  <th className="px-3 py-2 font-medium text-right">Факт, кг</th>
                  <th className="px-3 py-2 font-medium min-w-[220px]">Лот</th>
                  <th className="px-3 py-2 font-medium text-right">Откл.</th>
                  {!readOnly && <th className="w-8" />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const it = rawById.get(l.itemId);
                  const showStage = l.stage !== lastStage;
                  lastStage = l.stage;
                  const d = devByItem.get(l.itemId);
                  // Отклонение показываем в последней строке компонента
                  const lastOfItem = l.planQty != null && !lines.slice(idx + 1).some((x) => x.itemId === l.itemId && x.planQty != null);
                  const dev = lastOfItem && d ? deviation(d.plan, d.fact + (corrByItem.get(l.itemId) ?? 0)) : null;
                  return (
                    <Fragment key={l.key}>
                      {showStage && (
                        <tr className="bg-slate-50 border-b">
                          <td colSpan={readOnly ? 5 : 6} className="px-3 py-1.5 font-semibold text-xs">
                            Этап {l.stage}{stages[l.stage] && <span className="font-normal text-slate-500"> · {stages[l.stage]}</span>}
                          </td>
                        </tr>
                      )}
                      <tr className={clsx('border-b last:border-0', l.planQty == null && 'bg-amber-50/50')}>
                        <td className="px-3 py-1.5">
                          {l.planQty == null && !readOnly ? (
                            <div className="flex flex-col gap-1">
                              <select value={l.itemId} onChange={(e) => patch(l.key, { itemId: e.target.value, lotId: '' })} className={inputCls}>
                                <option value="">— корректировка —</option>
                                {raws.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                              </select>
                              <input value={l.reason} onChange={(e) => patch(l.key, { reason: e.target.value })} placeholder="Причина" className={inputCls + ' text-xs'} />
                            </div>
                          ) : (
                            <>
                              {it?.name ?? '…'}
                              {l.planQty == null && <span className="text-xs text-amber-700 ml-1">корр.{l.reason && `: ${l.reason}`}</span>}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap text-slate-600">{l.planQty != null ? kgStr(l.planQty) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">
                          <input disabled={readOnly} value={l.qty} onChange={(e) => patch(l.key, { qty: e.target.value })} className={inputCls + ' w-24 text-right'} />
                        </td>
                        <td className="px-3 py-1.5">
                          {it?.noStock ? <span className="text-slate-400">без учёта</span> : readOnly ? (
                            <span className="font-mono text-xs">{l.lotNumber ?? '—'}</span>
                          ) : (
                            <select value={l.lotId} onChange={(e) => patch(l.key, { lotId: e.target.value })}
                              className={clsx(inputCls, 'w-full', !l.lotId && (parseNum(l.qty) ?? 0) > 0 && 'border-red-400')}>
                              <option value="">— лот —</option>
                              {lotsFor(l.itemId).map((b) => (
                                <option key={b.lotId} value={b.lotId}>
                                  {b.lot.number} · {fmtQty(b.qty)} {b.lot.item.unit}{b.lot.expiresAt ? ` · до ${fmtDate(b.lot.expiresAt)}` : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className={clsx('px-3 py-1.5 text-right whitespace-nowrap', dev?.cls)}>
                          {dev ? `${dev.pct > 0 ? '+' : ''}${fmtQty(dev.pct, 1)} %` : ''}
                        </td>
                        {!readOnly && (
                          <td className="px-2 py-1.5">
                            <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-slate-400 hover:text-red-600" title="Удалить строку">✕</button>
                          </td>
                        )}
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {!readOnly && (
              <div className="p-3 border-t flex flex-wrap gap-4 text-sm">
                <button onClick={addCorrection} className="text-brand-600 hover:underline">+ Корректировка</button>
                <span className="text-slate-500">Чтобы взять компонент из двух лотов, добавьте корректировку с тем же компонентом.</span>
              </div>
            )}
          </div>
        )}

        {lines.length > 0 && (
          <div className="bg-white rounded-xl border p-4 grid grid-cols-2 lg:grid-cols-6 gap-3 items-end">
            <div className="text-sm"><div className="text-xs text-slate-500">По норме</div>{fmtQty(planTotal, 2)} кг</div>
            <div className="text-sm"><div className="text-xs text-slate-500">Факт (с корр.)</div>{fmtQty(factTotal, 2)} кг</div>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Выход в бочку, кг
              <input disabled={readOnly} value={head.yieldQty} onChange={(e) => setHead({ ...head, yieldQty: e.target.value })} className={inputCls + ' text-right'} />
            </label>
            <div className="text-sm"><div className="text-xs text-slate-500">Потери</div>
              {yieldQty != null ? <span className={clsx(factTotal - yieldQty > factTotal * 0.02 && 'text-amber-700 font-semibold')}>{fmtQty(factTotal - yieldQty, 2)} кг</span> : '—'}
            </div>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Годен до
              <input type="date" disabled={readOnly} value={head.expiresAt} onChange={(e) => setHead({ ...head, expiresAt: e.target.value })} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Комментарий
              <input disabled={readOnly} value={head.comment} onChange={(e) => setHead({ ...head, comment: e.target.value })} className={inputCls} />
            </label>
          </div>
        )}

        {status === 'POSTED' && output?.number && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm">
            Бочка <b>{head.barrel || '—'}</b> оприходована как лот{' '}
            <Link to="/stock/warehouse?type=SEMI" className="font-mono text-brand-700 hover:underline">{output.number}</Link>
            {' '}· {fmtQty(yieldQty)} кг · себестоимость {output.unitCost != null ? `${fmtMoney(output.unitCost)} ₽/кг` : 'не определена (у части сырья нет цены)'}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex flex-wrap gap-2">
          {!readOnly && (
            <>
              <button disabled={busy || lines.length === 0} onClick={() => save(true)} className={btnPrimary}>Провести замес</button>
              <button disabled={busy || !head.outputItemId} onClick={() => save(false)} className={btnSecondary}>Сохранить черновик</button>
              {!isNew && <button disabled={busy} onClick={remove} className="text-red-600 hover:underline text-sm px-2">Удалить</button>}
            </>
          )}
          {status === 'POSTED' && <button disabled={busy} onClick={cancel} className={btnSecondary}>Отменить проведение</button>}
        </div>
        {!readOnly && (
          <p className="text-xs text-slate-500">
            Порядок работы: рассчитать → сохранить черновик → распечатать карту для оператора → внести факт и лоты с карты → указать выход → провести.
            Лоты подставлены по FEFO (ближайший срок годности первым).
          </p>
        )}
      </div>

      {/* Печатная карта замеса */}
      <div className="hidden print:block text-black text-[11px] leading-snug">
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="text-base font-bold">КАРТА ЗАМЕСА {number || '(черновик)'}</div>
            <div>{semi?.name} · {head.plannedQty} кг · бочка {head.barrel || '____'}</div>
            <div>Дата {fmtDate(head.date)} · Оператор ______________________</div>
          </div>
          {qc && <div className="max-w-[45%] text-right">ОТК: {qc}</div>}
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr>{['№', 'Компонент', 'Норма', 'Факт', 'Лот', '✓'].map((h) => <th key={h} className="border border-slate-400 px-1.5 py-1 text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {(() => {
              let st = -1; let n = 0;
              return lines.filter((l) => l.planQty != null).map((l) => {
                const head2 = l.stage !== st; st = l.stage; n += 1;
                return (
                  <Fragment key={l.key}>
                    {head2 && <tr><td colSpan={6} className="border border-slate-400 px-1.5 py-1 font-bold bg-slate-100">Этап {l.stage}{stages[l.stage] ? ` · ${stages[l.stage]}` : ''}</td></tr>}
                    <tr>
                      <td className="border border-slate-400 px-1.5 py-1 w-6">{n}</td>
                      <td className="border border-slate-400 px-1.5 py-1">{rawById.get(l.itemId)?.name}</td>
                      <td className="border border-slate-400 px-1.5 py-1 whitespace-nowrap">{kgStr(l.planQty!)}</td>
                      <td className="border border-slate-400 px-1.5 py-1 w-20" />
                      <td className="border border-slate-400 px-1.5 py-1 w-28 text-slate-500">{rawById.get(l.itemId)?.noStock ? '—' : l.lotNumber ?? lotsFor(l.itemId).find((b) => b.lotId === l.lotId)?.lot.number ?? ''}</td>
                      <td className="border border-slate-400 px-1.5 py-1 w-6">☐</td>
                    </tr>
                  </Fragment>
                );
              });
            })()}
          </tbody>
        </table>
        <div className="mt-3">Корректировки (компонент, кг, лот, причина):</div>
        {[1, 2, 3].map((i) => <div key={i} className="border-b border-slate-400 h-6" />)}
        <div className="mt-3">Итого по норме {fmtQty(planTotal, 2)} кг · Выход в бочку ________ кг · Подпись мастера ______________</div>
        <div className="mt-1 text-slate-600">Навески меньше 1 кг указаны в граммах. Лот — подсказка по FEFO; если берёте другой мешок, впишите его номер в «Факт/Лот».</div>
      </div>
    </>
  );
}
