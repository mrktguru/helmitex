import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useEditorStore, LabelElement, TextElement, BarcodeElement, RectElement, EacElement } from '../store/useEditorStore';
import { api } from '../api/client';
import { useAuthStore } from '../store/useAuthStore';
import ElementProperties from '../components/ElementProperties';
import LayerList from '../components/LayerList';
import { genId } from '../lib/uuid';

const SCALE = 3.7795 * 3;
const SNAP = 0.5;

function snapToGrid(val: number): number {
  return Math.round(val / SNAP) * SNAP;
}

const LABEL_FONT = "'PT Sans', sans-serif";

// Canvas context for measuring text — created once, reused
let _mctx: CanvasRenderingContext2D | null = null;

/** Browser-side word wrap — returns lines exactly as the browser renders them. */
function browserWrapText(text: string, bold: boolean, fontSizePx: number, blockWidthPx: number): string[] {
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d')!;
  _mctx.font = `${bold ? 'bold ' : ''}${fontSizePx}px ${LABEL_FONT}`;
  const paragraphs = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result: string[] = [];
  for (const para of paragraphs) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(' ');
    let cur = '';
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (_mctx.measureText(candidate).width <= blockWidthPx - 2) {
        cur = candidate;
      } else {
        if (cur) result.push(cur);
        cur = word;
      }
    }
    if (cur) result.push(cur);
  }
  return result.length > 0 ? result : [text];
}

function getFitFontSizePx(text: string, bold: boolean, widthPx: number, heightPx: number): number {
  if (!text.trim()) return 12;
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d')!;
  const lines = text.split('\n');
  let lo = 1, hi = 600;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    _mctx.font = `${bold ? 'bold ' : ''}${mid}px ${LABEL_FONT}`;
    const maxW = Math.max(...lines.map((l) => _mctx!.measureText(l || ' ').width));
    const totalH = lines.length * mid * 1.3;
    if (maxW <= widthPx - 4 && totalH <= heightPx - 4) lo = mid;
    else hi = mid;
  }
  return Math.max(4, lo);
}

type DrawMode = 'select' | 'text' | 'rect';
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// ─── EAN-13 SVG renderer ──────────────────────────────────────────────────────
const EAN13_L = [[0,0,0,1,1,0,1],[0,0,1,1,0,0,1],[0,0,1,0,0,1,1],[0,1,1,1,1,0,1],[0,1,0,0,0,1,1],[0,1,1,0,0,0,1],[0,1,0,1,1,1,1],[0,1,1,1,0,1,1],[0,1,1,0,1,1,1],[0,0,0,1,0,1,1]];
const EAN13_G = EAN13_L.map(p => [...p].reverse());
const EAN13_R = EAN13_L.map(p => p.map((b: number) => b ^ 1));
const EAN13_PARITY = [[0,0,0,0,0,0],[0,0,1,0,1,1],[0,0,1,1,0,1],[0,0,1,1,1,0],[0,1,0,0,1,1],[0,1,1,0,0,1],[0,1,1,1,0,0],[0,1,0,1,0,1],[0,1,0,1,1,0],[0,1,1,0,1,0]];

