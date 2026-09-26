import { useState } from 'react';
import { api } from '../api/client';

interface Props {
  onProjectCreated: () => void;
}

export default function NewProjectCard({ onProjectCreated }: Props) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;

    setCreating(true);
    setError('');
    try {
      await api.createProject(name.trim());
      setName('');
      onProjectCreated();
    } catch (err: any) {
      console.error('Failed to create project:', err);
      setError(err.message || 'Произошла ошибка при создании проекта');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow p-5">
      <form onSubmit={handleSubmit} className="h-full">
        <div className="flex items-center gap-2 mb-4">
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="24" 
            height="24" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            className="text-gray-400"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="16"></line>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
          <h3 className="font-semibold text-lg text-gray-600">Новый проект</h3>
        </div>
        
        <div className="space-y-4">
          <div>
            <label htmlFor="project-name" className="block text-sm text-gray-700 mb-1">
              Название проекта
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Введите название..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={creating}
            />
            {error && (
              <p className="text-red-500 text-sm mt-1">{error}</p>
            )}
          </div>
          
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg py-2 px-4 font-medium text-sm transition-colors"
          >
            {creating ? 'Создание...' : 'Создать проект'}
          </button>
        </div>
      </form>
    </div>
  );
}