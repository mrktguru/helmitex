import { useEditorStore, LabelElement, TextElement, BarcodeElement, RectElement, EacElement, CzArea } from '../store/useEditorStore';

export default function ElementProperties() {
  const store = useEditorStore();
  const el = store.elements.find((e) => e.id === store.selectedId);

  if (!store.selectedId) {
    return (
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Область ЧЗ</p>
        <CzAreaProps area={store.czArea} onChange={store.setCzArea} />
      </div>
    );
  }

  if (!el) return null;

  const update = (patch: Partial<LabelElement>) => store.updateElement(el.id, patch);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-gray-500 uppercase">Свойства</p>
        <button
          onClick={() => store.deleteElement(el.id)}
          className="text-xs text-red-500 hover:underline"
        >
          Удалить
        </button>
      </div>

      <Field label="X (мм)">
        <NumInput value={el.xMm} onChange={(v) => update({ xMm: v } as any)} step={0.5} />
      </Field>
      <Field label="Y (мм)">
        <NumInput value={el.yMm} onChange={(v) => update({ yMm: v } as any)} step={0.5} />
      </Field>

      {el.type === 'text' && <TextProps el={el as TextElement} update={update} />}
      {el.type === 'barcode' && <BarcodeProps el={el as BarcodeElement} update={update} />}
      {el.type === 'rect' && <RectProps el={el as RectElement} update={update} />}
      {el.type === 'image' && <ImageProps el={el as any} update={update} />}
      {el.type === 'eac' && <EacProps el={el as EacElement} update={update} />}
    </div>
  );
}

function TextProps({ el, update }: { el: TextElement; update: (p: any) => void }) {
  return (
    <>
      <Field label="Текст">
        <textarea
          value={el.text}
          onChange={(e) => update({ text: e.target.value })}
          rows={2}
          className="w-full border rounded px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Выравнивание">
        <div className="flex gap-1">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button
              key={a}
              onClick={() => update({ align: a })}
              className={`flex-1 text-xs py-1 border rounded ${(el.align ?? 'left') === a ? 'bg-blue-100 border-blue-400 text-blue-700 font-medium' : 'hover:bg-gray-50'}`}
              title={a === 'left' ? 'По левому краю' : a === 'center' ? 'По центру' : 'По правому краю'}
            >
              {a === 'left' ? '⇐' : a === 'center' ? '⇔' : '⇒'}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Заполнить блок">
        <input type="checkbox" checked={el.fitToBlock ?? false} onChange={(e) => update({ fitToBlock: e.target.checked })} />
      </Field>
      {!el.fitToBlock && (
        <Field label="Размер шрифта (pt)">
          <NumInput value={el.fontSizePt} onChange={(v) => update({ fontSizePt: v })} min={4} max={72} />
        </Field>
      )}
      <Field label="Жирный">
        <input type="checkbox" checked={el.bold} onChange={(e) => update({ bold: e.target.checked })} />
      </Field>
      <Field label="Цвет">
        <input type="color" value={el.color} onChange={(e) => update({ color: e.target.value })} className="w-full h-8 rounded border cursor-pointer" />
      </Field>
    </>
  );
}

function BarcodeProps({ el, update }: { el: BarcodeElement; update: (p: any) => void }) {
  const valid = /^\d{12,13}$/.test(el.value);
  return (
    <>
      <Field label="Значение EAN-13">
        <input
          type="text"
          value={el.value}
          maxLength={13}
          onChange={(e) => update({ value: e.target.value.replace(/\D/g, '') })}
          className={`w-full border rounded px-2 py-1 text-sm ${!valid ? 'border-red-400' : ''}`}
        />
        {!valid && <p className="text-xs text-red-500 mt-0.5">12–13 цифр</p>}
      </Field>
      <Field label="Ширина (мм)"><NumInput value={el.widthMm} onChange={(v) => update({ widthMm: v })} /></Field>
      <Field label="Высота (мм)"><NumInput value={el.heightMm} onChange={(v) => update({ heightMm: v })} /></Field>
    </>
  );
}

function RectProps({ el, update }: { el: RectElement; update: (p: any) => void }) {
  return (
    <>
      <Field label="Ширина (мм)"><NumInput value={el.widthMm} onChange={(v) => update({ widthMm: v })} /></Field>
      <Field label="Высота (мм)"><NumInput value={el.heightMm} onChange={(v) => update({ heightMm: v })} /></Field>
      <Field label="Цвет рамки">
        <input type="color" value={el.strokeColor} onChange={(e) => update({ strokeColor: e.target.value })} className="w-full h-8 rounded border cursor-pointer" />
      </Field>
      <Field label="Заливка">
        <div className="flex items-center gap-2">
          <input type="color" value={el.fillColor ?? '#ffffff'} onChange={(e) => update({ fillColor: e.target.value })} className="h-8 w-12 rounded border cursor-pointer" />
          <button onClick={() => update({ fillColor: null })} className="text-xs text-gray-400 hover:text-gray-700">Прозрачный</button>
        </div>
      </Field>
      <Field label="Толщина рамки (pt)">
        <NumInput value={el.strokeWidthPt} onChange={(v) => update({ strokeWidthPt: v })} min={0.5} max={10} step={0.5} />
      </Field>
    </>
  );
}

function ImageProps({ el, update }: { el: any; update: (p: any) => void }) {
  return (
    <>
      <Field label="Файл"><p className="text-xs text-gray-500 truncate">{el.filename ?? el.s3Key}</p></Field>
      <Field label="Ширина (мм)"><NumInput value={el.widthMm} onChange={(v) => update({ widthMm: v })} /></Field>
      <Field label="Высота (мм)"><NumInput value={el.heightMm} onChange={(v) => update({ heightMm: v })} /></Field>
    </>
  );
}

function EacProps({ el, update }: { el: EacElement; update: (p: any) => void }) {
  return (
    <>
      <Field label="Ширина (мм)"><NumInput value={el.widthMm} onChange={(v) => update({ widthMm: v })} /></Field>
      <Field label="Высота (мм)"><NumInput value={el.heightMm} onChange={(v) => update({ heightMm: v })} /></Field>
      <Field label="Цвет">
        <input type="color" value={el.color} onChange={(e) => update({ color: e.target.value })} className="w-full h-8 rounded border cursor-pointer" />
      </Field>
    </>
  );
}

function CzAreaProps({ area, onChange }: { area: CzArea; onChange: (a: CzArea) => void }) {
  return (
    <>
      <Field label="X (мм)"><NumInput value={area.xMm} onChange={(v) => onChange({ ...area, xMm: v })} step={0.5} /></Field>
      <Field label="Y (мм)"><NumInput value={area.yMm} onChange={(v) => onChange({ ...area, yMm: v })} step={0.5} /></Field>
      <Field label="Ширина (мм)"><NumInput value={area.widthMm} onChange={(v) => onChange({ ...area, widthMm: v })} min={5} /></Field>
      <Field label="Высота (мм)"><NumInput value={area.heightMm} onChange={(v) => onChange({ ...area, heightMm: v })} min={5} /></Field>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

function NumInput({ value, onChange, min = 0, max = 9999, step = 1 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full border rounded px-2 py-1 text-sm"
    />
  );
}
