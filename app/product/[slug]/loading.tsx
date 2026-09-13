/**
 * Route-level loading skeleton for /product/[slug] (perf package
 * 2026-09-13): mirrors the PDP layout (breadcrumb strip, gallery column,
 * buy-box column, description block) so navigation paints an
 * instantly-recognizable placeholder instead of a blank screen while the
 * product page streams. Pure markup — reuses the `.skeleton` utility from
 * globals.css, same pattern as app/catalog/loading.tsx. Renders exactly
 * one main landmark, like the page it stands in for.
 */

function GallerySkeleton() {
  return (
    <div className="space-y-3">
      <div className="skeleton aspect-square w-full rounded-xl" />
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-20 w-20 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function BuyBoxSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="skeleton h-8 w-3/4" />
        <div className="skeleton h-4 w-1/3" />
      </div>
      <div className="skeleton h-10 w-40" />
      <div className="skeleton h-12 w-full rounded-lg" />
      <div className="space-y-2 pt-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-4 w-full" />
        ))}
      </div>
    </div>
  );
}

export default function ProductLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <main className="container mx-auto flex-1 px-4 py-8">
        {/* Breadcrumb strip */}
        <div className="mb-5 flex items-center gap-2">
          <div className="skeleton h-4 w-16" />
          <div className="skeleton h-4 w-2" />
          <div className="skeleton h-4 w-16" />
          <div className="skeleton h-4 w-2" />
          <div className="skeleton h-4 w-32" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <GallerySkeleton />
          <BuyBoxSkeleton />
        </div>

        {/* Description / specifications block */}
        <div className="card mt-8 p-6 space-y-3">
          <div className="skeleton h-6 w-48" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-5/6" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      </main>
    </div>
  );
}
