import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useEditorStore, LabelElement, TextElement, BarcodeElement, RectElement } from '../store/useEditorStore';
import { api } from '../api/client';
import { useAuthStore } from '../store/useAuthStore';
import ElementProperties from '../components/ElementProperties';
import LayerList from '../components/LayerList';

const SCALE = 3.7795 * 3;
const SNAP = 0.5;

function snapToGrid(val: number): number {
  return Math.round(val / SNAP) * SNAP;
}

type DrawMode = 'select' | 'text' | 'rect';

// EAN-13 renderer
const EAN13_L: number[][] = [
  [0,0,0,1,1,0,1],[0,0,1,1,0,0,1],[0,0,1,0,0,1,1],[0,1,1,1,1,0,1],
  [0,1,0,0,0,1,1],[0,1,1,0,0,0,1],[0,1,0,1,1,1,1],[0,1,1,1,0,1,1],
  [0,1,1,0,1,1,1],[0,0,0,1,0,1,1],
];
const EAN13_G: number[][] = EAN13_L.map(p => [...p].reverse());
const EAN13_R: number[][] = EAN13_L.map(p => p.map((b: number) => b ^ 1));
const EAN13_PARITY: number[][] = [
  [0,0,0,0,0,0],[0,0,1,0,1,1],[0,0,1,1,0,1],[0,0,1,1,1,0],
  [0,1,0,0,1,1],[0,1,1,0,0,1],[0,1,1,1,0,0],[0,1,0,1,0,1],
  [0,1,0,1,1,0],[0,1,1,0,1,0],
];

function ean13Checksum(d: number[]): number {
  const s = d.reduce((a, v, i) => a + (i % 2 === 0 ? v : v * 3), 0);
  return (10 - (s % 10)) % 10;
}

function drawEan13(canvas: HTMLCanvasElement, value: string) {
  const raw = value.replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  const digits = raw.split('').map(Number);
  const check = ean13Checksum(digits);
  const all = [...digits, check];
  const first = all[0];
  const left = all.slice(1, 7);
  const right = all.slice(7);
  const parity = EAN13_PARITY[first];
  const GUARD_L = [1,0,1];
  const GUARD_M = [0,1,0,1,0];
  const GUARD_R = [1,0,1];
  const bars: number[] = [
    ...GUARD_L,
    ...left.flatMap((d, i) => parity[i] === 0 ? EAN13_L[d] : EAN13_G[d]),
    ...GUARD_M,
    ...right.flatMap(d => EAN13_R[d]),
    ...GUARD_R,
  ];
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const barW = W / bars.length;
  const barH = H * 0.80;
  bars.forEach((b, i) => {
    if (b) {
      ctx.fillStyle = '#000';
      ctx.fillRect(Math.round(i * barW), 0, Math.max(1, Math.round(barW)), barH);
    }
  });
  const fontSize = Math.max(7, H * 0.14);
  ctx.fillStyle = '#000';
  ctx.font = `${fontSize}px monospace`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(String(first), 0, H);
  ctx.textAlign = 'center';
  ctx.fillText(left.join(''), (3 + 6 * 7 / 2) * barW, H);
  ctx.fillText(right.join(''), (3 + 6 * 7 + 5 + 6 * 7 / 2) * barW, H);
}

function BarcodeCanvas({ value, width, height }: { value: string; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.width = Math.round(width);
    ref.current.height = Math.round(height);
    drawEan13(ref.current, value);
  }, [value, width, height]);
  return <canvas ref={ref} style={{ width, height, display: 'block' }} />;
}

