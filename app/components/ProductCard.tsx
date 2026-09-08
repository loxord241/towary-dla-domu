import Link from 'next/link';
import Image from 'next/image';
import FavoriteButton from './FavoriteButton';
import { formatPrice } from '@/app/lib/format';

function availabilityLabel(status: string): string {
  if (status === 'in_stock') return 'В наявності';
  if (status === 'out_of_stock') return 'Немає в наявності';
  return 'Обмежена наявність';
}

export interface ProductCardData {
  id: string;
  name: string;
  slug: string;
  price: number;
  currency: string;
  old_price?: number | null;
  availability_status: string;
  brand?: { name: string } | null;
}

/**
 * Unified storefront product card used on the home page and the catalog.
 * Pure server component; the favorite toggle is a client island.
 */
export default function ProductCard({
  product,
  imageUrl,
  eager = false,
}: {
  product: ProductCardData;
  imageUrl?: string | null;
  /** Above-the-fold boost for the first grid row(s) only: eager load with
   *  high fetch priority (Next 16 replacement for the deprecated `priority`
   *  prop — docs recommend loading="eager" for multiple above-fold images).
   *  Every other card keeps next/image native lazy-loading. */
  eager?: boolean;
}) {
  const outOfStock = product.availability_status === 'out_of_stock';
  const hasDiscount =
    product.old_price != null && product.old_price > product.price;

  return (
    <div className="group relative flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className="absolute top-2 right-2 z-10 rounded-full bg-white/90 p-1 shadow-sm">
        <FavoriteButton productId={product.id} />
      </div>

      <Link href={`/product/${product.slug}`} className="flex flex-1 flex-col">
        <div className="relative overflow-hidden rounded-t-xl bg-white">
          {hasDiscount && (
            <span className="absolute left-2 top-2 z-10 rounded-md bg-red-600 px-2 py-1 text-xs font-bold text-white shadow-sm">
              −{Math.round((1 - product.price / product.old_price!) * 100)}%
            </span>
          )}
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt={product.name}
              width={400}
              height={300}
              loading={eager ? "eager" : "lazy"}
              fetchPriority={eager ? "high" : "auto"}
              sizes="(max-width: 640px) 92vw, (max-width: 768px) 45vw, 33vw"
              // object-contain: the WHOLE supplier photo must fit inside the
              // card (object-cover was cropping product photos).
              className="h-48 w-full object-contain p-2 transition-transform duration-300 motion-reduce:transition-none group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-48 w-full items-center justify-center border-b border-gray-100">
              <span className="text-sm text-gray-400">Фото відсутнє</span>
            </div>
          )}
          {outOfStock && (
            <span className="absolute bottom-2 left-2 rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
              Немає в наявності
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col p-4">
          <h3 className="mb-1 line-clamp-2 font-semibold text-gray-900 transition-colors motion-reduce:transition-none group-hover:text-blue-700">
            {product.name}
          </h3>
          {product.brand && (
            <p className="mb-2 text-sm text-gray-500">{product.brand.name}</p>
          )}

          <div className="mt-auto flex flex-wrap items-baseline gap-x-2 gap-y-1 pt-2">
            {hasDiscount ? (
              <>
                <span className="text-xl font-extrabold text-red-600">
                  {formatPrice(product.price, product.currency)}
                </span>
                <span className="text-sm text-gray-400 line-through">
                  {formatPrice(product.old_price!, product.currency)}
                </span>
              </>
            ) : (
              <span className="text-lg font-bold text-blue-700">
                {formatPrice(product.price, product.currency)}
              </span>
            )}
          </div>
          {!outOfStock && (
            <p className="mt-1 text-xs text-gray-500">
              {availabilityLabel(product.availability_status)}
            </p>
          )}
        </div>
      </Link>
    </div>
  );
}
