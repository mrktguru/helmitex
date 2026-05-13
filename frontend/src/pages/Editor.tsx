import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useEditorStore, LabelElement, TextElement, BarcodeElement, RectElement } from '../store/useEditorStore';
import { api } from '../api/client';
import { useAuthStore } from '../store/useAuthStore';
import ElementProperties from '../components/ElementProperties';
import LayerList from '../components/LayerList';

// Scale factor: 1mm = 3.7795px * 3 ≈ 11.3386px on screen
const SCALE = 3.7795 * 3;
const SNAP = 0.5; // mm grid

function snapToGrid(val: number): number {
  return Math.round(val / SNAP) * SNAP;
}

export default function Editor() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const store = useEditorStore();
  const token = useAuthStore((s) => s.accessToken);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [czSelected, setCzSelected] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Drag state
  const dragging = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const czDragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getTemplate(projectId).then((t) => {
      store.loadTemplate(t);
    }).catch(() => { /* no template yet */ });
  }, [projectId]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); store.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); store.redo(); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selectedId) store.deleteElement(store.selectedId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  function addText() {
    store.addElement({
      id: crypto.randomUUID(), type: 'text',
      xMm: 5, yMm: 5, text: 'Текст', fontSizePt: 10, bold: false, color: '#000000',
    });
  }

  function addBarcode() {
    store.addElement({
      id: crypto.randomUUID(), type: 'barcode',
      xMm: 5, yMm: 5, widthMm: 30, heightMm: 10, value: '000000000000',
    });
  }

  function addRect() {
    store.addElement({
      id: crypto.randomUUID(), type: 'rect',
      xMm: 5, yMm: 5, widthMm: 20, heightMm: 10,
      strokeColor: '#000000', fillColor: null, strokeWidthPt: 1,
    });
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !projectId) return;
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/projects/${projectId}/template/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json();
    store.addElement({
      id: crypto.randomUUID(), type: 'image',
      xMm: 5, yMm: 5, widthMm: 20, heightMm: 20,
      s3Key: data.s3Key, filename: file.name,
    });
  }

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    try {
      await api.saveTemplate(projectId, {
        widthMm: store.widthMm,
        heightMm: store.heightMm,
        elements: store.elements,
        czArea: store.czArea,
        barcodeValue: store.barcodeValue || null,
      });
      setSaveMsg('Сохранено');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err: any) {
      setSaveMsg(`Ошибка: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Mouse drag handlers
  const onMouseDown = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    store.selectElement(id);
    const el = store.elements.find((x) => x.id === id);
    if (!el) return;
    dragging.current = { id, startX: e.clientX, startY: e.clientY, origX: el.xMm, origY: el.yMm };
  }, [store]);

  const onCzMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    store.selectElement(null);
    setCzSelected(true);
    czDragging.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: store.czArea.xMm,
      origY: store.czArea.yMm,
    };
  }, [store]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (czDragging.current) {
      const dx = (e.clientX - czDragging.current.startX) / SCALE;
      const dy = (e.clientY - czDragging.current.startY) / SCALE;
      store.moveCzArea({
        ...store.czArea,
        xMm: snapToGrid(Math.max(0, czDragging.current.origX + dx)),
        yMm: snapToGrid(Math.max(0, czDragging.current.origY + dy)),
      });
      return;
    }
    if (!dragging.current) return;
    const dx = (e.clientX - dragging.current.startX) / SCALE;
    const dy = (e.clientY - dragging.current.startY) / SCALE;
    store.updateElement(dragging.current.id, {
      xMm: snapToGrid(Math.max(0, dragging.current.origX + dx)),
      yMm: snapToGrid(Math.max(0, dragging.current.origY + dy)),
    } as any);
  }, [store]);

  const onMouseUp = useCallback(() => {
    if (czDragging.current) {
      czDragging.current = null;
      store.setCzArea(store.czArea); // commit to history
    }
    dragging.current = null;
  }, [store]);

  const canvasW = store.widthMm * SCALE;
  const canvasH = store.heightMm * SCALE;

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Top toolbar */}
      <div className="bg-white border-b px-4 py-2 flex items-center gap-3">
        <button onClick={() => navigate(`/projects/${projectId}`)} className="text-gray-500 hover:text-gray-900 text-sm">
          ← Назад
        </button>
        <span className="text-sm font-medium">Редактор шаблона</span>
        <div className="flex items-center gap-1 ml-2">
          <label className="text-xs text-gray-500">Ш (мм):</label>
          <input
            type="number" min={10} max={200} step={0.5}
            value={store.widthMm}
            onChange={(e) => store.setSize(Number(e.target.value), store.heightMm)}
            className="w-16 border rounded px-1 py-0.5 text-sm"
          />
          <label className="text-xs text-gray-500">В (мм):</label>
          <input
            type="number" min={10} max={200} step={0.5}
            value={store.heightMm}
            onChange={(e) => store.setSize(store.widthMm, Number(e.target.value))}
            className="w-16 border rounded px-1 py-0.5 text-sm"
          />
        </div>
        <button onClick={store.undo} title="Отменить (Ctrl+Z)" className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40" disabled={store.past.length === 0}>↩ Отмена</button>
        <button onClick={store.redo} title="Повторить (Ctrl+Y)" className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40" disabled={store.future.length === 0}>↪ Повтор</button>
        <div className="ml-auto flex items-center gap-2">
          {saveMsg && <span className="text-sm text-green-600">{saveMsg}</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-sm font-medium"
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <div className="w-48 bg-white border-r flex flex-col">
          <div className="p-3 border-b">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Добавить</p>
            <div className="space-y-1">
              <ToolButton onClick={addText} label="Текст (T)" />
              <ToolButton onClick={addBarcode} label="Штрихкод" />
              <ToolButton onClick={addRect} label="Прямоугольник" />
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

        {/* Canvas area */}
        <div
          className="flex-1 overflow-auto flex items-center justify-center bg-gray-200 p-8"
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onClick={() => { store.selectElement(null); setCzSelected(false); }}
        >
          <div
            ref={canvasRef}
            style={{ width: canvasW, height: canvasH, position: 'relative' }}
            className="bg-white shadow-xl border border-gray-300"
          >
            {/* CZ area — draggable, orange dashed */}
            <div
              style={{
                position: 'absolute',
                left: store.czArea.xMm * SCALE,
                top: store.czArea.yMm * SCALE,
                width: store.czArea.widthMm * SCALE,
                height: store.czArea.heightMm * SCALE,
                border: czSelected ? '2px solid #f97316' : '2px dashed #f97316',
                boxSizing: 'border-box',
                cursor: 'move',
                zIndex: 10,
                userSelect: 'none',
                boxShadow: czSelected ? '0 0 0 1px #f97316' : undefined,
              }}
              onMouseDown={onCzMouseDown}
            >
              <span style={{ fontSize: 10, color: '#f97316', padding: '1px 3px', pointerEvents: 'none' }}>ЧЗ</span>
            </div>

            {/* Elements */}
            {store.elements.map((el) => (
              <CanvasElement
                key={el.id}
                el={el}
                selected={store.selectedId === el.id}
                onMouseDown={onMouseDown}
              />
            ))}
          </div>
        </div>

        {/* Right sidebar */}
        <div className="w-64 bg-white border-l overflow-y-auto p-4">
          <ElementProperties />
        </div>
      </div>
    </div>
  );
}

function ToolButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left text-sm px-2 py-1 rounded hover:bg-gray-100"
    >
      {label}
    </button>
  );
}

interface CanvasElementProps {
  el: LabelElement;
  selected: boolean;
  onMouseDown: (e: React.MouseEvent, id: string) => void;
}

function CanvasElement({ el, selected, onMouseDown }: CanvasElementProps) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: el.xMm * SCALE,
    top: el.yMm * SCALE,
    cursor: 'move',
    outline: selected ? '2px solid #3b82f6' : undefined,
    userSelect: 'none',
  };

  if (el.type === 'rect') {
    const r = el as RectElement;
    return (
      <div
        style={{
          ...style,
          width: r.widthMm * SCALE,
          height: r.heightMm * SCALE,
          border: `${r.strokeWidthPt}px solid ${r.strokeColor}`,
          background: r.fillColor ?? 'transparent',
          boxSizing: 'border-box',
        }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
      />
    );
  }

  if (el.type === 'text') {
    const t = el as TextElement;
    return (
      <div
        style={{
          ...style,
          fontSize: t.fontSizePt * (SCALE / 3),
          fontWeight: t.bold ? 'bold' : 'normal',
          color: t.color,
          whiteSpace: 'nowrap',
        }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
      >
        {t.text}
      </div>
    );
  }

  if (el.type === 'barcode') {
    const b = el as BarcodeElement;
    return (
      <div
        style={{ ...style, width: b.widthMm * SCALE, height: b.heightMm * SCALE, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
      >
        <span style={{ fontSize: 9, color: '#6b7280' }}>EAN-13: {b.value}</span>
      </div>
    );
  }

  if (el.type === 'image') {
    return (
      <div
        style={{ ...style, width: (el as any).widthMm * SCALE, height: (el as any).heightMm * SCALE, background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
      >
        <span style={{ fontSize: 9, color: '#6b7280' }}>Изображение</span>
      </div>
    );
  }

  return null;
}
