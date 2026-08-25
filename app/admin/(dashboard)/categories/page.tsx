'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Modal from '@/app/components/Modal';
import { Category } from '@/app/lib/catalog';
import { useAdminListUrlState } from '@/app/lib/use-admin-list-state';

// Module-scope loader: receives state setters as arguments so that the
// effect below never calls setState synchronously (react-hooks rule).
async function fetchCategoryList(
  params: { page: number; size: number; search: string; sort: string },
  onSuccess: (categories: Category[], total: number, page: number) => void,
  onError: (message: string) => void,
  onDone: () => void,
  isCancelled: () => boolean
) {
  try {
    // Server-side pipeline: DB or= filter → COUNT(filtered) → range window.
    const qs = `?page=${params.page}&size=${params.size}&search=${encodeURIComponent(params.search)}&sort=${params.sort}`;
    const response = await fetch(`/api/admin/categories${qs}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не вдалося завантажити категорії');
    }

    if (!isCancelled()) {
      onSuccess(
        data.categories ?? [],
        typeof data.total === 'number' ? data.total : 0,
        typeof data.page === 'number' ? data.page : params.page
      );
    }
  } catch (err) {
    console.error('Error fetching categories:', err);
    if (!isCancelled()) onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

// The parent-category picker needs EVERY row (a parent may live on any
// page of the listing), so it uses the bounded full-set mode.
async function fetchAllCategoriesForPicker(
  onSuccess: (categories: Category[]) => void,
  onError: (message: string) => void
) {
  try {
    const response = await fetch('/api/admin/categories?action=all');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не вдалося завантажити категорії');
    }

    onSuccess(data.categories ?? []);
  } catch (err) {
    console.error('Error fetching category picker list:', err);
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  }
}

const PAGE_SIZE = 20;

function totalPagesFor(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

// Server-side sort keys (must match CATEGORY_SORTS in app/lib/admin-list.ts).
const CATEGORY_SORT_KEYS = ['default', 'name_asc', 'name_desc', 'slug', 'sort_order'];
const SORT_OPTIONS = [
  { value: 'default', label: 'За замовчуванням' },
  { value: 'name_asc', label: 'Назва А→Я' },
  { value: 'name_desc', label: 'Назва Я→А' },
  { value: 'slug', label: 'Slug А→Я' },
  { value: 'sort_order', label: 'Порядок сортування' },
];

export default function CategoriesAdminPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [pickerCategories, setPickerCategories] = useState<Category[]>([]);

  // Search/sort/page live in the URL (server-side semantics): refresh,
  // Back/Forward and shareable links all preserve the filtered view.
  const { ready, urlState, patchUrlState, searchInput, setSearchInput } =
    useAdminListUrlState(CATEGORY_SORT_KEYS);

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

  // Single refetch path for both the URL-driven effect and post-mutation
  // refreshes; `cancelled` drops stale out-of-order responses.
  const cancelledRef = useRef(false);
  const fetchCategories = useCallback(
    () =>
      fetchCategoryList(
        { page: urlState.page, size: PAGE_SIZE, search: urlState.search, sort: urlState.sort },
        (rows, totalCount, serverPage) => {
          setCategories(rows);
          setTotal(totalCount);
          setError(null);
          if (serverPage !== urlState.page) patchUrlState({ page: serverPage });
        },
        (message) => setError(message),
        () => setLoading(false),
        () => cancelledRef.current
      ),
    [urlState.page, urlState.search, urlState.sort, patchUrlState]
  );

  useEffect(() => {
    if (!ready) return;
    cancelledRef.current = false;
    fetchCategories();
    return () => {
      cancelledRef.current = true;
    };
  }, [ready, fetchCategories]);

  useEffect(() => {
    let cancelled = false;
    fetchAllCategoriesForPicker(
      (data) => {
        if (!cancelled) setPickerCategories(data);
      },
      (message) => {
        if (!cancelled) setError(message);
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
    setError(null);
    setStatus(null);
    setIsModalOpen(true);
  };

  const handleEdit = (category: Category) => {
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
    setError(null);
    setStatus(null);
    setIsModalOpen(true);
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
      
      // Refresh the list and the parent picker
      fetchAllCategoriesForPicker(
        (data) => setPickerCategories(data),
        (message) => setError(message)
      );
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

      // Close modal and refresh list + parent picker
      setIsModalOpen(false);
      setStatus(isEditing ? 'Категорію оновлено' : 'Категорію створено');
      fetchAllCategoriesForPicker(
        (data) => setPickerCategories(data),
        (message) => setError(message)
      );
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
      <div className="flex justify-between items-center mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Категорії</h1>
        <button
          onClick={handleCreate}
          className="btn btn-primary"
        >
          Додати категорію
        </button>
      </div>

      {/* Search + sort — server-side (DB filter → COUNT → pagination) */}
      <div className="mb-4 flex gap-3 flex-wrap">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Пошук за назвою або slug…"
          className="flex-1 min-w-[220px] px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <select
          value={urlState.sort}
          onChange={(e) => patchUrlState({ sort: e.target.value, page: 1 })}
          className="px-3 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          aria-label="Сортування"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
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

        {total === 0 && !loading && (
          <div className="text-center py-12">
            <p className="text-gray-500">
              {urlState.search !== ''
                ? `Нічого не знайдено за запитом «${urlState.search}»`
                : 'Категорій не знайдено'}
            </p>
          </div>
        )}
      </div>

      {/* Pagination — windows are cut from the FILTERED set server-side */}
      {totalPagesFor(total) > 1 && (() => {
        const effectivePage = Math.min(urlState.page, totalPagesFor(total));
        return (
          <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
            <span className="text-sm text-gray-500">
              {urlState.search !== '' ? `Знайдено: ${total} · ` : ''}
              Сторінка {effectivePage} з {totalPagesFor(total)} · усього {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={effectivePage <= 1}
                onClick={() => patchUrlState({ page: effectivePage - 1 })}
              >
                ← Назад
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={effectivePage >= totalPagesFor(total)}
                onClick={() => patchUrlState({ page: effectivePage + 1 })}
              >
                Далі →
              </button>
            </div>
          </div>
        );
      })()}

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
                      {pickerCategories.filter(cat => cat.id !== currentCategory?.id).map(category => (
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
