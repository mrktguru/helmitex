import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ITEM_TYPES, btnPrimary, fmtQty, inputCls, parseNum, typeLabel } from './common';

interface Item { id: string; type: string; name: string; unit: string; minStock: number | null; archived: boolean }

export default function StockItems() {
  const [items, setItems] = useState<Item[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState({ type: 'RAW', name: '', unit: 'кг', minStock: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: '', unit: '', minStock: '' });
  const [error, setError] = useState('');

  async function load() { setItems(await api.getItems(undefined, showArchived)); }
  useEffect(() => { load(); }, [showArchived]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.createItem({ type: form.type, name: form.name.trim(), unit: form.unit.trim(), minStock: parseNum(form.minStock) });
      setForm({ ...form, name: '', minStock: '' });
      await load();
    } catch (err: any) { setError(err.message); }
  }

  async function saveEdit(id: string) {
    setError('');
    try {
      await api.updateItem(id, { name: edit.name.trim(), unit: edit.unit.trim(), minStock: parseNum(edit.minStock) });
      setEditId(null);
      await load();
    } catch (err: any) { setError(err.message); }
  }

  async function toggleArchive(it: Item) {
    await api.updateItem(it.id, { archived: !it.archived });
    await load();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="bg-white rounded-xl border p-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-500">Тип
          <select value={form.type} className={inputCls}
            onChange={(e) => setForm({ ...form, type: e.target.value, unit: ITEM_TYPES.find((t) => t.value === e.target.value)!.unit })}>
            {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 flex-1 min-w-[220px]">Наименование
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls}
            placeholder="Напр. TiO₂ BILLIONS R-996 или Туба ∅45 0,4 кг" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 w-20">Ед.
          <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 w-28">Мин. остаток
          <input value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} className={inputCls + ' text-right'} placeholder="—" />
        </label>
        <button type="submit" disabled={!form.name.trim()} className={btnPrimary}>Добавить</button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Показывать архивные
      </label>

      {ITEM_TYPES.map((t) => {
        const list = items.filter((i) => i.type === t.value);
        if (list.length === 0) return null;
        return (
          <div key={t.value} className="bg-white rounded-xl border overflow-x-auto">
            <h3 className="px-4 pt-3 pb-1 font-semibold">{typeLabel(t.value)} <span className="text-gray-400 font-normal text-sm">{list.length}</span></h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
                  <th className="px-4 py-2 font-medium">Наименование</th>
                  <th className="px-4 py-2 font-medium w-20">Ед.</th>
                  <th className="px-4 py-2 font-medium w-32 text-right">Мин. остаток</th>
                  <th className="px-4 py-2 w-48" />
                </tr>
              </thead>
              <tbody>
                {list.map((it) => editId === it.id ? (
                  <tr key={it.id} className="border-b last:border-0 bg-blue-50/40">
                    <td className="px-4 py-1.5"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className={inputCls + ' w-full'} /></td>
                    <td className="px-4 py-1.5"><input value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} className={inputCls + ' w-16'} /></td>
                    <td className="px-4 py-1.5"><input value={edit.minStock} onChange={(e) => setEdit({ ...edit, minStock: e.target.value })} className={inputCls + ' w-24 text-right'} /></td>
                    <td className="px-4 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => saveEdit(it.id)} className="text-blue-600 hover:underline mr-3">Сохранить</button>
                      <button onClick={() => setEditId(null)} className="text-gray-500 hover:underline">Отмена</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={it.id} className={'border-b last:border-0 ' + (it.archived ? 'text-gray-400' : '')}>
                    <td className="px-4 py-2">{it.name}{it.archived && ' (архив)'}</td>
                    <td className="px-4 py-2">{it.unit}</td>
                    <td className="px-4 py-2 text-right">{it.minStock != null ? fmtQty(it.minStock) : '—'}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button onClick={() => { setEditId(it.id); setEdit({ name: it.name, unit: it.unit, minStock: it.minStock != null ? String(it.minStock).replace('.', ',') : '' }); }}
                        className="text-blue-600 hover:underline mr-3">Изменить</button>
                      <button onClick={() => toggleArchive(it)} className="text-gray-500 hover:underline">{it.archived ? 'Вернуть' : 'В архив'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {items.length === 0 && <p className="text-gray-500 text-center mt-10">Номенклатура пуста. Добавьте сырьё, тару, упаковку, этикетки, полуфабрикаты и SKU.</p>}
    </div>
  );
}
