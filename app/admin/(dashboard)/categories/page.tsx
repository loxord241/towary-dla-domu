'use client';

import { useState, useEffect, useCallback } from 'react';
import Modal from '@/app/components/Modal';
import { Category } from '@/app/lib/catalog';

// Module-scope loader: receives state setters as arguments so that the
// effect below never calls setState synchronously (react-hooks rule).
async function fetchCategoryList(
  onSuccess: (categories: Category[]) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const response = await fetch('/api/admin/categories');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не вдалося завантажити категорії');
    }

    onSuccess(data.categories ?? []);
  } catch (err) {
    console.error('Error fetching categories:', err);
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

export default function CategoriesAdminPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentCategory, setCurrentCategory] = useState<Category | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    description: '',
    parent_id: '',
    image: '',
    sort_order: 0,
    is_active: true
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ukName, setUkName] = useState('');
  const [ukDescription, setUkDescription] = useState('');

  // Stable refetch for handlers (create/edit/delete).
  const fetchCategories = useCallback(
    () =>
      fetchCategoryList(
        setCategories,
        (message) => setError(message),
        () => setLoading(false)
      ),
    []
  );

  // Fetch categories on component mount
  useEffect(() => {
    let cancelled = false;
    fetchCategoryList(
      (data) => {
        if (!cancelled) {
          setCategories(data);
          setError(null);
        }
      },
      (message) => {
        if (!cancelled) setError(message);
      },
      () => {
        if (!cancelled) setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = () => {
    setCurrentCategory(null);
    setIsEditing(false);
    setFormData({
      name: '',
      slug: '',
      description: '',
      parent_id: '',
      image: '',
      sort_order: 0,
      is_active: true
    });
    setUkName('');
    setUkDescription('');
    setError(null);
    setStatus(null);
    setIsModalOpen(true);
  };

  const handleEdit = async (category: Category) => {
    try {
      const response = await fetch(`/api/admin/translations/categories/${category.id}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося завантажити переклад');
      }
      const uk = (data?.translations as Array<Record<string, unknown>> | undefined)?.find(
        (t) => t.language_code === 'uk'
      );
      setCurrentCategory(category);
      setIsEditing(true);
      setFormData({
        name: category.name,
        slug: category.slug,
        description: category.description || '',
        parent_id: category.parent_id || '',
        image: category.image || '',
        sort_order: category.sort_order,
        is_active: category.is_active
      });
      setUkName(uk && typeof uk.name === 'string' ? uk.name : '');
      setUkDescription(uk && typeof uk.description === 'string' ? uk.description : '');
      setError(null);
      setStatus(null);
      setIsModalOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Видалити цю категорію? Дію не можна скасувати.')) return;
    
    try {
      const response = await fetch(`/api/admin/categories/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Не вдалося видалити категорію');
      }
      
      // Refresh the list
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      console.error('Error deleting category:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      const method = isEditing ? 'PUT' : 'POST';
      const url = isEditing ? `/api/admin/categories/${currentCategory?.id}` : '/api/admin/categories';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          parent_id: formData.parent_id || null
        })
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося зберегти категорію');
      }

      // Save the uk translation when a name is provided.
      if (ukName.trim()) {
        const entityId = isEditing ? currentCategory?.id : data?.category?.id;

        if (entityId) {
          const translationResponse = await fetch(
            `/api/admin/translations/categories/${entityId}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                language_code: 'uk',
                name: ukName.trim(),
                description: ukDescription.trim()
              })
            }
          );
          if (!translationResponse.ok) {
            const tData = await translationResponse.json().catch(() => null);
            throw new Error(tData?.error || 'Не вдалося зберегти uk-переклад');
          }
        }
      }

      // Close modal and refresh list
      setIsModalOpen(false);
      setStatus(isEditing ? 'Категорію оновлено' : 'Категорію створено');
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      console.error('Error saving category:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold tracking-tight text-gray-900">Категорії</h1>
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Категорії</h1>
        <button
          onClick={handleCreate}
          className="btn btn-primary"
        >
          Додати категорію
        </button>
      </div>

      {status && !isModalOpen && (
        <div className="alert alert-success" role="status">
          {status}
        </div>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      <div className="bg-white shadow-md rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Назва</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Slug</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Статус</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Порядок сортування</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Дії</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {categories.map((category) => (
              <tr key={category.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <div className="ml-4">
                      <div className="text-sm font-medium text-gray-900">{category.name}</div>
                      {category.parent_id && (
                        <div className="text-sm text-gray-500">Батьківська: {category.parent_id.slice(0,8)}…</div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900">{category.slug}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${category.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {category.is_active ? 'Активна' : 'Неактивна'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {category.sort_order}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button
                    onClick={() => handleEdit(category)}
                    className="text-blue-600 hover:text-blue-900 mr-3"
                  >
                    Редагувати
                  </button>
                  <button
                    onClick={() => handleDelete(category.id)}
                    className="text-red-600 hover:text-red-900"
                  >
                    Видалити
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {categories.length === 0 && !loading && (
          <div className="text-center py-12">
            <p className="text-gray-500">Категорій не знайдено</p>
          </div>
        )}
      </div>

      {/* Modal for create/edit form */}
      {isModalOpen && (
        <Modal
          title={isEditing ? 'Редагувати категорію' : 'Нова категорія'}
          onClose={() => setIsModalOpen(false)}
        >
              <form onSubmit={handleSubmit}>
                <div className="space-y-4">
                  <div>
                    <label className="label">Назва *</label>
                    <input
                      type="text"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      required
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="label">Slug *</label>
                    <input
                      type="text"
                      name="slug"
                      value={formData.slug}
                      onChange={handleChange}
                      required
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="label">Опис</label>
                    <textarea
                      name="description"
                      value={formData.description}
                      onChange={handleChange}
                      rows={3}
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="label">Батьківська категорія</label>
                    <select
                      name="parent_id"
                      value={formData.parent_id}
                      onChange={handleChange}
                      className="input"
                    >
                      <option value="">None (Top-level)</option>
                      {categories.filter(cat => cat.id !== currentCategory?.id).map(category => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label">Порядок сортування</label>
                    <input
                      type="number"
                      name="sort_order"
                      value={formData.sort_order}
                      onChange={handleChange}
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="label">Зображення (URL)</label>
                    <input
                      type="text"
                      name="image"
                      value={formData.image}
                      onChange={handleChange}
                      className="input"
                    />
                  </div>

                  <div className="flex items-center">
                    <input
                      id="is_active"
                      name="is_active"
                      type="checkbox"
                      checked={formData.is_active}
                      onChange={handleChange}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <label htmlFor="is_active" className="ml-2 block text-sm text-gray-900">
                      Active
                    </label>
                  </div>
                </div>

                <fieldset className="border border-blue-200 bg-blue-50 rounded-md p-4 mt-4">
                  <legend className="px-2 text-sm font-semibold text-blue-700">Український переклад</legend>
                  <div className="space-y-4">
                    <div>
                      <label className="label">Назва (uk)</label>
                      <input
                        type="text"
                        value={ukName}
                        onChange={(e) => setUkName(e.target.value)}
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="label">Опис (uk)</label>
                      <textarea
                        value={ukDescription}
                        onChange={(e) => setUkDescription(e.target.value)}
                        rows={3}
                        className="input"
                      />
                    </div>
                  </div>
                </fieldset>

                <div className="mt-6 flex justify-end space-x-3">
                  <button type="button" onClick={() => setIsModalOpen(false)} className="btn btn-secondary">
                    Cancel
                  </button>
                  <button type="submit" disabled={isSubmitting} className="btn btn-primary">
                    {isSubmitting ? 'Збереження…' : 'Зберегти'}
                  </button>
                </div>
              </form>
        </Modal>
      )}
    </div>
  );
}