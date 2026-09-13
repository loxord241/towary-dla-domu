import type { CatalogCardProduct } from '@/app/lib/catalog';
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage';
import ProductCard from './ProductCard';

/**
 * «Клей для шпалер» shelf on WALLPAPER product pages only (the page gates
 * it behind isWallpaper). Server component fed by fetchGlueCrossSell
 * (bounded, deterministic, 60s cache); hides itself ENTIRELY when nothing
 * qualifies — no empty box (same contract as RelatedProducts). Heading is
 * an h2: the page's single top-level heading stays the product name
 * (h1-invariants test).
 */
export default function GlueCrossSell({
  products,
}: {
  products: CatalogCardProduct[];
}) {
  if (products.length === 0) return null;

  return (
    <section className="mb-8 rounded-lg bg-white p-4 sm:p-6 shadow">
      <h2 className="mb-1 text-xl font-bold">Клей для шпалер</h2>
      <p className="mb-4 text-sm text-gray-500">
        Не забудьте клей — без нього шпалери не триматимуться.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 lg:grid-cols-5">
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
