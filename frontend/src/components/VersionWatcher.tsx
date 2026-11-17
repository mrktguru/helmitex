import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// Открытая вкладка не скачивает новый код при переходах по разделам. Раз в 2 минуты и при возврате на вкладку
// сверяем бандл в index.html с текущим; если вышла новая версия — перезагружаемся на следующем переходе
// (не посреди заполнения формы).
const bundleOf = (html: string) => html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;
const current = () => (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)
  ?.getAttribute('src')?.replace(/^.*(\/assets\/)/, '$1') ?? null;

export default function VersionWatcher() {
  const stale = useRef(false);
  const location = useLocation();
  const first = useRef(true);

  useEffect(() => {
    const mine = current();
    if (!mine) return; // dev-сервер
    const check = () => {
      if (stale.current || document.hidden) return;
      fetch('/', { cache: 'no-store' }).then((r) => r.text()).then((html) => {
        const latest = bundleOf(html);
        if (latest && latest !== mine) stale.current = true;
      }).catch(() => undefined);
    };
    const t = setInterval(check, 120_000);
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVis);
    check();
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (stale.current) window.location.reload();
  }, [location.pathname]);

  return null;
}