function normalizeEan13(value: string): string {
  let digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 0) digits = '0';
  digits = digits.slice(0, 13).padStart(13, '0');
  const head = digits.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(head[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return head + check;
}

// SVG viewBox: 113 module units wide (11 left quiet + 95 bars + 7 right quiet), 50 tall.
// Normal bars: y=0..42, guard bars: y=0..44, text: y=44..50.
// preserveAspectRatio="none" fills the exact element bounds — crisp at any zoom level.
function BarcodeSvg({ value, width, height }: { value: string; width: number; height: number }) {
  const ean = normalizeEan13(value);
  const d = ean.split('').map(Number);
  const first = d[0];
  const leftD = d.slice(1, 7);
  const rightD = d.slice(7);
  const par = EAN13_PARITY[first];

  type Bar = { x: number; h: number };
  const bars: Bar[] = [];
  const addBits = (bits: number[], offset: number, isGuard: boolean) =>
    bits.forEach((b, i) => { if (b) bars.push({ x: offset + i, h: isGuard ? 44 : 42 }); });

  addBits([1,0,1], 0, true);
  leftD.forEach((digit, i) => addBits(par[i] === 0 ? EAN13_L[digit] : EAN13_G[digit], 3 + i * 7, false));
  addBits([0,1,0,1,0], 45, true);
  rightD.forEach((digit, i) => addBits(EAN13_R[digit], 50 + i * 7, false));
  addBits([1,0,1], 92, true);

  const LQUIET = 11;
  const FS = 5.2; // font size in module units
  const TY = 49;  // text baseline y

  return (
    <svg viewBox="0 0 113 50" width={width} height={height}
      style={{ display: 'block' }} preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect width="113" height="50" fill="white" />
      {bars.map((b, i) => (
        <rect key={i} x={LQUIET + b.x} y={0} width={1} height={b.h} fill="black" />
      ))}
      {/* First digit: centred in left quiet zone */}
      <text x={5.5} y={TY} fontSize={FS} textAnchor="middle" fontFamily="monospace" fill="black">{first}</text>
      {/* Left 6 digits */}
      {leftD.map((digit, i) => (
        <text key={`l${i}`} x={LQUIET + 3 + i * 7 + 3.5} y={TY} fontSize={FS} textAnchor="middle" fontFamily="monospace" fill="black">{digit}</text>
      ))}
      {/* Right 6 digits */}
      {rightD.map((digit, i) => (
        <text key={`r${i}`} x={LQUIET + 50 + i * 7 + 3.5} y={TY} fontSize={FS} textAnchor="middle" fontFamily="monospace" fill="black">{digit}</text>
      ))}
    </svg>
  );
}

// ─── EAC mark ────────────────────────────────────────────────────────────────
// Официальный SVG-файл: /eac-icon.svg (в public/).
// Для изменения цвета используем CSS filter через hue-rotate + invert.
// Для белого знака на тёмном фоне пользователь может применить инверсию.
function EacSvg({ width, height, color }: { width: number; height: number; color: string }) {
  // Default is black (#000). For any other color we tint via SVG inline with replaced fill.
  // Simple approach: use the img as-is for black, or render inline with fill replaced.
  const isBlack = color === '#000000' || color === '#000';
  const style: React.CSSProperties = { display: 'block', width, height };
  if (!isBlack) {
    // CSS trick: invert makes black→white, then sepia+saturate+hue-rotate to approximate color.
    // For production-quality tinting we do inline SVG with replaced fill.
    style.filter = colorToFilter(color);
  }
  return <img src="/eac-icon.svg" style={style} draggable={false} />;
}

// Converts a hex color to a CSS filter approximation (works well for solid-color icons).
// For exact match we'd need a solver; this gives a good visual result for common colors.
function colorToFilter(hex: string): string {
  if (hex === '#000000' || hex === '#000') return 'none';
  if (hex === '#ffffff' || hex === '#fff') return 'invert(1)';
  // Generic: invert + sepia chain. For most brand colors this is close enough.
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  // Brightness relative to white — use as invert fraction
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const hue = Math.round(Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI);
  return `invert(${Math.round((1 - brightness) * 100)}%) sepia(100%) saturate(10) hue-rotate(${hue}deg)`;
}

export default function Editor() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const store = useEditorStore();
  const token = useAuthStore((s) => s.accessToken);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [czSelected, setCzSelected] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>('select');
  const [editingId, setEditingId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const czDragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const drawing = useRef<{ startXmm: number; startYmm: number; newId: string } | null>(null);
  const resizing = useRef<{ id: string; handle: ResizeHandle; startX: number; startY: number; origEl: LabelElement } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getTemplate(projectId)
      .then((t) => { store.loadTemplate(t); setTimeout(() => setHasLoaded(true), 50); })
      .catch(() => setHasLoaded(true));
  }, [projectId]);

  // Auto-save: debounce 1 s after any content change
  useEffect(() => {
    if (!hasLoaded || !projectId) return;
    setSaveStatus('pending');
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        // Pre-compute wrapped lines for each text element using browser canvas metrics
        // so the PDF generator can reproduce the exact same layout without re-measuring.
        const elementsWithWraps = store.elements.map((el) => {
          if (el.type !== 'text') return el;
          const t = el as import('../store/useEditorStore').TextElement & { widthMm?: number; heightMm?: number };
          const blockW = t.widthMm ? t.widthMm * SCALE : 0;
          if (!blockW || !t.text) return { ...t, _wrappedLines: [t.text] };
          const fontSizePx = t.fitToBlock && t.heightMm
            ? getFitFontSizePx(t.text, t.bold, blockW, t.heightMm * SCALE)
            : t.fontSizePt * (SCALE / 3);
          const wrapped = browserWrapText(t.text, t.bold, fontSizePx, blockW);
          // Convert browser fontSizePx back to PDF pt, accounting for 3x canvas zoom.
          // SCALE = px/mm at current zoom; 72pt = 25.4mm → pt = px * 72 / (SCALE * 25.4)
          const resolvedFontSizePt = fontSizePx * 72 / (SCALE * 25.4);
          return { ...t, _wrappedLines: wrapped, _resolvedFontSizePt: resolvedFontSizePt };
        });
        await api.saveTemplate(projectId, {
          widthMm: store.widthMm, heightMm: store.heightMm,
          elements: elementsWithWraps, czArea: store.czArea,
          barcodeValue: store.barcodeValue || null, printMargins: store.printMargins,
        });
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (err: any) {
        setSaveStatus('error'); setSaveError(err.message ?? 'Ошибка');
      }
    }, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.elements, store.czArea, store.widthMm, store.heightMm, store.printMargins, store.barcodeValue, hasLoaded]);

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
    const id = genId();
    store.addElement({ id, type: 'barcode', xMm: 5, yMm: 5, widthMm: 35, heightMm: 12, value: '4600000000006', label: 'Штрихкод' } as any);
    store.selectElement(id);
    setDrawMode('select');
  }

  function addEac() {
    const id = genId();
    store.addElement({ id, type: 'eac', xMm: 5, yMm: 5, widthMm: 15, heightMm: 9, color: '#000000', label: 'Знак ЕАС' } as EacElement);
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
    const id = genId();
    store.addElement({ id, type: 'image', xMm: 5, yMm: 5, widthMm: 20, heightMm: 20, s3Key: data.s3Key, filename: file.name, label: file.name } as any);
    store.selectElement(id);
  }

  async function handleSaveNow() {
    if (!projectId) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    setSaveStatus('saving');
    try {
      await api.saveTemplate(projectId, {
        widthMm: store.widthMm, heightMm: store.heightMm,
        elements: store.elements, czArea: store.czArea, barcodeValue: store.barcodeValue || null,
        printMargins: store.printMargins,
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err: any) {
      setSaveStatus('error'); setSaveError(err.message ?? 'Ошибка');
    }
  }

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || drawMode === 'select') return;
    const mm = toMm(e);
    if (!mm) return;
    const newId = genId();
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

  const onResizeStart = useCallback((e: React.MouseEvent, id: string, handle: ResizeHandle) => {
    if (e.button !== 0) return;
    const el = store.elements.find((x) => x.id === id);
    if (!el) return;
    store.pushHistory();
    resizing.current = { id, handle, startX: e.clientX, startY: e.clientY, origEl: { ...el } };
  }, [store]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (resizing.current) {
      const { id, handle, startX, startY, origEl } = resizing.current;
      const dx = (e.clientX - startX) / SCALE;
      const dy = (e.clientY - startY) / SCALE;
      const orig = origEl as any;
      const origW = orig.widthMm ?? 20;
      const origH = orig.heightMm ?? 10;
      let newX = orig.xMm, newY = orig.yMm, newW = origW, newH = origH;
      if (handle === 'se') {
        newW = snapToGrid(Math.max(3, origW + dx)); newH = snapToGrid(Math.max(3, origH + dy));
      } else if (handle === 'sw') {
        newW = snapToGrid(Math.max(3, origW - dx)); newX = snapToGrid(orig.xMm + origW - newW);
        newH = snapToGrid(Math.max(3, origH + dy));
      } else if (handle === 'ne') {
        newW = snapToGrid(Math.max(3, origW + dx));
        newH = snapToGrid(Math.max(3, origH - dy)); newY = snapToGrid(orig.yMm + origH - newH);
      } else if (handle === 'nw') {
        newW = snapToGrid(Math.max(3, origW - dx)); newX = snapToGrid(orig.xMm + origW - newW);
        newH = snapToGrid(Math.max(3, origH - dy)); newY = snapToGrid(orig.yMm + origH - newH);
      } else if (handle === 'e') {
        newW = snapToGrid(Math.max(3, origW + dx));
      } else if (handle === 'w') {
        newW = snapToGrid(Math.max(3, origW - dx)); newX = snapToGrid(orig.xMm + origW - newW);
      } else if (handle === 's') {
        newH = snapToGrid(Math.max(3, origH + dy));
      } else if (handle === 'n') {
        newH = snapToGrid(Math.max(3, origH - dy)); newY = snapToGrid(orig.yMm + origH - newH);
      }
      store.updateElement(id, { xMm: newX, yMm: newY, widthMm: newW, heightMm: newH } as any);
      return;
    }
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
    if (resizing.current) { resizing.current = null; return; }
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
        <div className="flex items-center gap-1 ml-2 border-l pl-2">
          <span className="text-xs text-gray-500">Поля:</span>
          {([['topMm', 'Верх'], ['rightMm', 'Право'], ['bottomMm', 'Низ'], ['leftMm', 'Лево']] as const).map(([key, label]) => (
            <input key={key} type="number" min={0} max={50} step={0.5}
              value={store.printMargins[key]}
              onChange={(e) => store.setPrintMargins({ ...store.printMargins, [key]: Number(e.target.value) })}
              className="w-12 border rounded px-1 py-0.5 text-xs"
              title={`${label} (мм)`}
            />
          ))}
        </div>
        <button onClick={store.undo} className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40" disabled={store.past.length === 0}>↩ Отмена</button>
        <button onClick={store.redo} className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40" disabled={store.future.length === 0}>↪ Повтор</button>
        <div className="ml-auto flex items-center gap-2">
          {saveStatus === 'pending' && <span className="text-xs text-gray-400">Изменено...</span>}
          {saveStatus === 'saving' && <span className="text-xs text-blue-500">Сохранение...</span>}
          {saveStatus === 'saved' && <span className="text-xs text-green-600">✓ Сохранено</span>}
          {saveStatus === 'error' && <span className="text-xs text-red-500" title={saveError}>⚠ Ошибка сохранения</span>}
          <button onClick={handleSaveNow} disabled={saveStatus === 'saving'} className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50 disabled:opacity-40">
            Сохранить сейчас
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
              <ToolButton onClick={addEac} label="✓ Знак ЕАС" />
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
            onClick={(e) => {
              e.stopPropagation();
              if (e.target === canvasRef.current && drawMode === 'select') {
                store.selectElement(null); setCzSelected(false); setEditingId(null);
              }
            }}
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
              onClick={(e) => e.stopPropagation()}
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
                onResizeStart={onResizeStart}
              />
            ))}

            {/* Print margin guides */}
            {store.printMargins.topMm > 0 && <div style={{ position: 'absolute', left: 0, right: 0, top: store.printMargins.topMm * SCALE, borderTop: '1px dashed #94a3b8', pointerEvents: 'none', zIndex: 5 }} />}
            {store.printMargins.bottomMm > 0 && <div style={{ position: 'absolute', left: 0, right: 0, top: (store.heightMm - store.printMargins.bottomMm) * SCALE, borderTop: '1px dashed #94a3b8', pointerEvents: 'none', zIndex: 5 }} />}
            {store.printMargins.leftMm > 0 && <div style={{ position: 'absolute', top: 0, bottom: 0, left: store.printMargins.leftMm * SCALE, borderLeft: '1px dashed #94a3b8', pointerEvents: 'none', zIndex: 5 }} />}
            {store.printMargins.rightMm > 0 && <div style={{ position: 'absolute', top: 0, bottom: 0, left: (store.widthMm - store.printMargins.rightMm) * SCALE, borderLeft: '1px dashed #94a3b8', pointerEvents: 'none', zIndex: 5 }} />}

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

