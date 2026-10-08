import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, inputCls, parseNum } from './common';

interface Mat { key: string; itemId: string; qtyPerQuant: string }
interface Form {
  id: string | null; name: string; productItemId: string; unitsPerQuant: string; boxItemId: string;
  trackCz: boolean; projectId: string; labelWidthMm: string; labelHeightMm: string; archived: boolean; materials: Mat[];
}

let seq = 0;
const emptyForm = (): Form => ({
  id: null, name: '', productItemId: '', unitsPerQuant: '42', boxItemId: '', trackCz: true, projectId: '',
  labelWidthMm: '58', labelHeightMm: '40', archived: false, materials: [],
});

export default function StockQuantTypes() {
  const [types, setTypes] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [boxes, setBoxes] = useState<any[]>([]);
  const [mats, setMats] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() { setTypes(await api.getQuantTypes()); }
  useEffect(() => {
    load();
    api.getItems().then((all) => {
      setProducts(all.filter((i: any) => i.type === 'PRODUCT'));
      setBoxes(all.filter((i: any) => i.type === 'PACKAGING'));
      setMats(all.filter((i: any) => ['LABEL', 'PACKAGING', 'CONTAINER'].includes(i.type)));
    });
    api.getProjects().then(setProjects);
  }, []);

  function edit(t: any) {
    setError('');
    setForm({
      id: t.id, name: t.name, productItemId: t.productItemId, unitsPerQuant: String(t.unitsPerQuant), boxItemId: t.boxItemId ?? '',
      trackCz: t.trackCz, projectId: t.projectId ?? '', labelWidthMm: String(t.labelWidthMm), labelHeightMm: String(t.labelHeightMm),
      archived: t.archived,
      materials: t.materials.map((m: any) => ({ key: String(++seq), itemId: m.itemId, qtyPerQuant: String(m.qtyPerQuant).replace('.', ',') })),
    });
  }

  async function save() {
    if (!form) return;
    setError(''); setBusy(true);
    try {
      await api.saveQuantType(form.id, {
        name: form.name.trim(),
        productItemId: form.productItemId,
        unitsPerQuant: Number(form.unitsPerQuant),
        boxItemId: form.boxItemId || null,
        trackCz: form.trackCz,
        projectId: form.projectId || null,
        labelWidthMm: parseNum(form.labelWidthMm) ?? 58,
        labelHeightMm: parseNum(form.labelHeightMm) ?? 40,
        archived: form.archived,
        materials: form.materials.filter((m) => m.itemId).map((m) => ({ itemId: m.itemId, qtyPerQuant: parseNum(m.qtyPerQuant) ?? 0 })),
      });
      setForm(null);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  const set = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));
  const setMat = (key: string, p: Partial<Mat>) => set({ materials: form!.materials.map((m) => (m.key === key ? { ...m, ...p } : m)) });
  const units = Number(form?.unitsPerQuant) || 0;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-600">Квант — короб с фиксированным количеством единиц одного SKU. Для каждого кванта с ЧЗ выдаётся свой набор кодов.</p>
        {!form && <button onClick={() => { setError(''); setForm(emptyForm()); }} className={btnPrimary}>+ Тип кванта</button>}
      </div>

      {form && (
        <div className="bg-white rounded-xl border p-4 space-y-4">
          <h3 className="font-semibold">{form.id ? 'Изменить тип кванта' : 'Новый тип кванта'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-500">Название
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder="Шпатлёвка туба ×42" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">SKU
              <select value={form.productItemId} onChange={(e) => set({ productItemId: e.target.value })} className={inputCls}>
                <option value="">— выберите —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">Единиц в кванте
              <input value={form.unitsPerQuant} onChange={(e) => set({ unitsPerQuant: e.target.value.replace(/\D/g, '') })} className={inputCls + ' text-right'} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">Короб
              <select value={form.boxItemId} onChange={(e) => set({ boxItemId: e.target.value })} className={inputCls}>
                <option value="">— без короба —</option>
                {boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <label className="flex items-center gap-2 text-sm pb-1.5">
              <input type="checkbox" checked={form.trackCz} onChange={(e) => set({ trackCz: e.target.checked })} /> Учитывать коды ЧЗ
            </label>
            <label className={clsx('flex flex-col gap-1 text-xs text-gray-500', !form.trackCz && 'opacity-40')}>Проект этикетки ЧЗ
              <select disabled={!form.trackCz} value={form.projectId} onChange={(e) => set({ projectId: e.target.value })} className={inputCls}>
                <option value="">— выберите проект —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">Этикетка кванта, ширина мм
              <input value={form.labelWidthMm} onChange={(e) => set({ labelWidthMm: e.target.value })} className={inputCls + ' text-right'} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">высота мм
              <input value={form.labelHeightMm} onChange={(e) => set({ labelHeightMm: e.target.value })} className={inputCls + ' text-right'} />
            </label>
          </div>

          <div>
            <div className="text-xs text-gray-500 mb-1">Доп. материалы на 1 квант (наклейки ЧЗ, скотч, вкладыш…)</div>
            {form.materials.map((m) => (
              <div key={m.key} className="flex gap-2 mb-1.5 items-center">
                <select value={m.itemId} onChange={(e) => setMat(m.key, { itemId: e.target.value })} className={inputCls + ' flex-1'}>
                  <option value="">— материал —</option>
                  {mats.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
                <input value={m.qtyPerQuant} onChange={(e) => setMat(m.key, { qtyPerQuant: e.target.value })} className={inputCls + ' w-24 text-right'} />
                <span className="text-xs text-gray-500 w-8">{mats.find((i) => i.id === m.itemId)?.unit}</span>
                <button onClick={() => set({ materials: form.materials.filter((x) => x.key !== m.key) })} className="text-gray-400 hover:text-red-600">✕</button>
              </div>
            ))}
            <div className="flex gap-4">
              <button onClick={() => set({ materials: [...form.materials, { key: String(++seq), itemId: '', qtyPerQuant: '1' }] })} className="text-blue-600 hover:underline text-sm">+ Материал</button>
              {form.trackCz && units > 0 && (
                <button onClick={() => set({ materials: [...form.materials, { key: String(++seq), itemId: '', qtyPerQuant: String(units) }] })} className="text-blue-600 hover:underline text-sm">
                  + Наклейки ЧЗ ({units} шт)
                </button>
              )}
            </div>
          </div>

          {form.id && (
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={form.archived} onChange={(e) => set({ archived: e.target.checked })} /> В архиве (не предлагать при сборке)
            </label>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button disabled={busy || !form.name.trim() || !form.productItemId || !units} onClick={save} className={btnPrimary}>Сохранить</button>
            <button onClick={() => setForm(null)} className={btnSecondary}>Отмена</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-x-auto">
        {types.length === 0 ? <p className="p-6 text-gray-500">Типов квантов пока нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
                <th className="px-3 py-2 font-medium">Тип</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium text-right">Ед.</th>
                <th className="px-3 py-2 font-medium">Короб</th>
                <th className="px-3 py-2 font-medium">ЧЗ</th>
                <th className="px-3 py-2 font-medium text-right">Свободно кодов</th>
                <th className="px-3 py-2 font-medium text-right">Квантов на складе</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const enough = t.freeCodes == null ? null : Math.floor(t.freeCodes / t.unitsPerQuant);
                return (
                  <tr key={t.id} className={clsx('border-b last:border-0', t.archived && 'text-gray-400')}>
                    <td className="px-3 py-2 font-medium">{t.name}{t.archived && ' (архив)'}</td>
                    <td className="px-3 py-2">{t.productItem.name}</td>
                    <td className="px-3 py-2 text-right">{t.unitsPerQuant}</td>
                    <td className="px-3 py-2">{t.boxItem?.name ?? '—'}</td>
                    <td className="px-3 py-2">{t.trackCz ? (t.project?.name ?? <span className="text-red-600">нет проекта</span>) : <span className="text-gray-400">не учитывается</span>}</td>
                    <td className="px-3 py-2 text-right">
                      {t.trackCz && t.freeCodes != null ? (
                        <span className={clsx(enough === 0 && 'text-red-600 font-semibold')}>{t.freeCodes} <span className="text-gray-400">(на {enough} кв.)</span></span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{t.inStock}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => edit(t)} className="text-blue-600 hover:underline">Изменить</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
