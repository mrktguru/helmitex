import { create } from 'zustand';

export type ElementType = 'text' | 'barcode' | 'image' | 'rect' | 'eac' | 'variable';

export interface BaseElement {
  id: string;
  type: ElementType;
  xMm: number;
  yMm: number;
  label?: string;
}

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;
  fontSizePt: number;
  bold: boolean;
  color: string;
  align?: 'left' | 'center' | 'right';
  fitToBlock?: boolean;
  /** Pre-computed line breaks from browser canvas — used by PDF generator for WYSIWYG accuracy. */
  _wrappedLines?: string[];
  /** Browser-resolved font size in pt (for fit-to-block); ensures PDF matches editor exactly. */
  _resolvedFontSizePt?: number;
}

export interface BarcodeElement extends BaseElement {
  type: 'barcode';
  widthMm: number;
  heightMm: number;
  value: string;
}

export interface ImageElement extends BaseElement {
  type: 'image';
  widthMm: number;
  heightMm: number;
  s3Key: string;
  filename?: string;
}

export interface RectElement extends BaseElement {
  type: 'rect';
  widthMm: number;
  heightMm: number;
  strokeColor: string;
  fillColor: string | null;
  strokeWidthPt: number;
}

export interface EacElement extends BaseElement {
  type: 'eac';
  widthMm: number;
  heightMm: number;
  color: string; // mark color (usually black)
}

export interface VariableElement extends BaseElement {
  type: 'variable';
  key: string;
  placeholder?: string;
  fontSizePt: number;
  bold: boolean;
  color: string;
  align?: 'left' | 'center' | 'right';
  fitToBlock?: boolean;
  /** Pre-computed line breaks (with substituted value) for PDF WYSIWYG. */
  _wrappedLines?: string[];
  _resolvedFontSizePt?: number;
}

export type LabelElement = TextElement | BarcodeElement | ImageElement | RectElement | EacElement | VariableElement;

export interface VariableDef {
  /** Token name (without braces). Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ */
  token: string;
  /** Human-readable name shown in the dashboard, e.g. "Дата выпуска". */
  name: string;
}

export interface CzArea {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface PrintMargins {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

const DEFAULT_PRINT_MARGINS: PrintMargins = { topMm: 3, rightMm: 3, bottomMm: 3, leftMm: 3 };

interface HistoryEntry {
  elements: LabelElement[];
  czArea: CzArea;
  widthMm: number;
  heightMm: number;
}

interface EditorState {
  widthMm: number;
  heightMm: number;
  elements: LabelElement[];
  czArea: CzArea;
  barcodeValue: string;
  printMargins: PrintMargins;
  variables: Record<string, string>;
  variableDefs: VariableDef[];
  selectedId: string | null;
  past: HistoryEntry[];
  future: HistoryEntry[];

  setPrintMargins: (m: PrintMargins) => void;
  setSize: (w: number, h: number) => void;
  addElement: (el: LabelElement) => void;
  updateElement: (id: string, patch: Partial<LabelElement>) => void;
  deleteElement: (id: string) => void;
  selectElement: (id: string | null) => void;
  reorderElements: (newOrder: LabelElement[]) => void;
  setCzArea: (area: CzArea) => void;
  moveCzArea: (area: CzArea) => void;
  setBarcodeValue: (v: string) => void;
  setVariable: (key: string, value: string) => void;
  setVariables: (vars: Record<string, string>) => void;
  setVariableDefs: (defs: VariableDef[]) => void;
  addVariableDef: (def: VariableDef) => void;
  updateVariableDef: (token: string, patch: Partial<VariableDef>) => void;
  removeVariableDef: (token: string) => void;
  loadTemplate: (data: {
    widthMm: number; heightMm: number;
    elements: LabelElement[]; czArea: CzArea; barcodeValue?: string | null;
    printMargins?: PrintMargins | null;
    variables?: Record<string, string> | null;
    variableDefs?: VariableDef[] | null;
  }) => void;
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
}

const DEFAULT_CZ_AREA: CzArea = { xMm: 2, yMm: 2, widthMm: 20, heightMm: 20 };

export const useEditorStore = create<EditorState>((set, get) => ({
  widthMm: 58,
  heightMm: 40,
  elements: [],
  czArea: DEFAULT_CZ_AREA,
  barcodeValue: '',
  printMargins: DEFAULT_PRINT_MARGINS,
  variables: {},
  variableDefs: [],
  selectedId: null,
  past: [],
  future: [],

  pushHistory: () => {
    const { elements, czArea, widthMm, heightMm, past } = get();
    set({ past: [...past, { elements: structuredClone(elements), czArea, widthMm, heightMm }], future: [] });
  },

  setSize: (widthMm, heightMm) => {
    get().pushHistory();
    set({ widthMm, heightMm });
  },

  addElement: (el) => {
    get().pushHistory();
    set((s) => ({ elements: [...s.elements, el] }));
  },

  updateElement: (id, patch) => {
    set((s) => ({
      elements: s.elements.map((el) => el.id === id ? { ...el, ...patch } as LabelElement : el),
    }));
  },

  deleteElement: (id) => {
    get().pushHistory();
    set((s) => ({ elements: s.elements.filter((el) => el.id !== id), selectedId: null }));
  },

  selectElement: (id) => set({ selectedId: id }),

  reorderElements: (newOrder) => {
    get().pushHistory();
    set({ elements: newOrder });
  },

  setCzArea: (area) => {
    get().pushHistory();
    set({ czArea: area });
  },

  moveCzArea: (area) => set({ czArea: area }),

  setBarcodeValue: (v) => set({ barcodeValue: v }),

  setPrintMargins: (m) => set({ printMargins: m }),

  setVariable: (key, value) => set((s) => ({ variables: { ...s.variables, [key]: value } })),
  setVariables: (vars) => set({ variables: vars }),

  setVariableDefs: (defs) => set({ variableDefs: defs }),
  addVariableDef: (def) => set((s) => (
    s.variableDefs.some((d) => d.token === def.token)
      ? s
      : { variableDefs: [...s.variableDefs, def] }
  )),
  updateVariableDef: (token, patch) => set((s) => ({
    variableDefs: s.variableDefs.map((d) => d.token === token ? { ...d, ...patch } : d),
  })),
  removeVariableDef: (token) => set((s) => ({
    variableDefs: s.variableDefs.filter((d) => d.token !== token),
  })),

  loadTemplate: ({ widthMm, heightMm, elements, czArea, barcodeValue, printMargins, variables, variableDefs }) => {
    set({ widthMm, heightMm, elements, czArea, barcodeValue: barcodeValue ?? '', printMargins: printMargins ?? DEFAULT_PRINT_MARGINS, variables: variables ?? {}, variableDefs: variableDefs ?? [], past: [], future: [] });
  },

  undo: () => {
    const { past, elements, czArea, widthMm, heightMm, future } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      future: [{ elements: structuredClone(elements), czArea, widthMm, heightMm }, ...future],
      elements: prev.elements,
      czArea: prev.czArea,
      widthMm: prev.widthMm,
      heightMm: prev.heightMm,
    });
  },

  redo: () => {
    const { past, elements, czArea, widthMm, heightMm, future } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      future: future.slice(1),
      past: [...past, { elements: structuredClone(elements), czArea, widthMm, heightMm }],
      elements: next.elements,
      czArea: next.czArea,
      widthMm: next.widthMm,
      heightMm: next.heightMm,
    });
  },
}));