function ResizeHandles({ id, onResizeStart }: {
  id: string;
  onResizeStart: (e: React.MouseEvent, id: string, handle: ResizeHandle) => void;
}) {
  const handles: { h: ResizeHandle; style: React.CSSProperties }[] = [
    { h: 'nw', style: { top: -4, left: -4, cursor: 'nw-resize' } },
    { h: 'n',  style: { top: -4, left: '50%', transform: 'translateX(-50%)', cursor: 'n-resize' } },
    { h: 'ne', style: { top: -4, right: -4, cursor: 'ne-resize' } },
    { h: 'e',  style: { top: '50%', right: -4, transform: 'translateY(-50%)', cursor: 'e-resize' } },
    { h: 'se', style: { bottom: -4, right: -4, cursor: 'se-resize' } },
    { h: 's',  style: { bottom: -4, left: '50%', transform: 'translateX(-50%)', cursor: 's-resize' } },
    { h: 'sw', style: { bottom: -4, left: -4, cursor: 'sw-resize' } },
    { h: 'w',  style: { top: '50%', left: -4, transform: 'translateY(-50%)', cursor: 'w-resize' } },
  ];
  return (
    <>
      {handles.map(({ h, style }) => (
        <div
          key={h}
          onMouseDown={(e) => { e.stopPropagation(); onResizeStart(e, id, h); }}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            width: 8, height: 8,
            background: '#fff',
            border: '1.5px solid #3b82f6',
            borderRadius: 1,
            boxSizing: 'border-box',
            zIndex: 100,
            ...style,
          }}
        />
      ))}
    </>
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
  onResizeStart: (e: React.MouseEvent, id: string, handle: ResizeHandle) => void;
}

