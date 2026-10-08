import { Fragment, useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, inputCls, parseNum } from './common';
import { Section } from './StockLayout';

interface Mat { key: string; itemId: string; qty: string }
interface Row {
  key: string; id: string | null; name: string; units: string; boxItemId: string; w: string; h: string;
  archived: boolean; materials: Mat[]; inStock: number; dirty: boolean;
}

let seq = 0;
const short = (name: string) => name.split(',')[0].replace(/^(Шпатл[её]вка|Краска)\s+/i, '');

// Варианты кванта SKU: 42 шт в короб №2, 24 шт в короб поменьше и т. д. ЧЗ наследуется из карточки SKU.
export default function QuantVariants({ item, spec }: { item: any; spec: any }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [boxes, setBoxes] = useState<any[]>([]);
  const [mats, setMats] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [types, all] = await Promise.all([api.getQuantTypes(), api.getItems()]);
    setBoxes(all.filter((i: any) => i.type === 'PACKAGING'));
    setMats(all.filter((i: any) => ['LABEL', 'PACKAGING', 'CONTAINER'].includes(i.type)));
    setRows(types.filter((t: any) => t.productItemId === item.id).map((t: any) => ({
      key: t.id, id: t.id, name: t.name, units: String(t.unitsPerQuant), boxItemId: t.boxItemId ?? '',
      w: String(t.labelWidthMm), h: String(t.labelHeightMm), archived: t.archived, inStock: t.inStock, dirty: false,
      materials: t.materials.map((m: any) => ({ key: String(++seq), itemId: m.itemId, qty: String(m.qtyPerQuant).replace('.', ',') })),
    })));
  }
  useEffect(() => { load(); }, [item.id]);

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p, dirty: true } : r)));
  const czLabel = mats.find((m) => m.type === 'LABEL' && /ЧЗ/i.test(m.name));

  function add() {
    const key = 'new' + ++seq;
    setRows((rs) => [...rs, { key, id: null, name: '', units: '', boxItemId: '', w: '58', h: '40', archived: false, materials: [], inStock: 0, dirty: true }]);
    setOpen(key);
  }

  async function save(r: Row) {
    setBusy(true); setMsg(null);
    try {
      const units = Number(r.units);
      if (!units) throw new Error('Укажите количество в кванте');
      await api.saveQuantType(r.id, {
        name: r.name.trim() || `${short(item.name)} ×${units}`,
        productItemId: item.id, unitsPerQuant: units, boxItemId: r.boxItemId || null,
        trackCz: !!spec?.requiresCz, projectId: spec?.czProjectId ?? null,
        labelWidthMm: parseNum(r.w) ?? 58, labelHeightMm: parseNum(r.h) ?? 40, archived: r.archived,
        materials: r.materials.filter((m) => m.itemId && parseNum(m.qty)).map((m) => ({ itemId: m.itemId, qtyPerQuant: parseNum(m.qty)! })),
      });
      await load();
      setOpen(null);
      setMsg({ ok: true, text: 'Вариант кванта сохранён' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  return (
    <Section title="Кванты" hint="Сколько единиц укладывается в короб. Можно завести несколько вариантов под разные коробки."
      right={<button onClick={add} className={btnSecondary}>+ Вариант кванта</button>}>
      {spec && (
        <p className="text-sm mb-3">
          Маркировка: {spec.requiresCz
            ? <span className="text-emerald-700">ЧЗ обязателен{spec.czProject ? ` · этикетка «${spec.czProject.name}»` : ''}</span>
            : <span className="text-slate-500">без ЧЗ</span>} <span className="text-xs text-slate-400">(задаётся выше, для всех вариантов)</span>
        </p>
      )}
      {rows.length === 0 ? <p className="text-sm text-slate-500">Вариантов нет. Добавьте хотя бы один, чтобы собирать кванты этого SKU.</p> : (
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="py-2 font-medium">Вариант</th>
              <th className="py-2 font-medium text-right w-24">Шт в кванте</th>
              <th className="py-2 font-medium px-3">Короб</th>
              <th className="py-2 font-medium text-right">На складе</th>
              <th className="py-2 w-40" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.key}>
                <tr className={clsx('border-b border-slate-100', r.archived && 'text-slate-400')}>
                  <td className="py-2 pr-2">
                    <input value={r.name} placeholder={r.units ? `${short(item.name)} ×${r.units}` : 'Название'} onChange={(e) => patch(r.key, { name: e.target.value })} className={inputCls + ' w-full'} />
                  </td>
                  <td className="py-2 text-right">
                    <input value={r.units} disabled={r.inStock > 0 && !!r.id} title={r.inStock > 0 ? 'По варианту уже собраны кванты' : ''}
                      onChange={(e) => patch(r.key, { units: e.target.value.replace(/\D/g, '') })} className={inputCls + ' w-20 text-right'} />
                  </td>
                  <td className="py-2 px-3">
                    <select value={r.boxItemId} onChange={(e) => patch(r.key, { boxItemId: e.target.value })} className={inputCls + ' w-full'}>
                      <option value="">— без короба —</option>
                      {boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </td>
                  <td className="py-2 text-right">{r.id ? `${r.inStock} кв.` : '—'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button onClick={() => setOpen(open === r.key ? null : r.key)} className="text-xs text-slate-500 hover:text-slate-800 mr-3">{open === r.key ? 'Скрыть' : 'Ещё'}</button>
                    <button disabled={busy || !r.dirty} onClick={() => save(r)} className={clsx('text-xs px-3 py-1.5 rounded-md', r.dirty ? 'bg-brand-600 text-white' : 'text-slate-400')}>Сохранить</button>
                  </td>
                </tr>
                {open === r.key && (
                  <tr className="bg-slate-50/70 border-b border-slate-100">
                    <td colSpan={5} className="p-3 space-y-3">
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Доп. материалы на 1 квант (этикетки с ЧЗ, скотч, вкладыш)</div>
                        {r.materials.map((m) => (
                          <div key={m.key} className="flex gap-2 mb-1.5 items-center">
                            <select value={m.itemId} onChange={(e) => patch(r.key, { materials: r.materials.map((x) => (x.key === m.key ? { ...x, itemId: e.target.value } : x)) })} className={inputCls + ' flex-1'}>
                              <option value="">— материал —</option>
                              {mats.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                            </select>
                            <input value={m.qty} onChange={(e) => patch(r.key, { materials: r.materials.map((x) => (x.key === m.key ? { ...x, qty: e.target.value } : x)) })} className={inputCls + ' w-20 text-right'} />
                            <button onClick={() => patch(r.key, { materials: r.materials.filter((x) => x.key !== m.key) })} className="text-slate-400 hover:text-red-600 px-1">✕</button>
                          </div>
                        ))}
                        <div className="flex gap-4">
                          <button onClick={() => patch(r.key, { materials: [...r.materials, { key: String(++seq), itemId: '', qty: '1' }] })} className="text-sm text-brand-700 hover:underline">+ Материал</button>
                          {spec?.requiresCz && czLabel && Number(r.units) > 0 && !r.materials.some((m) => m.itemId === czLabel.id) && (
                            <button onClick={() => patch(r.key, { materials: [...r.materials, { key: String(++seq), itemId: czLabel.id, qty: r.units }] })} className="text-sm text-brand-700 hover:underline">
                              + {czLabel.name} × {r.units}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-xs text-slate-500">Этикетка кванта, мм
                          <span className="flex items-center gap-1">
                            <input value={r.w} onChange={(e) => patch(r.key, { w: e.target.value })} className={inputCls + ' w-16 text-right'} />×
                            <input value={r.h} onChange={(e) => patch(r.key, { h: e.target.value })} className={inputCls + ' w-16 text-right'} />
                          </span>
                        </label>
                        {r.id && <label className="flex items-center gap-2 text-sm text-slate-600 pb-2"><input type="checkbox" checked={r.archived} onChange={(e) => patch(r.key, { archived: e.target.checked })} /> В архиве</label>}
                        {!r.id && <button onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-sm text-red-600 hover:underline pb-2">Убрать</button>}
                        <button disabled={busy || !r.dirty} onClick={() => save(r)} className={btnPrimary}>Сохранить вариант</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className={clsx('text-sm mt-3', msg.ok ? 'text-emerald-700' : 'text-red-600')}>{msg.text}</p>}
    </Section>
  );
}
