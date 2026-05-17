import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import TemplatePreview from '../components/TemplatePreview';
import VariablesCard from '../components/VariablesCard';
import CzStatusCard from '../components/CzStatusCard';
import ExportSection from '../components/ExportSection';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  // Bumped after CZ upload/delete → refreshes both CzStatusCard and ExportSection
  const [czKey, setCzKey] = useState(0);
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
        <h1 className="text-lg sm:text-xl font-bold truncate flex-1">{project.name}</h1>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 mb-6">
          {/* Left: template preview (spans 2 cols on desktop) */}
          <div className="lg:col-span-2 bg-white rounded-xl border p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-semibold">Шаблон этикетки</h3>
                {project.template && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {project.template.widthMm} × {project.template.heightMm} мм
                  </p>
                )}
              </div>
              <button
                onClick={() => navigate(`/projects/${id}/editor`)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                {project.template ? 'Редактировать' : 'Создать шаблон'}
              </button>
            </div>
            <div key={previewKey} className="bg-gray-50 rounded-lg p-4 min-h-[200px] flex items-center justify-center">
              <TemplatePreview projectId={id!} />
            </div>
          </div>

          {/* Right column: status cards */}
          <div className="space-y-4 sm:space-y-6">
            <CzStatusCard projectId={id!} onCzChange={() => setCzKey((k) => k + 1)} />
            <VariablesCard projectId={id!} onSaved={() => setPreviewKey((k) => k + 1)} />
          </div>
        </div>

        {/* Export section spans full width */}
        <ExportSection projectId={id!} czKey={czKey} onCzChange={() => setCzKey((k) => k + 1)} />
      </div>
    </div>
  );
}
