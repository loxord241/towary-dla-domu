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

export default function CatalogLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header skeleton */}
      <div className="bg-white shadow-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="skeleton h-7 w-24" />
            <div className="skeleton h-9 w-full sm:w-96 rounded-lg" />
            <div className="ml-auto flex gap-2">
              <div className="skeleton h-9 w-9 rounded-lg" />
              <div className="skeleton h-9 w-9 rounded-lg" />
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Filters sidebar skeleton */}
          <aside className="md:w-1/4 hidden md:block">
            <div className="card p-6 space-y-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="skeleton h-3 w-20" />
                  <div className="skeleton h-10 w-full rounded-lg" />
                </div>
              ))}
            </div>
          </aside>

          {/* Grid skeleton */}
          <main className="md:w-3/4">
            <div className="card p-6">
              <div className="mb-6 flex justify-between items-center">
                <div className="skeleton h-6 w-48" />
                <div className="skeleton h-10 w-40 rounded-lg" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <ProductCardSkeleton key={i} />
                ))}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
