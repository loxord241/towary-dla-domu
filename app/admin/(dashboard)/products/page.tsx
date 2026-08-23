'use client';

import { useState, useEffect, useCallback } from 'react';
import { Product, Category, Brand, ProductImage, ProductVariant } from '@/app/lib/catalog';
import { getPublicImageUrl } from '@/app/lib/supabase-storage';
import Modal from '@/app/components/Modal';

// Module-scope loaders: receive state setters as arguments so that effects
// never call setState synchronously (react-hooks rule).
async function fetchProductList(
  onSuccess: (products: Product[], total: number) => void,
  onError: (message: string) => void,
  onDone: () => void,
  page?: number
) {
  try {
    const qs = page && page > 1 ? `?page=${page}&size=${PAGE_SIZE}` : '';
    const response = await fetch(`/api/admin/products${qs}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не вдалося завантажити товар');
    }

    onSuccess(
      data.products ?? [],
      typeof data.total === 'number' ? data.total : (data.products ?? []).length
    );
  } catch (err) {
    console.error('Error fetching products:', err);
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

const PAGE_SIZE = 20;

function totalPagesFor(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

async function fetchCategoryList(
  onSuccess: (categories: Category[]) => void,
  onError: (message: string) => void
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
  }
}

async function fetchBrandList(
  onSuccess: (brands: Brand[]) => void,
  onError: (message: string) => void
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
  }
}

const AVAILABILITY_OPTIONS = [
  { value: 'in_stock', label: 'В наявності' },
  { value: 'out_of_stock', label: 'Немає в наявності' },
  { value: 'limited_availability', label: 'Обмежена наявність' },
];

interface ProductFormState {
  sku: string;
  name: string;
  slug: string;
  price: string;
  old_price: string;
  currency: string;
  category_id: string;
  brand_id: string;
  description: string;
  short_description: string;
  stock_quantity: string;
  availability_status: string;
  is_active: boolean;
  is_featured: boolean;
}

const EMPTY_FORM: ProductFormState = {
  sku: '',
  name: '',
  slug: '',
  price: '',
  old_price: '',
  currency: 'UAH',
  category_id: '',
  brand_id: '',
  description: '',
  short_description: '',
  stock_quantity: '0',
  availability_status: 'in_stock',
  is_active: true,
  is_featured: false,
};

export default function ProductsAdminPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState<ProductFormState>(EMPTY_FORM);

  const [imagesPanel, setImagesPanel] = useState<{
    product: Product;
    images: ProductImage[];
  } | null>(null);
  const [variantsPanel, setVariantsPanel] = useState<{
    product: Product;
    variants: ProductVariant[];
  } | null>(null);

  // Stable refetch for handlers.
  const fetchProducts = useCallback(
    (targetPage?: number) =>
      fetchProductList(
        (rows, totalCount) => {
          setProducts(rows);
          setTotal(totalCount);
          setPage(targetPage ?? page);
        },
        (message) => setError(message),
        () => setLoading(false),
        targetPage ?? page
      ),
    [page]
  );

  useEffect(() => {
    let cancelled = false;
    fetchProductList(
      (data, totalCount) => {
        if (!cancelled) {
          setProducts(data);
          setTotal(totalCount);
          setError(null);
        }
      },
      (message) => {
        if (!cancelled) setError(message);
      },
      () => {
        if (!cancelled) setLoading(false);
      },
      1
    );
    fetchCategoryList(
      (data) => {
        if (!cancelled) setCategories(data);
      },
      (message) => {
        if (!cancelled) setError(message);
      }
    );
    fetchBrandList(
      (data) => {
        if (!cancelled) setBrands(data);
      },
      (message) => {
        if (!cancelled) setError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape closes whichever admin modal is open.
  useEffect(() => {
    if (!isModalOpen && !imagesPanel && !variantsPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setIsModalOpen(false);
      setImagesPanel(null);
      setVariantsPanel(null);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [isModalOpen, imagesPanel, variantsPanel]);

  const openCreate = () => {
    setEditingId(null);
    setFormData(EMPTY_FORM);
    setFormError(null);
    setStatus(null);
    setIsModalOpen(true);
  };

  const openEdit = async (product: Product) => {
    setStatus(null);
    try {
      const response = await fetch(`/api/admin/products/${product.id}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не вдалося завантажити товар');
      }

      const p = data.product as Product & { stock_quantity?: number };
      setEditingId(product.id);
      setFormData({
        sku: p.sku,
        name: p.name,
        slug: p.slug,
        price: String(p.price),
        old_price: p.old_price === null || p.old_price === undefined ? '' : String(p.old_price),
        currency: p.currency || 'UAH',
        category_id: p.category_id ?? '',
        brand_id: p.brand_id ?? '',
        description: p.description ?? '',
        short_description: p.short_description ?? '',
        stock_quantity: String(p.stock_quantity ?? 0),
        availability_status: p.availability_status || 'in_stock',
        is_active: Boolean(p.is_active),
        is_featured: Boolean(p.is_featured),
      });

      setFormError(null);
      setIsModalOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    }
  };

  const validateForm = (): string | null => {
    if (!formData.sku.trim()) return "Вкажіть SKU";
    if (!formData.name.trim()) return 'Вкажіть назву товару';
    if (!formData.slug.trim()) return 'Вкажіть slug';
    const price = Number(formData.price);
    if (formData.price.trim() === '' || !Number.isFinite(price) || price < 0) {
      return 'Ціна має бути невід’ємним числом';
    }
    if (formData.old_price.trim() !== '') {
      const oldPrice = Number(formData.old_price);
      if (!Number.isFinite(oldPrice) || oldPrice < 0) {
        return 'Стара ціна має бути невід’ємним числом';
      }
    }
    const stock = Number(formData.stock_quantity);
    if (
      formData.stock_quantity.trim() !== '' &&
      (!Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock))
    ) {
      return 'Кількість на складі має бути невід’ємним цілим числом';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const body = JSON.stringify({
        sku: formData.sku.trim(),
        name: formData.name.trim(),
        slug: formData.slug.trim(),
        price: Number(formData.price),
        old_price: formData.old_price.trim() === '' ? null : Number(formData.old_price),
        currency: formData.currency.trim() || 'UAH',
        category_id: formData.category_id || null,
        brand_id: formData.brand_id || null,
        description: formData.description.trim(),
        short_description: formData.short_description.trim(),
        stock_quantity: formData.stock_quantity.trim() === '' ? 0 : Number(formData.stock_quantity),
        availability_status: formData.availability_status,
        is_active: formData.is_active,
        is_featured: formData.is_featured,
      });

      const response = await fetch(
        editingId ? `/api/admin/products/${editingId}` : '/api/admin/products',
        {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося зберегти товар');
      }

      const productId: string = editingId ?? data?.product?.id;
      if (!productId) {
        throw new Error('Сервер не повернув id товару');
      }

      setIsModalOpen(false);
      setStatus(editingId ? 'Товар оновлено' : 'Товар створено');
      await fetchProducts();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (product: Product) => {
    if (!confirm(`Видалити товар «${product.name}»? Дію не можна скасувати.`)) return;

    try {
      const response = await fetch(`/api/admin/products/${product.id}`, {
        method: 'DELETE',
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося видалити товар');
      }

      setStatus('Товар видалено');
      await fetchProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    }
  };

  const openImagesPanel = async (product: Product) => {
    setStatus(null);
    try {
      const response = await fetch(`/api/admin/products/${product.id}/images`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не вдалося завантажити зображення');
      }

      setImagesPanel({ product, images: data.images ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    }
  };

  const openVariantsPanel = async (product: Product) => {
    setStatus(null);
    try {
      const response = await fetch(`/api/admin/products/${product.id}/variants`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не вдалося завантажити варіанти');
      }

      setVariantsPanel({ product, variants: data.variants ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const target = e.target;
    setFormData((prev) => ({ ...prev, [target.name]: target.value }));
  };

  const handleCheckbox = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.checked }));
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">Товари</h1>
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Товари</h1>
        <button onClick={openCreate} className="btn btn-primary">
          + Додати товар
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded" role="alert">
          {error}
        </div>
      )}

      {status && !isModalOpen && !imagesPanel && !variantsPanel && (
        <div className="mb-4 bg-green-100 border border-green-400 text-green-800 px-4 py-3 rounded" role="status">
          {status}
        </div>
      )}

      <div className="bg-white shadow-md rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Фото</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Назва</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">SKU</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ціна</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Склад</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Статус</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Дії</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.map((product) => {
              // Defensive: the API embeds images as an array, but a missing
              // or malformed field must degrade to "no image", never throw.
              const productImages = product.images ?? [];
              const mainImage =
                productImages.find((image) => image.is_main) ?? productImages[0];
              return (
                <tr key={product.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    {mainImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={getPublicImageUrl(mainImage.image_url) ?? ''}
                        alt={mainImage.alt ?? product.name}
                        className="w-12 h-12 object-cover rounded"
                      />
                    ) : (
                      <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center text-[10px] text-gray-400">
                        немає
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{product.name}</div>
                    {product.brand && (
                      <div className="text-sm text-gray-500">{product.brand.name}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">{product.sku}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {product.price} {product.currency}
                  </td>
                  <td className="px-6 py-4 text-sm whitespace-nowrap">
                    <span
                      className={`font-semibold ${
                        product.stock_quantity > 0
                          ? 'text-gray-900'
                          : 'text-red-600'
                      }`}
                    >
                      {product.stock_quantity}
                    </span>{' '}
                    <span className="text-gray-400">шт</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        product.is_active
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {product.is_active ? 'Активний' : 'Прихований'}
                    </span>
                    {product.is_featured && (
                      <span className="ml-1 px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800">
                        Вибраний
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button onClick={() => openImagesPanel(product)} className="text-blue-600 hover:text-blue-800 hover:underline mr-3">
                      Фото
                    </button>
                    <button onClick={() => openVariantsPanel(product)} className="text-indigo-600 hover:text-indigo-800 hover:underline mr-3">
                      Варіанти
                    </button>
                    <button onClick={() => openEdit(product)} className="text-blue-700 hover:text-blue-900 hover:underline mr-3">
                      Редагувати
                    </button>
                    <button onClick={() => handleDelete(product)} className="text-red-600 hover:text-red-800 hover:underline">
                      Видалити
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {products.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">Товари відсутні</p>
          </div>
        )}
      </div>


        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
            <span className="text-sm text-gray-500">
              Сторінка {page} з {totalPagesFor(total)} · усього {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={page <= 1 || loading}
                onClick={() => fetchProducts(page - 1)}
              >
                ← Назад
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={page >= totalPagesFor(total) || loading}
                onClick={() => fetchProducts(page + 1)}
              >
                Далі →
              </button>
            </div>
          </div>
        )}

      {/* Create / Edit modal */}
      {isModalOpen && (
        <Modal
          title={editingId ? 'Редагувати товар' : 'Новий товар'}
          onClose={() => setIsModalOpen(false)}
          wide
        >
          <form onSubmit={handleSubmit}>
              {formError && (
                <div className="alert alert-error" role="alert">
                  {formError}
                </div>
              )}

              <fieldset className="border border-gray-200 rounded-md p-4 mb-4">
                <legend className="px-2 text-sm font-semibold text-gray-700">Основне</legend>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block text-sm font-medium text-gray-700">
                    SKU *
                    <input type="text" name="sku" value={formData.sku} onChange={handleChange} required
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Назва *
                    <input type="text" name="name" value={formData.name} onChange={handleChange} required
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Slug *
                    <input type="text" name="slug" value={formData.slug} onChange={handleChange} required
                      placeholder="url-adresa-tovaru"
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Валюта
                    <select name="currency" value={formData.currency} onChange={handleChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
                      <option value="UAH">UAH</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Ціна *
                    <input type="number" step="0.01" min="0" name="price" value={formData.price} onChange={handleChange} required
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Стара ціна
                    <input type="number" step="0.01" min="0" name="old_price" value={formData.old_price} onChange={handleChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Категорія
                    <select name="category_id" value={formData.category_id} onChange={handleChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
                      <option value="">— Без категорії —</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Бренд
                    <select name="brand_id" value={formData.brand_id} onChange={handleChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
                      <option value="">— Без бренду —</option>
                      {brands.map((brand) => (
                        <option key={brand.id} value={brand.id}>{brand.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Кількість на складі
                    <input type="number" step="1" min="0" name="stock_quantity" value={formData.stock_quantity} onChange={handleChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Наявність
                    <select name="availability_status" value={formData.availability_status} onChange={handleChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
                      {AVAILABILITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex items-center gap-6 mt-4">
                  <label className="inline-flex items-center text-sm font-medium text-gray-700">
                    <input type="checkbox" name="is_active" checked={formData.is_active} onChange={handleCheckbox}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
                    <span className="ml-2">Активний</span>
                  </label>
                  <label className="inline-flex items-center text-sm font-medium text-gray-700">
                    <input type="checkbox" name="is_featured" checked={formData.is_featured} onChange={handleCheckbox}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
                    <span className="ml-2">Вибраний (на головній)</span>
                  </label>
                </div>
              </fieldset>

              <fieldset className="border border-gray-200 rounded-md p-4 mb-4">
                <legend className="px-2 text-sm font-semibold text-gray-700">Опис (базовий)</legend>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  Короткий опис
                  <textarea name="short_description" rows={2} value={formData.short_description} onChange={handleChange}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                </label>
                <label className="block text-sm font-medium text-gray-700">
                  Повний опис
                  <textarea name="description" rows={3} value={formData.description} onChange={handleChange}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2" />
                </label>
              </fieldset>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="btn btn-secondary"
                >
                  Скасувати
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn btn-primary"
                >
                  {isSubmitting ? 'Збереження...' : 'Зберегти'}
                </button>
              </div>
          </form>
        </Modal>
      )}

      {/* Images panel */}
      {imagesPanel && (
        <ImagesPanel
          product={imagesPanel.product}
          initialImages={imagesPanel.images}
          onClose={() => setImagesPanel(null)}
          onSaved={fetchProducts}
        />
      )}

      {/* Variants panel */}
      {variantsPanel && (
        <VariantsPanel
          product={variantsPanel.product}
          initialVariants={variantsPanel.variants}
          onClose={() => setVariantsPanel(null)}
        />
      )}
    </div>
  );
}

/* ============================== Images panel ============================== */

function ImagesPanel({
  product,
  initialImages,
  onClose,
  onSaved,
}: {
  product: Product;
  initialImages: ProductImage[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [images, setImages] = useState<ProductImage[]>(initialImages);
  const [uploading, setUploading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadAlt, setUploadAlt] = useState('');
  const [uploadSort, setUploadSort] = useState('0');
  const [uploadMain, setUploadMain] = useState(images.length === 0);

  const refresh = async () => {
    try {
      const response = await fetch(`/api/admin/products/${product.id}/images`);
      const data = await response.json();
      if (response.ok) {
        setImages(data.images ?? []);
        await onSaved();
      }
    } catch {
      // keep previous list on failure
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setPanelError(null);
    setPanelStatus(null);

    if (!uploadFile) {
      setPanelError('Оберіть файл зображення');
      return;
    }

    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', uploadFile);
      body.append('alt', uploadAlt);
      body.append('sort_order', uploadSort || '0');
      body.append('is_main', String(uploadMain));

      const response = await fetch(`/api/admin/products/${product.id}/images`, {
        method: 'POST',
        body,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося завантажити зображення');
      }

      setUploadFile(null);
      setUploadAlt('');
      setUploadSort('0');
      setUploadMain(false);
      setPanelStatus('Зображення завантажено');
      await refresh();
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal title={<>Зображення: <span className="font-normal text-gray-600">{product.name}</span></>} onClose={onClose}>
        <div>
          {panelError && (
            <div className="alert alert-error" role="alert">
              {panelError}
            </div>
          )}
          {panelStatus && (
            <div className="alert alert-success" role="status">
              {panelStatus}
            </div>
          )}

          {/* Upload form */}
          <form onSubmit={handleUpload} className="border border-dashed border-gray-300 rounded-md p-4 mb-6">
            <h3 className="text-sm font-semibold mb-3">Завантажити нове зображення</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="text-sm md:col-span-3"
              />
              <input
                type="text"
                placeholder="Alt-текст"
                value={uploadAlt}
                onChange={(e) => setUploadAlt(e.target.value)}
                className="border border-gray-300 rounded-md p-2 text-sm"
              />
              <input
                type="number"
                placeholder="Сорт."
                value={uploadSort}
                onChange={(e) => setUploadSort(e.target.value)}
                className="border border-gray-300 rounded-md p-2 text-sm"
              />
              <label className="inline-flex items-center text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={uploadMain}
                  onChange={(e) => setUploadMain(e.target.checked)}
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                />
                <span className="ml-2">Головне фото</span>
              </label>
            </div>
            <button
              type="submit"
              disabled={uploading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? 'Завантаження...' : 'Завантажити'}
            </button>
            <p className="text-xs text-gray-400 mt-2">JPEG/PNG/WebP/GIF/AVIF до 5 МБ</p>
          </form>

          {/* Existing images */}
          {images.length === 0 ? (
            <p className="py-4 text-center text-gray-500">Зображень ще немає</p>
          ) : (
            <ul className="space-y-3">
              {images.map((image) => (
                <ImageRow key={image.id} image={image} onError={setPanelError} onStatus={setPanelStatus} onRefresh={refresh} />
              ))}
            </ul>
          )}
        </div>
    </Modal>
  );
}

function ImageRow({
  image,
  onError,
  onStatus,
  onRefresh,
}: {
  image: ProductImage;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [alt, setAlt] = useState(image.alt ?? '');
  const [sortOrder, setSortOrder] = useState(String(image.sort_order ?? 0));
  const [busy, setBusy] = useState(false);

  const previewUrl = getPublicImageUrl(image.image_url);

  const save = async (patch: Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    onError('');
    try {
      const response = await fetch(`/api/admin/products/${image.product_id}/images/${image.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Помилка збереження');
      }
      onStatus(successMessage);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Видалити це зображення?')) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/products/${image.product_id}/images/${image.id}`, {
        method: 'DELETE',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Помилка видалення');
      }
      onStatus('Зображення видалено');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border border-gray-200 rounded-md p-3 flex gap-3 items-start opacity-95">
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={alt || 'preview'} className="w-16 h-16 object-cover rounded" />
      ) : (
        <div className="w-16 h-16 bg-gray-100 rounded flex items-center justify-center text-[10px] text-gray-400">
          url?
        </div>
      )}

      <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          placeholder="Alt-текст"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm"
        />
        <input
          type="number"
          placeholder="Сорт."
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy || Boolean(image.is_main)}
            onClick={() => save({ alt, sort_order: Number(sortOrder), is_main: true }, 'Головне фото оновлено')}
            className={`px-2 py-1 rounded text-xs font-medium ${
              image.is_main
                ? 'bg-yellow-100 text-yellow-800 cursor-default'
                : 'bg-yellow-600 text-white hover:bg-yellow-700'
            }`}
          >
            {image.is_main ? '★ Головне' : 'Зробити головним'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => save({ alt, sort_order: Number(sortOrder) }, 'Зображення оновлено')}
            className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
          >
            Зберегти
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="px-2 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700"
          >
            Видалити
          </button>
        </div>
      </div>
    </li>
  );
}

/* ============================= Variants panel ============================= */

function VariantsPanel({
  product,
  initialVariants,
  onClose,
}: {
  product: Product;
  initialVariants: ProductVariant[];
  onClose: () => void;
}) {
  const [variants, setVariants] = useState<ProductVariant[]>(initialVariants);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const response = await fetch(`/api/admin/products/${product.id}/variants`);
      const data = await response.json();
      if (response.ok) {
        setVariants(data.variants ?? []);
      }
    } catch {
      // keep previous list on failure
    }
  };

  return (
    <Modal title={<>Варіанти: <span className="font-normal text-gray-600">{product.name}</span></>} onClose={onClose} wide>
        <div>
          {panelError && (
            <div className="alert alert-error" role="alert">
              {panelError}
            </div>
          )}
          {panelStatus && (
            <div className="alert alert-success" role="status">
              {panelStatus}
            </div>
          )}

          <AddVariantForm productId={product.id} onCreated={() => { setPanelError(''); setPanelStatus('Варіант додано'); return refresh(); }} onError={setPanelError} />

          <h3 className="mb-3 mt-6 text-sm font-semibold">Існуючі варіанти</h3>
          {variants.length === 0 ? (
            <p className="py-4 text-center text-gray-500">Варіантів ще немає</p>
          ) : (
            <ul className="space-y-3">
              {variants.map((variant) => (
                <VariantRow
                  key={variant.id}
                  variant={variant}
                  onStatus={setPanelStatus}
                  onError={setPanelError}
                  onRefresh={refresh}
                />
              ))}
            </ul>
          )}
        </div>
    </Modal>
  );
}

interface VariantDraft {
  name: string;
  sku: string;
  price: string;
  old_price: string;
  stock_quantity: string;
  availability_status: string;
  is_active: boolean;
}

function draftFromVariant(variant: ProductVariant): VariantDraft {
  return {
    name: variant.name,
    sku: variant.sku ?? '',
    price: String(variant.price),
    old_price: variant.old_price === null || variant.old_price === undefined ? '' : String(variant.old_price),
    stock_quantity: String(variant.stock_quantity ?? 0),
    availability_status: variant.availability_status || 'in_stock',
    is_active: Boolean(variant.is_active),
  };
}

function AddVariantForm({
  productId,
  onCreated,
  onError,
}: {
  productId: string;
  onCreated: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<VariantDraft>({
    name: '', sku: '', price: '', old_price: '', stock_quantity: '0',
    availability_status: 'in_stock', is_active: true,
  });
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<VariantDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError('');

    if (!draft.name.trim()) {
      onError('Вкажіть назву варіанту');
      return;
    }
    const price = Number(draft.price);
    if (draft.price.trim() === '' || !Number.isFinite(price) || price < 0) {
      onError('Ціна має бути невід’ємним числом');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/admin/products/${productId}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          sku: draft.sku.trim() || null,
          price,
          old_price: draft.old_price.trim() === '' ? null : Number(draft.old_price),
          stock_quantity: draft.stock_quantity.trim() === '' ? 0 : Number(draft.stock_quantity),
          availability_status: draft.availability_status,
          is_active: draft.is_active,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Не вдалося створити варіант');
      }
      setDraft({ name: '', sku: '', price: '', old_price: '', stock_quantity: '0', availability_status: 'in_stock', is_active: true });
      await onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="border border-dashed border-gray-300 rounded-md p-4">
      <h3 className="text-sm font-semibold mb-3">Новий варіант</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <input type="text" placeholder="Назва *" value={draft.name} onChange={(e) => update({ name: e.target.value })} className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="text" placeholder="SKU" value={draft.sku} onChange={(e) => update({ sku: e.target.value })} className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="number" step="0.01" min="0" placeholder="Ціна *" value={draft.price} onChange={(e) => update({ price: e.target.value })} className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="number" step="0.01" min="0" placeholder="Стара ціна" value={draft.old_price} onChange={(e) => update({ old_price: e.target.value })} className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="number" step="1" min="0" placeholder="Склад" value={draft.stock_quantity} onChange={(e) => update({ stock_quantity: e.target.value })} className="border border-gray-300 rounded-md p-2 text-sm" />
        <select value={draft.availability_status} onChange={(e) => update({ availability_status: e.target.value })} className="border border-gray-300 rounded-md p-2 text-sm">
          {AVAILABILITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <label className="inline-flex items-center text-sm text-gray-700">
          <input type="checkbox" checked={draft.is_active} onChange={(e) => update({ is_active: e.target.checked })}
            className="h-4 w-4 text-blue-600 border-gray-300 rounded" />
          <span className="ml-2">Активний</span>
        </label>
        <button type="submit" disabled={saving}
          className="px-3 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {saving ? '...' : 'Додати варіант'}
        </button>
      </div>
    </form>
  );
}

function VariantRow({
  variant,
  onStatus,
  onError,
  onRefresh,
}: {
  variant: ProductVariant;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<VariantDraft>(() => draftFromVariant(variant));
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<VariantDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    onError('');
    if (!draft.name.trim()) {
      onError('Вкажіть назву варіанту');
      return;
    }
    const price = Number(draft.price);
    if (draft.price.trim() === '' || !Number.isFinite(price) || price < 0) {
      onError('Ціна має бути невід’ємним числом');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/admin/products/${variant.product_id}/variants/${variant.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          sku: draft.sku.trim() || null,
          price,
          old_price: draft.old_price.trim() === '' ? null : Number(draft.old_price),
          stock_quantity: draft.stock_quantity.trim() === '' ? 0 : Number(draft.stock_quantity),
          availability_status: draft.availability_status,
          is_active: draft.is_active,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Помилка збереження');
      }
      onStatus('Варіант оновлено');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Видалити варіант «${variant.name}»?`)) return;

    setBusy(true);
    try {
      const response = await fetch(`/api/admin/products/${variant.product_id}/variants/${variant.id}`, {
        method: 'DELETE',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Помилка видалення');
      }
      onStatus('Варіант видалено');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border border-gray-200 rounded-md p-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input type="text" value={draft.name} onChange={(e) => update({ name: e.target.value })} disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm" aria-label="Назва варіанта" />
        <input type="text" placeholder="SKU" value={draft.sku} onChange={(e) => update({ sku: e.target.value })} disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="number" step="0.01" min="0" placeholder="Ціна" value={draft.price} onChange={(e) => update({ price: e.target.value })} disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="number" step="0.01" min="0" placeholder="Стара ціна" value={draft.old_price} onChange={(e) => update({ old_price: e.target.value })} disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm" />
        <input type="number" step="1" min="0" placeholder="Склад" value={draft.stock_quantity} onChange={(e) => update({ stock_quantity: e.target.value })} disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm" />
        <select value={draft.availability_status} onChange={(e) => update({ availability_status: e.target.value })} disabled={busy}
          className="border border-gray-300 rounded-md p-2 text-sm">
          {AVAILABILITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <label className="inline-flex items-center text-sm text-gray-700">
          <input type="checkbox" checked={draft.is_active} onChange={(e) => update({ is_active: e.target.checked })} disabled={busy}
            className="h-4 w-4 text-blue-600 border-gray-300 rounded" />
          <span className="ml-2">Активний</span>
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} disabled={busy}
            className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700">
            Зберегти
          </button>
          <button type="button" onClick={remove} disabled={busy}
            className="px-2 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700">
            Видалити
          </button>
        </div>
      </div>
    </li>
  );
}
