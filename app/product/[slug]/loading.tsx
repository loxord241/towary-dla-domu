function CardSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow">
      <div className="skeleton aspect-[4/5] w-full rounded-none" />
      <div className="space-y-2 p-6">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
        <div className="skeleton h-8 w-1/3" />
        <div className="skeleton h-10 w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Route-level loading UI for /product/[slug] (perf audit Step 2): the page
 * streams instantly on navigation instead of leaving the previous screen
 * frozen for the full server-render duration.
 */
export default function ProductLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header skeleton mirrors the catalog loading state */}
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

      <div className="container mx-auto py-8">
        {/* Breadcrumb placeholder */}
        <div className="skeleton mb-5 h-4 w-64" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    </div>
  );
}
