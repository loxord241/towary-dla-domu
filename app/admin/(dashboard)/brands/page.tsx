'use client';

import { useState, useEffect, useCallback } from 'react';
import Modal from '@/app/components/Modal';
import { Brand } from '@/app/lib/catalog';

// Module-scope loader: receives state setters as arguments so that the
// effect below never calls setState synchronously (react-hooks rule).
async function fetchBrandList(
  onSuccess: (brands: Brand[]) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const response = await fetch('/api/admin/brands');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не вдалося завантажити бренди');
    }

    onSuccess(data.brands ?? []);
  } catch (err) {
    console.error('Error fetching brands:', err);
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

export default function BrandsAdminPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
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
  const [ukName, setUkName] = useState('');
  const [ukDescription, setUkDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Stable refetch for handlers (create/edit/delete).
  const fetchBrands = useCallback(
    () =>
      fetchBrandList(
        setBrands,
        (message) => setError(message),
        () => setLoading(false)
      ),
    []
  );

  // Fetch brands on component mount
  useEffect(() => {
    let cancelled = false;
    fetchBrandList(
      (data) => {
        if (!cancelled) {
          setBrands(data);
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
    setCurrentBrand(null);
    setIsEditing(false);
    setFormData({
      name: '',
      slug: '',
      description: '',
      logo: '',
      is_active: true
    });
    setUkName('');
    setUkDescription('');
    setError(null);
    setStatus(null);
    setIsModalOpen(true);
  };

  const handleEdit = async (brand: Brand) => {
    try {
      const response = await fetch(`/api/admin/translations/brands/${brand.id}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося завантажити переклад');
      }
      const uk = (data?.translations as Array<Record<string, unknown>> | undefined)?.find(
        (t) => t.language_code === 'uk'
      );
      setCurrentBrand(brand);
      setIsEditing(true);
      setFormData({
        name: brand.name,
        slug: brand.slug,
        description: brand.description || '',
        logo: brand.logo || '',
        is_active: brand.is_active
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

      // Save the uk translation when a name is provided.
      if (ukName.trim()) {
        const entityId = isEditing ? currentBrand?.id : data?.brand?.id;

        if (entityId) {
          const translationResponse = await fetch(
            `/api/admin/translations/brands/${entityId}`,
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
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Бренди</h1>
        <button
          onClick={handleCreate}
          className="btn btn-primary"
        >
          Додати бренд
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

        {brands.length === 0 && !loading && (
          <div className="text-center py-12">
            <p className="text-gray-500">Брендів не знайдено</p>
          </div>
        )}
      </div>

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

                <fieldset className="border border-blue-200 bg-blue-50 rounded-md p-4 mt-4">
                  <legend className="px-2 text-sm font-semibold text-blue-700">Український переклад</legend>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Назва (uk)</label>
                      <input
                        type="text"
                        value={ukName}
                        onChange={(e) => setUkName(e.target.value)}
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Опис (uk)</label>
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