export default function Editor() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const store = useEditorStore();
  const token = useAuthStore((s) => s.accessToken);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [czSelected, setCzSelected] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>('select');
  const [editingId, setEditingId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const czDragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const drawing = useRef<{ startXmm: number; startYmm: number; newId: string } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getTemplate(projectId).then((t) => { store.loadTemplate(t); }).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); store.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); store.redo(); }
      if (e.key === 'Escape') {
        setDrawMode('select'); setEditingId(null);
        drawing.current = null; setDrawRect(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId && !editingId) {
        store.deleteElement(store.selectedId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, editingId]);

  function toMm(e: React.MouseEvent): { xMm: number; yMm: number } | null {
    if (!canvasRef.current) return null;
    const r = canvasRef.current.getBoundingClientRect();
    return {
      xMm: snapToGrid(Math.max(0, (e.clientX - r.left) / SCALE)),
      yMm: snapToGrid(Math.max(0, (e.clientY - r.top) / SCALE)),
    };
  }

  function addBarcode() {
    const id = crypto.randomUUID();
    store.addElement({ id, type: 'barcode', xMm: 5, yMm: 5, widthMm: 35, heightMm: 12, value: '460000000000', label: 'Штрихкод' } as any);
    store.selectElement(id);
    setDrawMode('select');
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !projectId) return;
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/projects/${projectId}/template/assets`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const data = await res.json();
    const id = crypto.randomUUID();
    store.addElement({ id, type: 'image', xMm: 5, yMm: 5, widthMm: 20, heightMm: 20, s3Key: data.s3Key, filename: file.name, label: file.name } as any);
    store.selectElement(id);
  }

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    try {
      await api.saveTemplate(projectId, {
        widthMm: store.widthMm, heightMm: store.heightMm,
        elements: store.elements, czArea: store.czArea, barcodeValue: store.barcodeValue || null,
      });
      setSaveMsg('Сохранено');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err: any) {
      setSaveMsg(`Ошибка: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || drawMode === 'select') return;
    const mm = toMm(e);
    if (!mm) return;
    const newId = crypto.randomUUID();
    drawing.current = { startXmm: mm.xMm, startYmm: mm.yMm, newId };
    setDrawRect({ x: mm.xMm * SCALE, y: mm.yMm * SCALE, w: 0, h: 0 });
  }, [drawMode]);

  const onElementMouseDown = useCallback((e: React.MouseEvent, id: string) => {
    if (drawMode !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    setEditingId(null);
    store.selectElement(id);
    const el = store.elements.find((x) => x.id === id);
    if (!el) return;
    dragging.current = { id, startX: e.clientX, startY: e.clientY, origX: el.xMm, origY: el.yMm };
  }, [store, drawMode]);

  const onCzMouseDown = useCallback((e: React.MouseEvent) => {
    if (drawMode !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    store.selectElement(null); setCzSelected(true); setEditingId(null);
    czDragging.current = { startX: e.clientX, startY: e.clientY, origX: store.czArea.xMm, origY: store.czArea.yMm };
  }, [store, drawMode]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (czDragging.current) {
      const dx = (e.clientX - czDragging.current.startX) / SCALE;
      const dy = (e.clientY - czDragging.current.startY) / SCALE;
      store.moveCzArea({ ...store.czArea, xMm: snapToGrid(Math.max(0, czDragging.current.origX + dx)), yMm: snapToGrid(Math.max(0, czDragging.current.origY + dy)) });
      return;
    }
    if (dragging.current) {
      const dx = (e.clientX - dragging.current.startX) / SCALE;
      const dy = (e.clientY - dragging.current.startY) / SCALE;
      store.updateElement(dragging.current.id, { xMm: snapToGrid(Math.max(0, dragging.current.origX + dx)), yMm: snapToGrid(Math.max(0, dragging.current.origY + dy)) } as any);
      return;
    }
    if (drawing.current && canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect();
      const xMm = snapToGrid(Math.max(0, (e.clientX - r.left) / SCALE));
      const yMm = snapToGrid(Math.max(0, (e.clientY - r.top) / SCALE));
      const x = Math.min(drawing.current.startXmm, xMm);
      const y = Math.min(drawing.current.startYmm, yMm);
      setDrawRect({ x: x * SCALE, y: y * SCALE, w: Math.abs(xMm - drawing.current.startXmm) * SCALE, h: Math.abs(yMm - drawing.current.startYmm) * SCALE });
    }
  }, [store]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (czDragging.current) { czDragging.current = null; store.setCzArea(store.czArea); }
    dragging.current = null;
    if (drawing.current && canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect();
      const xMm = snapToGrid(Math.max(0, (e.clientX - r.left) / SCALE));
      const yMm = snapToGrid(Math.max(0, (e.clientY - r.top) / SCALE));
      const x = snapToGrid(Math.min(drawing.current.startXmm, xMm));
      const y = snapToGrid(Math.min(drawing.current.startYmm, yMm));
      const w = snapToGrid(Math.max(3, Math.abs(xMm - drawing.current.startXmm)));
      const h = snapToGrid(Math.max(3, Math.abs(yMm - drawing.current.startYmm)));
      const { newId } = drawing.current;
      if (drawMode === 'text') {
        store.addElement({ id: newId, type: 'text', xMm: x, yMm: y, widthMm: w, heightMm: h, text: '', fontSizePt: 10, bold: false, color: '#000000', label: 'Текст' } as any);
        store.selectElement(newId);
        setEditingId(newId);
      } else if (drawMode === 'rect') {
        store.addElement({ id: newId, type: 'rect', xMm: x, yMm: y, widthMm: w, heightMm: h, strokeColor: '#000000', fillColor: null, strokeWidthPt: 1, label: 'Прямоугольник' });
        store.selectElement(newId);
      }
      drawing.current = null;
      setDrawRect(null);
      setDrawMode('select');
    }
  }, [store, drawMode]);

  const canvasW = store.widthMm * SCALE;
  const canvasH = store.heightMm * SCALE;

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <div className="bg-white border-b px-4 py-2 flex items-center gap-3">
        <button onClick={() => navigate(`/projects/${projectId}`)} className="text-gray-500 hover:text-gray-900 text-sm">
          ← Назад
        </button>
        <span className="text-sm font-medium">Редактор шаблона</span>
        <div className="flex items-center gap-1 ml-2">
          <label className="text-xs text-gray-500">Ш (мм):</label>
          <input type="number" min={10} max={200} step={0.5} value={store.widthMm} onChange={(e) => store.setSize(Number(e.target.value), store.heightMm)} className="w-16 border rounded px-1 py-0.5 text-sm" />
          <label className="text-xs text-gray-500">В (мм):</label>
          <input type="number" min={10} max={200} step={0.5} value={store.heightMm} onChange={(e) => store.setSize(store.widthMm, Number(e.target.value))} className="w-16 border rounded px-1 py-0.5 text-sm" />
        </div>
        <button onClick={store.undo} className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40" disabled={store.past.length === 0}>↩ Отмена</button>
        <button onClick={store.redo} className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40" disabled={store.future.length === 0}>↪ Повтор</button>
        <div className="ml-auto flex items-center gap-2">
          {saveMsg && <span className="text-sm text-green-600">{saveMsg}</span>}
          <button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-sm font-medium">
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-48 bg-white border-r flex flex-col">
          <div className="p-3 border-b">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Инструменты</p>
            <div className="space-y-1">
              <ToolButton onClick={() => { setDrawMode('select'); setDrawRect(null); drawing.current = null; }} label="↖ Выбор" active={drawMode === 'select'} />
              <ToolButton onClick={() => { setDrawMode('text'); store.selectElement(null); setEditingId(null); }} label="T Текст" active={drawMode === 'text'} hint="Нарисуйте зону на канвасе" />
              <ToolButton onClick={addBarcode} label="| Штрихкод" />
              <ToolButton onClick={() => { setDrawMode('rect'); store.selectElement(null); setEditingId(null); }} label="□ Прямоугольник" active={drawMode === 'rect'} />
              <label className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
                Изображение
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageUpload} />
              </label>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Слои</p>
            <LayerList />
          </div>
        </div>

        <div
          className="flex-1 overflow-auto flex items-center justify-center bg-gray-200 p-8 relative"
          style={{ cursor: drawMode !== 'select' ? 'crosshair' : 'default' }}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onClick={() => {
            if (drawMode === 'select') { store.selectElement(null); setCzSelected(false); setEditingId(null); }
          }}
        >
          {drawMode !== 'select' && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-50 border border-amber-300 text-amber-700 text-xs px-3 py-1 rounded shadow z-50 pointer-events-none">
              {drawMode === 'text' ? 'Нарисуйте зону для текста' : 'Нарисуйте прямоугольник'} — Esc для отмены
            </div>
          )}
          <div
            ref={canvasRef}
            style={{ width: canvasW, height: canvasH, position: 'relative' }}
            className="bg-white shadow-xl border border-gray-300"
            onMouseDown={onCanvasMouseDown}
          >
            <div
              style={{
                position: 'absolute',
                left: store.czArea.xMm * SCALE, top: store.czArea.yMm * SCALE,
                width: store.czArea.widthMm * SCALE, height: store.czArea.heightMm * SCALE,
                border: czSelected ? '2px solid #f97316' : '2px dashed #f97316',
                boxSizing: 'border-box',
                cursor: drawMode === 'select' ? 'move' : 'crosshair',
                zIndex: 10, userSelect: 'none',
                boxShadow: czSelected ? '0 0 0 1px #f97316' : undefined,
              }}
              onMouseDown={onCzMouseDown}
            >
              <span style={{ fontSize: 10, color: '#f97316', padding: '1px 3px', pointerEvents: 'none' }}>ЧЗ</span>
            </div>

            {store.elements.map((el) => (
              <CanvasElement
                key={el.id} el={el}
                selected={store.selectedId === el.id}
                editing={editingId === el.id}
                onMouseDown={onElementMouseDown}
                onDoubleClick={(id) => { if (drawMode === 'select') { store.selectElement(id); setEditingId(id); } }}
                onTextChange={(id, text) => store.updateElement(id, { text } as any)}
                onEditDone={() => setEditingId(null)}
              />
            ))}

            {drawRect && (
              <div style={{
                position: 'absolute', left: drawRect.x, top: drawRect.y,
                width: drawRect.w, height: drawRect.h,
                border: '1.5px dashed #3b82f6', background: 'rgba(59,130,246,0.06)',
                pointerEvents: 'none', boxSizing: 'border-box',
              }} />
            )}
          </div>
        </div>

        <div className="w-64 bg-white border-l overflow-y-auto p-4">
          <ElementProperties />
        </div>
      </div>
    </div>
  );
}

