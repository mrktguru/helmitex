import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../store/useAuthStore';

interface Project {
  id: string;
  name: string;
  createdAt: string;
  template?: { widthMm: number; heightMm: number } | null;
  czBatches: { codes: { status: string }[] }[];
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);

  async function load() {
    const data = await api.getProjects();
    setProjects(data);
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const project = await api.createProject(newName.trim());
      setNewName('');
      navigate(`/projects/${project.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleLogout() {
    await api.logout();
    clearAuth();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg sm:text-xl font-bold">LabelStudio</h1>
        <div className="flex items-center gap-3 sm:gap-4 text-sm">
          <span className="hidden sm:inline text-gray-600 truncate max-w-[140px]">{user?.email}</span>
          {user?.role === 'ADMIN' && (
            <button onClick={() => navigate('/admin')} className="text-blue-600 hover:underline">Админ</button>
          )}
          <button onClick={handleLogout} className="text-gray-500 hover:underline">Выйти</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <h2 className="text-xl sm:text-2xl font-semibold">Проекты</h2>
          <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              placeholder="Название проекта"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap"
            >
              + Новый проект
            </button>
          </form>
        </div>

        {projects.length === 0 && (
          <p className="text-gray-500 text-center mt-20">Нет проектов. Создайте первый!</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => {
            const latestBatch = p.czBatches[0];
            const total = latestBatch?.codes.length ?? 0;
            const pending = latestBatch?.codes.filter((c) => c.status === 'PENDING').length ?? 0;
            return (
              <div
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="bg-white rounded-xl shadow-sm border hover:shadow-md cursor-pointer p-5 transition-shadow"
              >
                <h3 className="font-semibold text-lg mb-1">{p.name}</h3>
                <p className="text-xs text-gray-400 mb-3">{new Date(p.createdAt).toLocaleDateString('ru')}</p>
                {p.template && (
                  <p className="text-xs text-gray-500 mb-1">
                    Шаблон: {p.template.widthMm} × {p.template.heightMm} мм
                  </p>
                )}
                {total > 0 && (
                  <p className="text-xs text-gray-500">
                    ЧЗ: <span className="text-green-600">{pending} доступно</span> / {total}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
