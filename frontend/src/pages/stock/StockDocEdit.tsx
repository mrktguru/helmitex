import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import {
  DOC_STATUS, ITEM_TYPES, STATE_LABEL, btnPrimary, btnSecondary, docTypeLabel,
  fmtMoney, fmtQty, inputCls, parseNum,
} from './common';

interface Line {
  key: string;
  itemId: string;
  lotKey: string;      // `${lotId}|${state}` — для корректировки
  qty: string;
  unitCost: string;
  supplierLot: string;
  expiresAt: string;
  barrel: string;
  state: string;
  reason: string;
  lotNumber?: string | null;
}

let seq = 0;
const emptyLine = (): Line => ({
  key: String(++seq), itemId: '', lotKey: '', qty: '', unitCost: '', supplierLot: '',
  expiresAt: '', barrel: '', state: 'UNLABELED', reason: '',
});
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

export default function StockDocEdit() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id;

  const [type, setType] = useState(params.get('type') ?? 'RECEIPT');
  const [status, setStatus] = useState('DRAFT');
  const [number, setNumber] = useState('');
  const [head, setHead] = useState({ date: new Date().toISOString().slice(0, 10), supplier: '', docRef: '', comment: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [items, setItems] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isAdj = type === 'ADJUSTMENT';
  const readOnly = status !== 'DRAFT';

  function applyDoc(d: any) {
    setType(d.type); setStatus(d.status); setNumber(d.number);
    setHead({ date: d.date.slice(0, 10), supplier: d.supplier ?? '', docRef: d.docRef ?? '', comment: d.comment ?? '' });
    setLines(d.lines.map((l: any) => ({
      key: String(++seq), itemId: l.itemId, lotKey: l.lotId ? `${l.lotId}|${l.state}` : '',
      qty: numStr(l.qty), unitCost: numStr(l.unitCost), supplierLot: l.supplierLot ?? '',
      expiresAt: l.expiresAt ? l.expiresAt.slice(0, 10) : '', barrel: l.barrel ?? '',
      state: l.state === 'NONE' ? 'UNLABELED' : l.state, reason: l.reason ?? '', lotNumber: l.lotNumber,
    })));
  }

  useEffect(() => {
    api.getItems().then(setItems);
    if (id) api.getDoc(id).then(applyDoc).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => { if (isAdj) api.getBalances().then(setBalances); }, [isAdj]);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  function patch(key: string, p: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  function balanceOf(lotKey: string): number | null {
    const [lotId, state] = lotKey.split('|');
    const b = balances.find((x) => x.lotId === lotId && x.state === state);
    return b ? b.qty : null;
  }

  const total = lines.reduce((s, l) => s + (parseNum(l.unitCost) ?? 0) * (parseNum(l.qty) ?? 0), 0);

  function payload() {
    const used = lines.filter((l) => l.itemId);
    for (const l of used) {
      const name = itemById.get(l.itemId)?.name ?? '';
      if (!parseNum(l.qty)) throw new Error(`Укажите количество: ${name}`);
      if (isAdj && !l.lotKey) throw new Error(`Выберите лот: ${name}`);
    }
    return {
      type,
      date: head.date,
      supplier: head.supplier || null,
      docRef: head.docRef || null,
      comment: head.comment || null,
      lines: used.map((l) => {
        const item = itemById.get(l.itemId);
        const [lotId, lotState] = l.lotKey.split('|');
        return {
          itemId: l.itemId,
          qty: parseNum(l.qty)!,
          ...(isAdj
            ? { lotId, state: lotState, reason: l.reason || null }
            : {
              unitCost: parseNum(l.unitCost),
              supplierLot: l.supplierLot || null,
              expiresAt: l.expiresAt || null,
              barrel: item?.type === 'SEMI' ? l.barrel || null : null,
              state: item?.type === 'PRODUCT' ? l.state : 'NONE',
            }),
        };
      }),
    };
  }

  async function save(post: boolean) {
    setError('');
    setBusy(true);
    try {
      const data = payload();
      if (isNew) {
        const doc = await api.createDoc(data, post);
        navigate(`/stock/docs/${doc.id}`, { replace: true });
      } else {
        await api.updateDoc(id!, data);
        if (post) await api.postDoc(id!);
        applyDoc(await api.getDoc(id!));
      }
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function cancel() {
    if (!confirm('Отменить проведение? Движения будут сторнированы.')) return;
    setError(''); setBusy(true);
    try { await api.cancelDoc(id!); setStatus('CANCELLED'); } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function remove() {
    if (!confirm('Удалить черновик?')) return;
    await api.deleteDoc(id!);
    navigate('/stock/docs');
  }

  const grouped = ITEM_TYPES.map((t) => ({ ...t, items: items.filter((i) => i.type === t.value) })).filter((g) => g.items.length);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/stock/warehouse?tab=docs" className="text-slate-500 hover:text-slate-900 text-sm">← Документы склада</Link>
        <h2 className="text-xl font-semibold">{docTypeLabel(type)} {number && <span className="font-mono text-base text-slate-500">{number}</span>}</h2>
        {!isNew && <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', DOC_STATUS[status].cls)}>{DOC_STATUS[status].label}</span>}
      </div>

      <div className="bg-white rounded-xl border p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Дата
          <input type="date" disabled={readOnly} value={head.date} onChange={(e) => setHead({ ...head, date: e.target.value })} className={inputCls} />
        </label>
        {type === 'RECEIPT' && (
          <>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Поставщик
              <input disabled={readOnly} value={head.supplier} onChange={(e) => setHead({ ...head, supplier: e.target.value })} className={inputCls} placeholder="ООО «Химпоставка»" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Документ
              <input disabled={readOnly} value={head.docRef} onChange={(e) => setHead({ ...head, docRef: e.target.value })} className={inputCls} placeholder="УПД № 4417 от 06.10" />
            </label>
          </>
        )}
        <label className={clsx('flex flex-col gap-1 text-xs text-slate-500', type !== 'RECEIPT' && 'lg:col-span-3')}>Комментарий
          <input disabled={readOnly} value={head.comment} onChange={(e) => setHead({ ...head, comment: e.target.value })} className={inputCls} />
        </label>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
              <th className="px-3 py-2 font-medium min-w-[220px]">Позиция</th>
              {isAdj ? (
                <>
                  <th className="px-3 py-2 font-medium min-w-[200px]">Лот</th>
                  <th className="px-3 py-2 font-medium text-right">Учёт</th>
                  <th className="px-3 py-2 font-medium text-right">Факт</th>
                  <th className="px-3 py-2 font-medium text-right">Изменение</th>
                  <th className="px-3 py-2 font-medium min-w-[160px]">Причина</th>
                </>
              ) : (
                <>
                  <th className="px-3 py-2 font-medium text-right">Кол-во</th>
                  <th className="px-3 py-2 font-medium text-right">Цена, ₽</th>
                  <th className="px-3 py-2 font-medium">Лот пост. / бочка</th>
                  <th className="px-3 py-2 font-medium">Годен до</th>
                  <th className="px-3 py-2 font-medium">Состояние</th>
                  <th className="px-3 py-2 font-medium text-right">Сумма</th>
                  {readOnly && <th className="px-3 py-2 font-medium">Лот</th>}
                </>
              )}
              {!readOnly && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const item = itemById.get(l.itemId);
              const lotOptions = isAdj ? balances.filter((b) => b.lot.item.id === l.itemId) : [];
              const bal = isAdj && l.lotKey ? balanceOf(l.lotKey) : null;
              const delta = parseNum(l.qty);
              return (
                <tr key={l.key} className="border-b last:border-0 align-top">
                  <td className="px-3 py-1.5">
                    <select disabled={readOnly} value={l.itemId} onChange={(e) => patch(l.key, { itemId: e.target.value, lotKey: '' })} className={inputCls + ' w-full'}>
                      <option value="">— выберите —</option>
                      {grouped.map((g) => (
                        <optgroup key={g.value} label={g.label}>
                          {g.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                  {isAdj ? (
                    <>
                      <td className="px-3 py-1.5">
                        <select disabled={readOnly || !l.itemId} value={l.lotKey} onChange={(e) => patch(l.key, { lotKey: e.target.value })} className={inputCls + ' w-full'}>
                          <option value="">— лот —</option>
                          {lotOptions.map((b) => (
                            <option key={b.lotId + b.state} value={`${b.lotId}|${b.state}`}>
                              {b.lot.number}{b.state !== 'NONE' ? ` · ${STATE_LABEL[b.state]}` : ''} · {fmtQty(b.qty)} {b.lot.item.unit}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-right pt-3 whitespace-nowrap">{bal != null ? `${fmtQty(bal)} ${item?.unit ?? ''}` : '—'}</td>
                      <td className="px-3 py-1.5 text-right">
                        <input disabled={readOnly || bal == null} className={inputCls + ' w-24 text-right'}
                          value={bal != null && delta != null ? numStr(Math.round((bal + delta) * 1e6) / 1e6) : ''}
                          onChange={(e) => { const f = parseNum(e.target.value); patch(l.key, { qty: f == null || bal == null ? '' : numStr(Math.round((f - bal) * 1e6) / 1e6) }); }} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input disabled={readOnly} value={l.qty} onChange={(e) => patch(l.key, { qty: e.target.value })}
                          className={clsx(inputCls, 'w-24 text-right', delta != null && delta < 0 ? 'text-red-600' : 'text-green-700')} placeholder="±" />
                      </td>
                      <td className="px-3 py-1.5">
                        <input disabled={readOnly} value={l.reason} onChange={(e) => patch(l.key, { reason: e.target.value })} className={inputCls + ' w-full'} placeholder="Пересорт, порча…" />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <input disabled={readOnly} value={l.qty} onChange={(e) => patch(l.key, { qty: e.target.value })} className={inputCls + ' w-24 text-right'} />
                        <span className="text-slate-500 ml-1 text-xs">{item?.unit}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input disabled={readOnly} value={l.unitCost} onChange={(e) => patch(l.key, { unitCost: e.target.value })} className={inputCls + ' w-24 text-right'}
                          placeholder={type === 'OPENING' ? 'позже' : ''} />
                      </td>
                      <td className="px-3 py-1.5">
                        {item?.type === 'SEMI' ? (
                          <input disabled={readOnly} value={l.barrel} onChange={(e) => patch(l.key, { barrel: e.target.value })} className={inputCls + ' w-28'} placeholder="Бочка Б-07" />
                        ) : (
                          <input disabled={readOnly} value={l.supplierLot} onChange={(e) => patch(l.key, { supplierLot: e.target.value })} className={inputCls + ' w-32 font-mono'} />
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <input type="date" disabled={readOnly} value={l.expiresAt} onChange={(e) => patch(l.key, { expiresAt: e.target.value })} className={inputCls} />
                      </td>
                      <td className="px-3 py-1.5">
                        {item?.type === 'PRODUCT' ? (
                          <select disabled={readOnly} value={l.state} onChange={(e) => patch(l.key, { state: e.target.value })} className={inputCls}>
                            <option value="UNLABELED">без ЧЗ</option>
                            <option value="LABELED">с ЧЗ</option>
                          </select>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right pt-3 whitespace-nowrap">
                        {parseNum(l.unitCost) != null && parseNum(l.qty) != null ? fmtMoney(parseNum(l.unitCost)! * parseNum(l.qty)!) : '—'}
                      </td>
                      {readOnly && <td className="px-3 py-1.5 pt-3 font-mono text-xs">{l.lotNumber ?? '—'}</td>}
                    </>
                  )}
                  {!readOnly && (
                    <td className="px-2 py-1.5 pt-2.5">
                      <button onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))}
                        className="text-slate-400 hover:text-red-600" title="Удалить строку">✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {!isAdj && total > 0 && (
            <tfoot>
              <tr className="border-t font-semibold">
                <td className="px-3 py-2" colSpan={6}>Итого</td>
                <td className="px-3 py-2 text-right">{fmtMoney(total)} ₽</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {!readOnly && (
          <div className="p-3 border-t">
            <button onClick={() => setLines((ls) => [...ls, emptyLine()])} className="text-brand-600 hover:underline text-sm">+ Строка</button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {!readOnly && (
          <>
            <button disabled={busy} onClick={() => save(true)} className={btnPrimary}>Провести</button>
            <button disabled={busy} onClick={() => save(false)} className={btnSecondary}>Сохранить черновик</button>
            {!isNew && <button disabled={busy} onClick={remove} className="text-red-600 hover:underline text-sm px-2">Удалить</button>}
          </>
        )}
        {status === 'POSTED' && <button disabled={busy} onClick={cancel} className={btnSecondary}>Отменить проведение</button>}
      </div>
      {!readOnly && !isAdj && (
        <p className="text-xs text-slate-500">При проведении на каждую строку создаётся лот со своим номером. Цену в начальных остатках можно оставить пустой.</p>
      )}
    </div>
  );
}
