import type { CatalogCardProduct } from '@/app/lib/catalog';
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage';
import ProductCard from './ProductCard';

/**
 * «Схожі товари» shelf below the product details. Server component fed by
 * fetchRelatedProducts (bounded, deterministic); hides itself ENTIRELY when
 * nothing qualified — no empty box (spec A 2026-08-26). Heading is an h2:
 * the page's single top-level heading stays the product name
 * (h1-invariants test).
 */
export default function RelatedProducts({
  products,
}: {
  products: CatalogCardProduct[];
}) {
  if (products.length === 0) return null;

  return (
    <section className="mb-8 rounded-lg bg-white p-4 sm:p-6 shadow">
      <h2 className="mb-4 text-xl font-bold">Схожі товари</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 md:grid-cols-3 lg:grid-cols-4">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            imageUrl={getMainPublicImageUrl(product.images)}
          />
        ))}
      </div>
    </section>
  );
}
