import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { DOC_STATUS, btnPrimary, btnSecondary, fmtDate, fmtMoney, fmtQty, inputCls, parseNum } from './common';

interface Out { key: string; itemId: string; planQty: string; qty: string; lotNumber?: string | null; lotId?: string | null }
interface Mat { key: string; itemId: string; planQty: number | null; qty: string; lotId: string; lotNumber?: string | null }

let seq = 0;
const numStr = (n: number | null | undefined) => (n == null ? '' : String(Math.round(n * 1e6) / 1e6).replace('.', ','));
const newOut = (): Out => ({ key: String(++seq), itemId: '', planQty: '', qty: '' });

export default function StockFillEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;

  const [status, setStatus] = useState('DRAFT');
  const [number, setNumber] = useState('');
  const [barrels, setBarrels] = useState<any[]>([]);
  const [skus, setSkus] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [head, setHead] = useState({ date: new Date().toISOString().slice(0, 10), sourceLotId: '', remainQty: '', closeBarrel: true, comment: '' });
  const [sourceLotNumber, setSourceLotNumber] = useState<string | null>(null);
  const [outs, setOuts] = useState<Out[]>([newOut()]);
  const [mats, setMats] = useState<Mat[]>([]);
  const [planErrors, setPlanErrors] = useState<string[]>([]);
  const [shortages, setShortages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readOnly = status !== 'DRAFT';
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const specById = useMemo(() => new Map(skus.map((s) => [s.id, s.spec])), [skus]);

  function applyDoc(d: any) {
    setStatus(d.status); setNumber(d.number); setSourceLotNumber(d.sourceLotNumber);
    setHead({
      date: d.date.slice(0, 10), sourceLotId: d.sourceLotId ?? '', remainQty: numStr(d.remainQty),
      closeBarrel: d.remainQty != null, comment: d.comment ?? '',
    });
    const o = d.lines.filter((l: any) => l.item.type === 'PRODUCT');
    setOuts(o.length ? o.map((l: any) => ({
      key: String(++seq), itemId: l.itemId, planQty: numStr(l.planQty), qty: numStr(l.qty), lotNumber: l.lotNumber, lotId: l.lotId,
    })) : [newOut()]);
    setMats(d.lines.filter((l: any) => l.item.type !== 'PRODUCT').map((l: any) => ({
      key: String(++seq), itemId: l.itemId, planQty: l.planQty, qty: numStr(l.qty), lotId: l.lotId ?? '', lotNumber: l.lotNumber,
    })));
  }

  useEffect(() => {
    api.getBarrels().then(setBarrels);
    api.getSpecs().then(setSkus);
    api.getItems().then(setItems);
    api.getBalances().then(setBalances);
    if (id) api.getDoc(id).then(applyDoc).catch((e) => setError(e.message));
  }, [id]);

  const barrel = barrels.find((b) => b.id === head.sourceLotId);
  const barrelQty: number | null = barrel?.qty ?? null;
  const fitSkus = skus.filter((s) => !barrel || !s.spec?.semiItemId || s.spec.semiItemId === barrel.itemId);

  const usedKg = outs.reduce((s, o) => s + (parseNum(o.qty) ?? 0) * (specById.get(o.itemId)?.netQty ?? 0), 0);
  const remain = head.closeBarrel ? parseNum(head.remainQty) : null;
  const loss = barrelQty != null && remain != null ? barrelQty - usedKg - remain : null;

  const patchOut = (key: string, p: Partial<Out>) => setOuts((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const patchMat = (key: string, p: Partial<Mat>) => setMats((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  async function calc() {
    setError(''); setPlanErrors([]); setShortages([]);
    if (!head.sourceLotId) { setError('Выберите бочку'); return; }
    const outputs = outs.filter((o) => o.itemId).map((o) => ({ itemId: o.itemId, qty: parseNum(o.qty) ?? parseNum(o.planQty) ?? 0 }));
    if (!outputs.length) { setError('Добавьте SKU'); return; }
    try {
      const plan = await api.getFillPlan({ sourceLotId: head.sourceLotId, outputs });
      setPlanErrors(plan.errors);
      const next: Mat[] = [];
      const short: string[] = [];
      for (const m of plan.materials) {
        for (const a of m.allocations) next.push({ key: String(++seq), itemId: m.item.id, planQty: a.qty, qty: numStr(a.qty), lotId: a.lotId ?? '' });
        if (m.shortage > 0) {
          short.push(`${m.item.name}: не хватает ${fmtQty(m.shortage)} ${m.item.unit}`);
          next.push({ key: String(++seq), itemId: m.item.id, planQty: m.shortage, qty: numStr(m.shortage), lotId: '' });
        }
      }
      setMats(next);
      setShortages(short);
    } catch (e: any) { setError(e.message); }
  }

  function payload() {
    const o = outs.filter((x) => x.itemId);
    for (const x of o) if (parseNum(x.qty) == null && parseNum(x.planQty) == null) throw new Error(`Укажите количество: ${itemById.get(x.itemId)?.name}`);
    return {
      type: 'FILL',
      date: head.date,
      sourceLotId: head.sourceLotId || null,
      remainQty: remain,
      comment: head.comment || null,
      lines: [
        ...o.map((x) => ({ itemId: x.itemId, planQty: parseNum(x.planQty), qty: parseNum(x.qty) ?? 0 })),
        ...mats.filter((m) => m.itemId).map((m) => ({ itemId: m.itemId, lotId: m.lotId || null, planQty: m.planQty, qty: parseNum(m.qty) ?? 0 })),
      ],
    };
  }

  async function save(post: boolean) {
    setError(''); setBusy(true);
    try {
      const data = payload();
      if (post) {
        if (!outs.some((o) => (parseNum(o.qty) ?? 0) > 0)) throw new Error('Внесите фактическое количество');
        const noLot = mats.find((m) => (parseNum(m.qty) ?? 0) > 0 && !m.lotId);
        if (noLot) throw new Error(`Выберите лот: ${itemById.get(noLot.itemId)?.name}`);
        if (head.closeBarrel && remain == null) throw new Error('Укажите остаток в бочке (0, если бочка пустая)');
        if (loss != null && loss < -1e-6) throw new Error('Расход и остаток больше, чем было в бочке');
      }
      if (isNew) {
        const doc = await api.createDoc(data, post);
        navigate(`/stock/fill/${doc.id}`, { replace: true });
      } else {
        await api.updateDoc(id!, data);
        if (post) await api.postDoc(id!);
        applyDoc(await api.getDoc(id!));
      }
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function cancel() {
    if (!confirm('Отменить фасовку? Полуфабрикат и материалы вернутся, партии ГП обнулятся.')) return;
    setError(''); setBusy(true);
    try { await api.cancelDoc(id!); applyDoc(await api.getDoc(id!)); } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function remove() {
    if (!confirm('Удалить черновик фасовки?')) return;
    await api.deleteDoc(id!);
    navigate('/stock/fills');
  }

  const lotsFor = (itemId: string) => balances.filter((b) => b.lot.item.id === itemId && b.state === 'NONE')
    .sort((a, b) => (a.lot.expiresAt ? Date.parse(a.lot.expiresAt) : Infinity) - (b.lot.expiresAt ? Date.parse(b.lot.expiresAt) : Infinity));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/stock/fills" className="text-gray-500 hover:text-gray-900 text-sm">← Фасовка</Link>
        <h2 className="text-xl font-semibold">Фасовка {number && <span className="font-mono text-base text-gray-500">{number}</span>}</h2>
        {!isNew && <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', DOC_STATUS[status].cls)}>{DOC_STATUS[status].label}</span>}
      </div>

      <div className="bg-white rounded-xl border p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <label className="flex flex-col gap-1 text-xs text-gray-500 lg:col-span-2">Бочка
          {readOnly ? (
            <div className="text-sm text-gray-900 py-1.5 font-mono">{sourceLotNumber ?? '—'}</div>
          ) : (
            <select value={head.sourceLotId} onChange={(e) => setHead({ ...head, sourceLotId: e.target.value })} className={inputCls}>
              <option value="">— выберите бочку —</option>
              {barrels.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.number}{b.barrel ? ` · ${b.barrel}` : ''} · {b.item.name} · {fmtQty(b.qty)} кг{b.expiresAt ? ` · до ${fmtDate(b.expiresAt)}` : ''}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">Дата
          <input type="date" disabled={readOnly} value={head.date} onChange={(e) => setHead({ ...head, date: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">Комментарий
          <input disabled={readOnly} value={head.comment} onChange={(e) => setHead({ ...head, comment: e.target.value })} className={inputCls} />
        </label>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <h3 className="px-4 pt-3 font-semibold text-sm">Продукция</h3>
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
              <th className="px-3 py-2 font-medium min-w-[220px]">SKU</th>
              <th className="px-3 py-2 font-medium text-right">Нетто</th>
              <th className="px-3 py-2 font-medium text-right">План, шт</th>
              <th className="px-3 py-2 font-medium text-right">Факт, шт</th>
              <th className="px-3 py-2 font-medium text-right">Кг</th>
              {readOnly && <th className="px-3 py-2 font-medium">Партия</th>}
              {!readOnly && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {outs.map((o) => {
              const sp = specById.get(o.itemId);
              const q = parseNum(o.qty) ?? 0;
              return (
                <tr key={o.key} className="border-b last:border-0">
                  <td className="px-3 py-1.5">
                    {readOnly ? itemById.get(o.itemId)?.name : (
                      <select value={o.itemId} onChange={(e) => patchOut(o.key, { itemId: e.target.value })} className={inputCls + ' w-full'}>
                        <option value="">— SKU —</option>
                        {fitSkus.map((s) => <option key={s.id} value={s.id} disabled={!s.spec?.netQty}>{s.name}{!s.spec?.netQty ? ' (нет карточки)' : ''}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-600 whitespace-nowrap">{sp?.netQty ? `${fmtQty(sp.netQty)} кг` : '—'}</td>
                  <td className="px-3 py-1.5 text-right"><input disabled={readOnly} value={o.planQty} onChange={(e) => patchOut(o.key, { planQty: e.target.value })} className={inputCls + ' w-24 text-right'} /></td>
                  <td className="px-3 py-1.5 text-right"><input disabled={readOnly} value={o.qty} onChange={(e) => patchOut(o.key, { qty: e.target.value })} className={inputCls + ' w-24 text-right'} /></td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{sp?.netQty ? fmtQty(q * sp.netQty, 2) : '—'}</td>
                  {readOnly && (
                    <td className="px-3 py-1.5">
                      {o.lotId ? <Link to={`/stock/moves?lotId=${o.lotId}`} className="font-mono text-xs text-blue-700 hover:underline">{o.lotNumber}</Link> : '—'}
                    </td>
                  )}
                  {!readOnly && (
                    <td className="px-2 py-1.5">
                      <button onClick={() => setOuts((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== o.key) : [newOut()]))} className="text-gray-400 hover:text-red-600" title="Удалить">✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!readOnly && (
          <div className="p-3 border-t flex flex-wrap gap-4 items-center">
            <button onClick={() => setOuts((ls) => [...ls, newOut()])} className="text-blue-600 hover:underline text-sm">+ SKU</button>
            <button onClick={calc} className={btnSecondary}>{mats.length ? 'Пересчитать материалы' : 'Рассчитать материалы'}</button>
          </div>
        )}
      </div>

      {planErrors.length > 0 && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{planErrors.join('; ')}</p>}
      {shortages.length > 0 && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Материалов недостаточно — {shortages.join('; ')}</p>}

      {mats.length > 0 && (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <h3 className="px-4 pt-3 font-semibold text-sm">Списание материалов</h3>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
                <th className="px-3 py-2 font-medium">Материал</th>
                <th className="px-3 py-2 font-medium text-right">По норме</th>
                <th className="px-3 py-2 font-medium text-right">Факт</th>
                <th className="px-3 py-2 font-medium min-w-[220px]">Лот</th>
                {!readOnly && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {mats.map((m) => {
                const it = itemById.get(m.itemId);
                return (
                  <tr key={m.key} className="border-b last:border-0">
                    <td className="px-3 py-1.5">{it?.name}</td>
                    <td className="px-3 py-1.5 text-right text-gray-600 whitespace-nowrap">{m.planQty != null ? `${fmtQty(m.planQty)} ${it?.unit ?? ''}` : '—'}</td>
                    <td className="px-3 py-1.5 text-right"><input disabled={readOnly} value={m.qty} onChange={(e) => patchMat(m.key, { qty: e.target.value })} className={inputCls + ' w-24 text-right'} /></td>
                    <td className="px-3 py-1.5">
                      {readOnly ? <span className="font-mono text-xs">{m.lotNumber ?? '—'}</span> : (
                        <select value={m.lotId} onChange={(e) => patchMat(m.key, { lotId: e.target.value })}
                          className={clsx(inputCls, 'w-full', !m.lotId && (parseNum(m.qty) ?? 0) > 0 && 'border-red-400')}>
                          <option value="">— лот —</option>
                          {lotsFor(m.itemId).map((b) => (
                            <option key={b.lotId} value={b.lotId}>{b.lot.number} · {fmtQty(b.qty)} {b.lot.item.unit}{b.lot.unitCost != null ? ` · ${fmtMoney(b.lot.unitCost)} ₽` : ''}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    {!readOnly && (
                      <td className="px-2 py-1.5">
                        <button onClick={() => setMats((ls) => ls.filter((x) => x.key !== m.key))} className="text-gray-400 hover:text-red-600" title="Удалить">✕</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!readOnly && <p className="px-4 py-2 text-xs text-gray-500 border-t">Лоты подставлены по FEFO. Брак тары или этикеток — увеличьте факт.</p>}
        </div>
      )}

      <div className="bg-white rounded-xl border p-4 grid grid-cols-2 lg:grid-cols-5 gap-3 items-end text-sm">
        <div><div className="text-xs text-gray-500">В бочке</div>{barrelQty != null ? `${fmtQty(barrelQty)} кг` : readOnly ? '—' : 'выберите бочку'}</div>
        <div><div className="text-xs text-gray-500">Расход по нетто</div>{fmtQty(usedKg, 2)} кг</div>
        <label className="flex items-center gap-2 text-sm text-gray-700 pb-1.5">
          <input type="checkbox" disabled={readOnly} checked={head.closeBarrel} onChange={(e) => setHead({ ...head, closeBarrel: e.target.checked })} />
          Взвесить остаток
        </label>
        {head.closeBarrel ? (
          <label className="flex flex-col gap-1 text-xs text-gray-500">Остаток в бочке, кг
            <input disabled={readOnly} value={head.remainQty} onChange={(e) => setHead({ ...head, remainQty: e.target.value })} className={inputCls + ' text-right'} placeholder="0" />
          </label>
        ) : <div className="text-xs text-gray-500">Спишется только расход по нетто, потери не считаются</div>}
        <div>
          <div className="text-xs text-gray-500">Потери</div>
          {loss != null ? (
            <span className={clsx(loss < -1e-6 ? 'text-red-600 font-bold' : barrelQty && loss > (barrelQty - (remain ?? 0)) * 0.02 ? 'text-amber-700 font-semibold' : '')}>
              {fmtQty(loss, 2)} кг{usedKg > 0 && ` (${fmtQty((loss / (usedKg + Math.max(loss, 0))) * 100, 1)} %)`}
            </span>
          ) : '—'}
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {!readOnly && (
          <>
            <button disabled={busy} onClick={() => save(true)} className={btnPrimary}>Провести фасовку</button>
            <button disabled={busy} onClick={() => save(false)} className={btnSecondary}>Сохранить черновик</button>
            {!isNew && <button disabled={busy} onClick={remove} className="text-red-600 hover:underline text-sm px-2">Удалить</button>}
          </>
        )}
        {status === 'POSTED' && <button disabled={busy} onClick={cancel} className={btnSecondary}>Отменить проведение</button>}
      </div>
      {status === 'POSTED' && (
        <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          Партии ГП созданы в состоянии «без ЧЗ». Себестоимость единицы — в разделе <Link to="/stock?type=PRODUCT" className="underline">Остатки → Готовая продукция</Link>.
        </p>
      )}
    </div>
  );
}