function ToolButton({ onClick, label, active, hint }: { onClick: () => void; label: string; active?: boolean; hint?: string }) {
  return (
    <button onClick={onClick} title={hint} className={`w-full text-left text-sm px-2 py-1 rounded ${active ? 'bg-blue-100 text-blue-700 font-medium' : 'hover:bg-gray-100'}`}>
      {label}
    </button>
  );
}

interface CanvasElementProps {
  el: LabelElement;
  selected: boolean;
  editing: boolean;
  onMouseDown: (e: React.MouseEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onTextChange: (id: string, text: string) => void;
  onEditDone: () => void;
}

function CanvasElement({ el, selected, editing, onMouseDown, onDoubleClick, onTextChange, onEditDone }: CanvasElementProps) {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: el.xMm * SCALE,
    top: el.yMm * SCALE,
    cursor: 'move',
    outline: selected ? '2px solid #3b82f6' : undefined,
    userSelect: 'none',
    boxSizing: 'border-box',
  };

  if (el.type === 'rect') {
    const r = el as RectElement;
    return (
      <div
        style={{ ...base, width: r.widthMm * SCALE, height: r.heightMm * SCALE, border: `${r.strokeWidthPt}px solid ${r.strokeColor}`, background: r.fillColor ?? 'transparent' }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
        onDoubleClick={() => onDoubleClick(el.id)}
      />
    );
  }

  if (el.type === 'text') {
    const t = el as TextElement & { widthMm?: number; heightMm?: number };
    const w = t.widthMm ? t.widthMm * SCALE : undefined;
    const h = t.heightMm ? t.heightMm * SCALE : undefined;
    const textStyle: React.CSSProperties = {
      fontSize: t.fontSizePt * (SCALE / 3),
      fontWeight: t.bold ? 'bold' : 'normal',
      color: t.color,
      lineHeight: 1.3,
      padding: 2,
    };
    if (editing) {
      return (
        <div style={{ ...base, width: w, height: h, outline: '2px solid #3b82f6', cursor: 'default' }} onMouseDown={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            value={t.text}
            onChange={(e) => onTextChange(t.id, e.target.value)}
            onBlur={onEditDone}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onEditDone(); } }}
            style={{ ...textStyle, width: '100%', height: '100%', minHeight: h ?? 24, border: 'none', outline: 'none', resize: 'none', background: 'rgba(255,255,255,0.92)' }}
          />
        </div>
      );
    }
    return (
      <div
        style={{ ...base, ...textStyle, width: w, height: h, overflow: 'hidden', whiteSpace: w ? 'pre-wrap' : 'nowrap' }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
        onDoubleClick={() => onDoubleClick(el.id)}
      >
        {t.text || <span style={{ color: '#bbb', fontStyle: 'italic' }}>Текст...</span>}
      </div>
    );
  }

  if (el.type === 'barcode') {
    const b = el as BarcodeElement;
    return (
      <div style={{ ...base, width: b.widthMm * SCALE, height: b.heightMm * SCALE }}
        onMouseDown={(e) => onMouseDown(e, el.id)} onDoubleClick={() => onDoubleClick(el.id)}>
        <BarcodeCanvas value={b.value} width={b.widthMm * SCALE} height={b.heightMm * SCALE} />
      </div>
    );
  }

  if (el.type === 'image') {
    const img = el as any;
    return (
      <div
        style={{ ...base, width: img.widthMm * SCALE, height: img.heightMm * SCALE, background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onMouseDown={(e) => onMouseDown(e, el.id)} onDoubleClick={() => onDoubleClick(el.id)}
      >
        <span style={{ fontSize: 9, color: '#6b7280' }}>Изображение</span>
      </div>
    );
  }

  return null;
}
