import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { btnPrimary, btnSecondary, fmtDate } from './common';
import { PageHeader } from './StockLayout';

// Отправки WB FBS: поставки из кабинета WB и новые задания
export default function WbSupplies() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function load() {
    setError('');
    try {
      const st = await api.wbStatus();
      if (!st.configured) { setError('WB API не настроен: нет WB_API_TOKEN в .env сервера'); setRows([]); return; }
      const [s, n] = await Promise.all([api.wbSupplies(), api.wbNewOrders()]);
      setRows(s); setFresh(n.length);
    } catch (e: any) { setError(e.message); setRows((r) => r ?? []); }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    const name = prompt('Название поставки', `Поставка от ${new Date().toLocaleDateString('ru-RU')}`);
    if (!name) return;
    setBusy(true);
    try {
      const { id } = await api.wbCreateSupply(name);
      navigate(`/stock/wb/${id}`);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  const open = rows?.filter((s) => !s.done) ?? [];
  const closed = rows?.filter((s) => s.done) ?? [];

  return (
    <div>
      <PageHeader title="Отправки WB FBS" hint="Сборка поставки по шагам: задания → поставка → Честный знак → грузоместа → печать → передача в доставку. Коды ЧЗ берутся из раздела «Маркировка».">
        <button className={btnSecondary} onClick={() => downloadFile('/stock/wb/cz.xlsx', 'ЧЗ WB FBS.xlsx').catch((e) => setError(e.message))}>⇩ Таблица ЧЗ</button>
        <button className={btnPrimary} disabled={busy} onClick={create}>+ Новая поставка</button>
      </PageHeader>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {fresh != null && fresh > 0 && (
        <div className="bg-fuchsia-50 text-fuchsia-800 border border-fuchsia-200 rounded-xl px-4 py-3 mb-4 text-sm">
          Новых заданий в WB: <b>{fresh}</b> — откройте поставку и добавьте их на шаге «Задания».
        </div>
      )}
      {!rows && <p className="text-sm text-slate-500">Загрузка из WB…</p>}

      {rows && (
        <div className="space-y-6">
          <section>
            <h2 className="font-semibold mb-2">Открытые</h2>
            {open.length === 0 && <p className="text-sm text-slate-500">Открытых поставок нет</p>}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {open.map((s) => <Card key={s.id} s={s} />)}
            </div>
          </section>
          {closed.length > 0 && (
            <section>
              <h2 className="font-semibold mb-2">Переданы в доставку</h2>
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {closed.map((s) => (
                  <Link key={s.id} to={`/stock/wb/${s.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
                    <span className="font-mono">{s.id}</span>
                    <span className="text-slate-500">{s.name}</span>
                    <span className="ml-auto text-slate-500">{s.orders != null ? `${s.orders} зад. · ` : ''}закрыта {fmtDate(s.closedAt)}</span>
                    {s.stockDocId ? <span className="text-xs text-green-700">списано</span> : <span className="text-xs text-slate-400">не списано</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ s }: { s: any }) {
  return (
    <Link to={`/stock/wb/${s.id}`} className={clsx('bg-white rounded-xl border p-4 hover:shadow-sm transition', 'border-slate-200 hover:border-brand-400')}>
      <div className="flex justify-between gap-2">
        <span className="font-mono font-semibold">{s.id}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-fuchsia-50 text-fuchsia-700 h-fit">открыта</span>
      </div>
      <div className="text-sm text-slate-500 mt-0.5">{s.name} · создана {fmtDate(s.createdAt)}</div>
      <div className="mt-3 text-sm">{s.orders != null ? <><b>{s.orders}</b> заданий</> : <span className="text-slate-400">откройте, чтобы загрузить задания</span>}</div>
    </Link>
  );
}
