import { useState } from 'react';
import { fmt, parseNum } from './util';

// Число, которое правится по клику: Enter/✓ — сохранить, Esc/✕ — отмена
export default function InlineNumber({ value, suffix, onSave, label, digits = 2 }: { value: number | null; suffix: string; onSave: (v: number) => Promise<void>; label: string; digits?: number }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    const v = parseNum(edit ?? '');
    if (v == null || v <= 0) { setErr('Введите число больше 0'); return; }
    setBusy(true); setErr('');
    try { await onSave(v); setEdit(null); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  if (edit == null) {
    return (
      <button onClick={() => setEdit(value != null ? String(value).replace('.', ',') : '')} title={`Изменить: ${label}`}
        className="tabular-nums text-sm px-2 py-1 rounded-md border border-dashed border-slate-300 hover:border-brand-500 hover:text-brand-700 whitespace-nowrap">
        {value != null ? `${fmt(value, digits)} ${suffix}` : `— ${suffix}`}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-1">
        <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={label} inputMode="decimal"
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null); }}
          className="w-20 border rounded-md px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <button disabled={busy} onClick={save} className="w-8 h-8 rounded-md bg-brand-600 text-white text-sm disabled:opacity-50" aria-label="Сохранить">✓</button>
        <button onClick={() => { setEdit(null); setErr(''); }} className="w-8 h-8 rounded-md border border-slate-300 text-slate-500 text-sm" aria-label="Отмена">✕</button>
      </span>
      {err && <span className="text-xs text-red-600 max-w-[220px] whitespace-normal">{err}</span>}
    </span>
  );
}

