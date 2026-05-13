import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function Admin() {
  const [users, setUsers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', role: 'OPERATOR' as 'ADMIN' | 'OPERATOR' });
  const [error, setError] = useState('');

  async function load() {
    const data = await api.getUsers();
    setUsers(data);
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.createUser(form);
      setShowCreate(false);
      setForm({ email: '', password: '', role: 'OPERATOR' });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить пользователя?')) return;
    await api.deleteUser(id);
    await load();
  }

  async function handleRoleChange(id: string, role: string) {
    await api.updateUser(id, { role });
    await load();
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm px-6 py-4">
        <h1 className="text-xl font-bold">Панель администратора</h1>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Пользователи</h2>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            + Создать
          </button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="bg-white border rounded-xl p-4 mb-4 space-y-3">
            <h3 className="font-medium">Новый пользователь</h3>
            <div className="flex gap-3">
              <input
                type="email" placeholder="Email" required
                value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="flex-1 border rounded px-3 py-2 text-sm"
              />
              <input
                type="password" placeholder="Пароль (мин. 8 символов)" required minLength={8}
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="flex-1 border rounded px-3 py-2 text-sm"
              />
              <select
                value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as any })}
                className="border rounded px-2 py-2 text-sm"
              >
                <option value="OPERATOR">Оператор</option>
                <option value="ADMIN">Администратор</option>
              </select>
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm">Создать</button>
              <button type="button" onClick={() => setShowCreate(false)} className="text-gray-500 text-sm">Отмена</button>
            </div>
          </form>
        )}

        <table className="w-full bg-white rounded-xl border text-sm">
          <thead>
            <tr className="border-b text-left text-gray-400">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Роль</th>
              <th className="px-4 py-3">Создан</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b last:border-0">
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u.id, e.target.value)}
                    className="border rounded px-2 py-1 text-sm"
                  >
                    <option value="OPERATOR">Оператор</option>
                    <option value="ADMIN">Администратор</option>
                  </select>
                </td>
                <td className="px-4 py-3 text-gray-400">{new Date(u.createdAt).toLocaleDateString('ru')}</td>
                <td className="px-4 py-3">
                  <button onClick={() => handleDelete(u.id)} className="text-red-500 hover:underline text-xs">Удалить</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </div>
  );
}
