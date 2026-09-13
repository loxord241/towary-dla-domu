/**
 * Route-level loading skeleton for /oboi (perf package 2026-09-13):
 * mirrors the wallpaper storefront (title row, sort control, subcategory
 * chips, card grid) — adapted from app/catalog/loading.tsx. Pure markup
 * reusing the `.skeleton` utility from globals.css. Renders exactly one
 * main landmark, like the page it stands in for.
 */

function ProductCardSkeleton() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="skeleton h-48 w-full rounded-none" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
        <div className="skeleton h-5 w-1/3" />
      </div>
    </div>
  );
}

export default function OboiLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      <main className="container mx-auto px-4 py-8">
        <div className="bg-white rounded-lg shadow p-6">
          {/* Title row skeleton */}
          <div className="mb-2 flex items-baseline justify-between gap-4 flex-wrap">
            <div className="skeleton h-7 w-32" />
            <div className="skeleton h-4 w-28" />
          </div>

          {/* Sort control skeleton */}
          <div className="mb-4 flex justify-end">
            <div className="skeleton h-10 w-44 rounded-lg" />
          </div>

          {/* Subcategory chips skeleton */}
          <div className="mb-6 flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton h-9 w-28 rounded-lg" />
            ))}
          </div>

          {/* Grid skeleton */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
