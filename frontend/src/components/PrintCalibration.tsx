import { useEffect, useState } from 'react';
import { api, downloadFile } from '../api/client';

// Калибровка принтера этикеток: сдвиг и масштаб применяются ко всем PDF этикеток при скачивании
// (ЧЗ, кванты, WB, Ozon). Подбирается по тестовой этикетке: видно, сколько мм принтер срезает с каждой стороны.
export default function PrintCalibration({ widthMm, heightMm, onClose }: { widthMm: number; heightMm: number; onClose: () => void }) {
  const [c, setC] = useState<{ dxMm: number; dyMm: number; scalePct: number } | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getPrintCalib().then(setC).catch((e) => setMsg(e.message)); }, []);

  async function save(next = c) {
    if (!next) return;
    setBusy(true); setMsg('');
    try { setC(await api.setPrintCalib(next)); setMsg('Сохранено — действует для всех этикеток при скачивании'); } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }
  async function test() {
    await save();
    downloadFile(`/stock/print/test.pdf?w=${widthMm}&h=${heightMm}`, `TEST_${widthMm}x${heightMm}.pdf`).catch((e) => setMsg(e.message));
  }
  const num = (k: 'dxMm' | 'dyMm' | 'scalePct', step: number, label: string, hint: string) => c && (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-1.5 mt-1">
        <button onClick={() => setC({ ...c, [k]: +(c[k] - step).toFixed(1) })} className="w-8 h-8 border rounded hover:bg-gray-50">−</button>
        <input type="number" step={step} value={c[k]} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) })} className="w-20 border rounded px-2 py-1 text-sm text-center" />
        <button onClick={() => setC({ ...c, [k]: +(c[k] + step).toFixed(1) })} className="w-8 h-8 border rounded hover:bg-gray-50">+</button>
      </div>
      <span className="text-xs text-gray-500">{hint}</span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-center"><h3 className="font-semibold">Калибровка принтера этикеток</h3><button onClick={onClose} className="ml-auto text-gray-400 text-xl">×</button></div>
        <p className="text-sm text-gray-600">Если на печати срезается край, а в превью всё на месте — это поля и сдвиг принтера. Напечатайте тестовую этикетку: на ней рамки в 1, 2 и 3 мм от края. С какой стороны рамки не видно — туда и сдвигайте.</p>
        {!c ? <p className="text-sm text-gray-500">Загрузка…</p> : (<>
          <div className="grid grid-cols-2 gap-4">
            {num('dxMm', 0.5, 'Сдвиг вправо, мм', 'срезает слева — плюс, справа — минус')}
            {num('dyMm', 0.5, 'Сдвиг вверх, мм', 'срезает снизу — плюс, сверху — минус')}
            {num('scalePct', 1, 'Масштаб, %', 'срезает со всех сторон — уменьшите, 94–97')}
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={test} className="px-3 py-2 border rounded text-sm hover:bg-gray-50">🖨 Тестовая этикетка {widthMm}×{heightMm}</button>
            <button disabled={busy} onClick={() => save()} className="px-3 py-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-700">Сохранить</button>
            <button disabled={busy} onClick={() => { const z = { dxMm: 0, dyMm: 0, scalePct: 100 }; setC(z); save(z); }} className="px-3 py-2 text-sm text-gray-500 hover:underline">сбросить</button>
          </div>
          <p className="text-xs text-gray-500">При печати из просмотрщика PDF ставьте масштаб «100% / Фактический размер», не «По размеру страницы», и размер бумаги 58×40 в настройках принтера.</p>
        </>)}
        {msg && <p className="text-sm text-gray-700">{msg}</p>}
      </div>
    </div>
  );
}
