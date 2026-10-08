import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { ITEM_TYPES, btnPrimary, fmtQty, inputCls, parseNum } from './common';

interface Mat { key: string; itemId: string; qtyPerUnit: string }

let seq = 0;
const newMat = (): Mat => ({ key: String(++seq), itemId: '', qtyPerUnit: '1' });
const MATERIAL_TYPES = ['CONTAINER', 'LABEL', 'PACKAGING', 'RAW'];

export default function StockSkus() {
  const [skus, setSkus] = useState<any[]>([]);
  const [semis, setSemis] = useState<any[]>([]);
  const [mats, setMats] = useState<any[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [semiItemId, setSemiItemId] = useState('');
  const [netQty, setNetQty] = useState('');
  const [lines, setLines] = useState<Mat[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(keep?: string) {
    const [s, semi, all] = await Promise.all([api.getSpecs(), api.getItems('SEMI'), api.getItems()]);
    setSkus(s);
    setSemis(semi);
    setMats(all.filter((i: any) => MATERIAL_TYPES.includes(i.type)));
    const sel = s.find((x: any) => x.id === keep) ?? s[0];
    if (sel) select(sel);
  }
  useEffect(() => { load(); }, []);

  function select(sku: any) {
    setSelId(sku.id);
    setMsg(null);
    setSemiItemId(sku.spec?.semiItemId ?? '');
    setNetQty(sku.spec?.netQty != null ? String(sku.spec.netQty).replace('.', ',') : '');
    setLines(sku.spec?.materials.length
      ? sku.spec.materials.map((m: any) => ({ key: String(++seq), itemId: m.itemId, qtyPerUnit: String(m.qtyPerUnit).replace('.', ',') }))
      : [newMat()]);
  }

  const patch = (key: string, p: Partial<Mat>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const used = lines.filter((l) => l.itemId);
      if (used.some((l) => !(parseNum(l.qtyPerUnit)! > 0))) throw new Error('Количество материала на 1 шт должно быть больше нуля');
      await api.saveSpec(selId!, {
        semiItemId: semiItemId || null,
        netQty: parseNum(netQty),
        materials: used.map((l) => ({ itemId: l.itemId, qtyPerUnit: parseNum(l.qtyPerUnit)! })),
      });
      await load(selId!);
      setMsg({ ok: true, text: 'Карточка сохранена' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  if (skus.length === 0) {
    return <p className="text-gray-500 text-center mt-10">Нет SKU. Добавьте их в <Link to="/stock/items" className="text-blue-600 hover:underline">номенклатуре</Link> с типом «Готовая продукция».</p>;
  }

  const sel = skus.find((s) => s.id === selId);
  const grouped = ITEM_TYPES.filter((t) => MATERIAL_TYPES.includes(t.value))
    .map((t) => ({ ...t, items: mats.filter((m) => m.type === t.value) })).filter((g) => g.items.length);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4">
      <div className="bg-white rounded-xl border p-2 h-fit">
        {skus.map((s) => (
          <button key={s.id} onClick={() => select(s)}
            className={clsx('w-full text-left px-3 py-2 rounded-lg text-sm flex justify-between gap-2',
              s.id === selId ? 'bg-blue-50 text-blue-800 font-medium' : 'hover:bg-gray-50')}>
            <span>{s.name}</span>
            {!s.spec?.netQty && <span className="text-xs text-amber-700 shrink-0">не заполнена</span>}
          </button>
        ))}
      </div>

      {sel && (
        <div className="space-y-4 min-w-0">
          <h2 className="text-xl font-semibold">{sel.name}</h2>

          <div className="bg-white rounded-xl border p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-500">Полуфабрикат
              <select value={semiItemId} onChange={(e) => setSemiItemId(e.target.value)} className={inputCls}>
                <option value="">— любой —</option>
                {semis.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">Нетто полуфабриката в 1 шт, кг
              <input value={netQty} onChange={(e) => setNetQty(e.target.value)} className={inputCls + ' text-right'} placeholder="0,4" />
            </label>
          </div>

          <div className="bg-white rounded-xl border overflow-x-auto">
            <h3 className="px-4 pt-3 font-semibold text-sm">Материалы на 1 шт <span className="font-normal text-gray-500">— списываются при фасовке</span></h3>
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
                  <th className="px-4 py-2 font-medium">Материал</th>
                  <th className="px-4 py-2 font-medium text-right w-36">На 1 шт</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-b last:border-0">
                    <td className="px-4 py-1.5">
                      <select value={l.itemId} onChange={(e) => patch(l.key, { itemId: e.target.value })} className={inputCls + ' w-full'}>
                        <option value="">— тара, этикетка… —</option>
                        {grouped.map((g) => (
                          <optgroup key={g.value} label={g.label}>
                            {g.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-1.5 text-right whitespace-nowrap">
                      <input value={l.qtyPerUnit} onChange={(e) => patch(l.key, { qtyPerUnit: e.target.value })} className={inputCls + ' w-20 text-right'} />
                      <span className="text-xs text-gray-500 ml-1">{mats.find((m) => m.id === l.itemId)?.unit}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <button onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newMat()]))} className="text-gray-400 hover:text-red-600" title="Удалить">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 border-t">
              <button onClick={() => setLines((ls) => [...ls, newMat()])} className="text-blue-600 hover:underline text-sm">+ Материал</button>
            </div>
          </div>

          {msg && <p className={clsx('text-sm', msg.ok ? 'text-green-700' : 'text-red-600')}>{msg.text}</p>}
          <button disabled={busy} onClick={save} className={btnPrimary}>Сохранить карточку</button>
          {parseNum(netQty) != null && (
            <p className="text-xs text-gray-500">Из 100 кг полуфабриката выйдет около {fmtQty(Math.floor(100 / parseNum(netQty)!), 0)} шт без учёта потерь.</p>
          )}
          <p className="text-xs text-gray-500">Короб кванта и наклейки ЧЗ сюда не входят — они списываются при сборке квантов (следующий этап).</p>
        </div>
      )}
    </div>
  );
}
