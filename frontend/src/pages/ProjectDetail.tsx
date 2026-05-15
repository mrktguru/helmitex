import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import CzUploadTab from '../components/CzUploadTab';
import ExportTab from '../components/ExportTab';

type Tab = 'template' | 'cz' | 'export';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('template');
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    api.getProject(id).then(setProject).catch((err) => setLoadError(err.message ?? 'Ошибка загрузки'));
  }, [id]);

  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-screen gap-3">
      <p className="text-red-500">{loadError}</p>
      <button onClick={() => navigate('/projects')} className="text-blue-600 hover:underline text-sm">← К списку проектов</button>
    </div>
  );

  if (!project) return <div className="flex items-center justify-center h-screen">Загрузка...</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-3 sm:gap-4">
        <button onClick={() => navigate('/projects')} className="text-gray-500 hover:text-gray-900 shrink-0">← Назад</button>
        <h1 className="text-lg sm:text-xl font-bold truncate">{project.name}</h1>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div className="flex gap-2 mb-6 border-b overflow-x-auto">
          {(['template', 'cz', 'export'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              {t === 'template' ? 'Шаблон' : t === 'cz' ? 'Честный знак' : 'Экспорт'}
            </button>
          ))}
        </div>

        {tab === 'template' && (
          <div className="bg-white rounded-xl border p-4 sm:p-6">
            <p className="text-gray-600 mb-4">
              {project.template
                ? `Размер: ${project.template.widthMm} × ${project.template.heightMm} мм`
                : 'Шаблон не создан'}
            </p>
            <button
              onClick={() => navigate(`/projects/${id}/editor`)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg font-medium"
            >
              {project.template ? 'Редактировать шаблон' : 'Создать шаблон'}
            </button>
          </div>
        )}

        {tab === 'cz' && <CzUploadTab projectId={id!} />}
        {tab === 'export' && <ExportTab projectId={id!} />}
      </div>
    </div>
  );
}