function CanvasElement({ el, selected, editing, onMouseDown, onDoubleClick, onTextChange, onEditDone, onResizeStart }: CanvasElementProps) {
  const canResize = (el as any).widthMm != null && (el as any).heightMm != null;
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
        onClick={(e) => e.stopPropagation()}
      >
        {selected && canResize && <ResizeHandles id={el.id} onResizeStart={onResizeStart} />}
      </div>
    );
  }

  if (el.type === 'text') {
    const t = el as TextElement & { widthMm?: number; heightMm?: number };
    const w = t.widthMm ? t.widthMm * SCALE : undefined;
    const h = t.heightMm ? t.heightMm * SCALE : undefined;
    const fontSizePx = (t.fitToBlock && w && h)
      ? getFitFontSizePx(t.text || ' ', t.bold, w, h)
      : t.fontSizePt * (SCALE / 3);
    const textStyle: React.CSSProperties = {
      fontFamily: LABEL_FONT,
      fontSize: fontSizePx,
      fontWeight: t.bold ? 'bold' : 'normal',
      color: t.color,
      lineHeight: 1.3,
      textAlign: (t.align ?? 'left') as React.CSSProperties['textAlign'],
      padding: 2,
    };
    if (editing) {
      return (
        <div style={{ ...base, width: w, height: h, outline: '2px solid #3b82f6', cursor: 'default' }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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
        style={{ ...base, ...textStyle, width: w, height: h, overflow: 'hidden', whiteSpace: 'pre-wrap' }}
        onMouseDown={(e) => onMouseDown(e, el.id)}
        onDoubleClick={() => onDoubleClick(el.id)}
        onClick={(e) => e.stopPropagation()}
      >
        {t.text || <span style={{ color: '#bbb', fontStyle: 'italic' }}>Текст...</span>}
        {selected && canResize && !editing && <ResizeHandles id={el.id} onResizeStart={onResizeStart} />}
      </div>
    );
  }

  if (el.type === 'barcode') {
    const b = el as BarcodeElement;
    return (
      <div style={{ ...base, width: b.widthMm * SCALE, height: b.heightMm * SCALE }}
        onMouseDown={(e) => onMouseDown(e, el.id)} onDoubleClick={() => onDoubleClick(el.id)}
        onClick={(e) => e.stopPropagation()}
      >
        <BarcodeSvg value={b.value} width={b.widthMm * SCALE} height={b.heightMm * SCALE} />
        {selected && canResize && <ResizeHandles id={el.id} onResizeStart={onResizeStart} />}
      </div>
    );
  }

  if (el.type === 'image') {
    const img = el as any;
    return (
      <div
        style={{ ...base, width: img.widthMm * SCALE, height: img.heightMm * SCALE, background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onMouseDown={(e) => onMouseDown(e, el.id)} onDoubleClick={() => onDoubleClick(el.id)}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ fontSize: 9, color: '#6b7280' }}>Изображение</span>
        {selected && canResize && <ResizeHandles id={el.id} onResizeStart={onResizeStart} />}
      </div>
    );
  }

  if (el.type === 'eac') {
    const eac = el as EacElement;
    return (
      <div
        style={{ ...base, width: eac.widthMm * SCALE, height: eac.heightMm * SCALE }}
        onMouseDown={(e) => onMouseDown(e, el.id)} onDoubleClick={() => onDoubleClick(el.id)}
        onClick={(e) => e.stopPropagation()}
      >
        <EacSvg width={eac.widthMm * SCALE} height={eac.heightMm * SCALE} color={eac.color} />
        {selected && canResize && <ResizeHandles id={el.id} onResizeStart={onResizeStart} />}
      </div>
    );
  }

  return null;
}
