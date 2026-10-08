import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuthStore } from '../../store/useAuthStore';
import { api } from '../../api/client';

interface NavItem { to: string; label: string; icon: string; match: string[]; children?: { to: string; label: string; match: string[] }[] }

// Разделы по ходу работы: главная → склад → производство → отгрузки; справочники отдельно
const NAV: NavItem[] = [
  { to: '/stock', label: 'Главная', icon: '◎', match: ['/stock'] },
  { to: '/stock/warehouse', label: 'Склад', icon: '▦', match: ['/stock/warehouse', '/stock/docs', '/stock/moves'] },
  {
    to: '/stock/mixes', label: 'Производство', icon: '⚙', match: ['/stock/mix', '/stock/fill', '/stock/quant'],
    children: [
      { to: '/stock/mixes', label: 'Замесы', match: ['/stock/mix'] },
      { to: '/stock/fills', label: 'Фасовка', match: ['/stock/fill'] },
      { to: '/stock/quants', label: 'Кванты', match: ['/stock/quant'] },
    ],
  },
  { to: '/stock/fbo', label: 'Отгрузки FBO', icon: '⇪', match: ['/stock/fbo'] },
  { to: '/stock/catalog', label: 'Справочники', icon: '☰', match: ['/stock/catalog'] },
];

// '/stock/mix' совпадает с /stock/mix/…, /stock/mixes; '/stock/quant' — с /stock/quants, /stock/quant/…
function isActive(path: string, match: string[]) {
  return match.some((m) => path === m || path.startsWith(m + '/') || path.startsWith(m + 's') || path.startsWith(m + 'es'));
}

export default function StockLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);

  async function logout() {
    await api.logout().catch(() => {});
    clearAuth();
    navigate('/login');
  }

  const prod = NAV[2];

  return (
    <div className="min-h-screen bg-[#EEF2F3] text-slate-900 font-ui lg:grid lg:grid-cols-[232px_minmax(0,1fr)] print:block print:bg-white">
      <aside className="bg-white border-b lg:border-b-0 lg:border-r border-slate-200 lg:sticky lg:top-0 lg:h-screen flex lg:flex-col gap-1 px-3 py-2 lg:py-5 overflow-x-auto print:hidden z-20">
        <div className="hidden lg:block px-2 pb-4">
          <div className="font-bold tracking-tight">HELMITEX</div>
          <div className="text-xs text-slate-500">Учёт производства</div>
        </div>
        <nav className="flex lg:flex-col gap-0.5 min-w-max lg:min-w-0">
          {NAV.map((n) => {
            const active = n.to === '/stock' ? pathname === '/stock' : isActive(pathname, n.match);
            return (
              <div key={n.to}>
                <NavLink to={n.to} end={n.to === '/stock'}
                  className={clsx('flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm whitespace-nowrap',
                    active ? 'bg-brand-100 text-brand-800 font-semibold' : 'text-slate-700 hover:bg-slate-100')}>
                  <span className="w-5 text-center text-slate-400">{n.icon}</span>{n.label}
                </NavLink>
                {n.children && active && (
                  <div className="hidden lg:flex flex-col ml-7 mt-0.5 mb-1 border-l border-slate-200">
                    {n.children.map((c) => (
                      <NavLink key={c.to} to={c.to}
                        className={clsx('pl-3 py-1.5 text-sm -ml-px border-l-2',
                          isActive(pathname, c.match) ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-slate-500 hover:text-slate-800')}>
                        {c.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="hidden lg:flex flex-col gap-1 mt-auto px-2 pt-4 border-t border-slate-100 text-sm">
          <button onClick={() => navigate('/projects')} className="text-left text-slate-600 hover:text-slate-900">Этикетки и коды ЧЗ →</button>
          <div className="text-xs text-slate-400 truncate pt-2">{user?.email}</div>
          <button onClick={logout} className="text-left text-xs text-slate-500 hover:text-slate-800">Выйти</button>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Подразделы производства на мобильных */}
        {isActive(pathname, prod.match) && (
          <div className="lg:hidden flex gap-1 px-4 pt-3 print:hidden">
            {prod.children!.map((c) => (
              <NavLink key={c.to} to={c.to} className={clsx('px-3 py-1.5 rounded-full text-sm', isActive(pathname, c.match) ? 'bg-brand-600 text-white' : 'bg-white text-slate-600')}>{c.label}</NavLink>
            ))}
          </div>
        )}
        <main className="px-4 sm:px-6 lg:px-8 py-5 lg:py-7 max-w-[1400px] print:p-0 print:max-w-none">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// Заголовок страницы: название, подсказка, действия справа
export function PageHeader({ title, hint, children }: { title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5 print:hidden">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {hint && <p className="text-sm text-slate-500 mt-1 max-w-3xl">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

// Блок страницы с заголовком и подсказкой
export function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
