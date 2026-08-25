'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Modal from '@/app/components/Modal';
import { Brand } from '@/app/lib/catalog';
import { useAdminListUrlState } from '@/app/lib/use-admin-list-state';

// Module-scope loader: receives state setters as arguments so that the
// effect below never calls setState synchronously (react-hooks rule).
async function fetchBrandList(
  params: { page: number; size: number; search: string; sort: string },
  onSuccess: (brands: Brand[], total: number, page: number) => void,
  onError: (message: string) => void,
  onDone: () => void,
  isCancelled: () => boolean
) {
  try {
    // Server-side pipeline: DB or= filter → COUNT(filtered) → range window.
    const qs = `?page=${params.page}&size=${params.size}&search=${encodeURIComponent(params.search)}&sort=${params.sort}`;
    const response = await fetch(`/api/admin/brands${qs}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не вдалося завантажити бренди');
    }

    if (!isCancelled()) {
      onSuccess(
        data.brands ?? [],
        typeof data.total === 'number' ? data.total : 0,
        typeof data.page === 'number' ? data.page : params.page
      );
    }
  } catch (err) {
    console.error('Error fetching brands:', err);
    if (!isCancelled()) onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

const PAGE_SIZE = 20;

function totalPagesFor(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

// Server-side sort keys (must match BRAND_SORTS in app/lib/admin-list.ts).
const BRAND_SORT_KEYS = ['default', 'name_asc', 'name_desc', 'slug'];
const SORT_OPTIONS = [
  { value: 'default', label: 'За замовчуванням' },
  { value: 'name_asc', label: 'Назва А→Я' },
  { value: 'name_desc', label: 'Назва Я→А' },
  { value: 'slug', label: 'Slug А→Я' },
];

export default function BrandsAdminPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [total, setTotal] = useState(0);

  // Search/sort/page live in the URL (server-side semantics): refresh,
  // Back/Forward and shareable links all preserve the filtered view.
  const { ready, urlState, patchUrlState, searchInput, setSearchInput } =
    useAdminListUrlState(BRAND_SORT_KEYS);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentBrand, setCurrentBrand] = useState<Brand | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    description: '',
    logo: '',
    is_active: true
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Single refetch path for both the URL-driven effect and post-mutation
  // refreshes; `cancelled` drops stale out-of-order responses.
  const cancelledRef = useRef(false);
  const fetchBrands = useCallback(
    () =>
      fetchBrandList(
        { page: urlState.page, size: PAGE_SIZE, search: urlState.search, sort: urlState.sort },
        (rows, totalCount, serverPage) => {
          setBrands(rows);
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
    fetchBrands();
    return () => {
      cancelledRef.current = true;
    };
  }, [ready, fetchBrands]);

  const handleCreate = () => {
    setCurrentBrand(null);
    setIsEditing(false);
    setFormData({
      name: '',
      slug: '',
      description: '',
      logo: '',
      is_active: true
    });
    setError(null);
    setStatus(null);
    setIsModalOpen(true);
  };

  const handleEdit = (brand: Brand) => {
    setCurrentBrand(brand);
      setIsEditing(true);
      setFormData({
        name: brand.name,
        slug: brand.slug,
        description: brand.description || '',
        logo: brand.logo || '',
        is_active: brand.is_active
      });
    setError(null);
    setStatus(null);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Видалити цей бренд? Дію не можна скасувати.')) return;
    
    try {
      const response = await fetch(`/api/admin/brands/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Не вдалося видалити бренд');
      }
      
      // Refresh the list
      await fetchBrands();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      console.error('Error deleting brand:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      const method = isEditing ? 'PUT' : 'POST';
      const url = isEditing ? `/api/admin/brands/${currentBrand?.id}` : '/api/admin/brands';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося зберегти бренд');
      }

      // Close modal and refresh list
      setIsModalOpen(false);
      setStatus(isEditing ? 'Бренд оновлено' : 'Бренд створено');
      await fetchBrands();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      console.error('Error saving brand:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target as HTMLInputElement | HTMLTextAreaElement;
    
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    
    setFormData(prev => ({
      ...prev,
      [name]: checked
    }));
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold tracking-tight text-gray-900">Бренди</h1>
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Бренди</h1>
        <button
          onClick={handleCreate}
          className="btn btn-primary"
        >
          Додати бренд
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
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Дії</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {brands.map((brand) => (
              <tr key={brand.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <div className="ml-4">
                      <div className="text-sm font-medium text-gray-900">{brand.name}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900">{brand.slug}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${brand.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {brand.is_active ? 'Активний' : 'Неактивний'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button
                    onClick={() => handleEdit(brand)}
                    className="text-blue-600 hover:text-blue-900 mr-3"
                  >
                    Редагувати
                  </button>
                  <button
                    onClick={() => handleDelete(brand.id)}
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
                : 'Брендів не знайдено'}
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
          title={
            <>
              {isEditing ? 'Редагувати бренд' : 'Новий бренд'}
              <span className="ml-2 text-sm font-normal text-gray-400">
                {isEditing ? brands.find((b) => b.id === currentBrand?.id)?.slug : ''}
              </span>
            </>
          }
          onClose={() => setIsModalOpen(false)}
        >
              <form onSubmit={handleSubmit}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Назва *</label>
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
                    <label className="block text-sm font-medium text-gray-700">Slug *</label>
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
                    <label className="block text-sm font-medium text-gray-700">Опис</label>
                    <textarea
                      name="description"
                      value={formData.description}
                      onChange={handleChange}
                      rows={3}
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">Логотип (URL)</label>
                    <input
                      type="text"
                      name="logo"
                      value={formData.logo}
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
                      onChange={handleCheckboxChange}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <label htmlFor="is_active" className="ml-2 block text-sm text-gray-900">
                      Активний
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
