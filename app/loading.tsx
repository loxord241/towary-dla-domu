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

export default function HomeLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-600">
        <div className="container mx-auto px-4 py-16 md:py-20 flex flex-col items-center gap-4">
          <div className="skeleton h-9 w-72 max-w-full opacity-30" />
          <div className="skeleton h-5 w-96 max-w-full opacity-30" />
        </div>
      </div>
      <div className="container mx-auto px-4 py-12">
        <div className="skeleton mb-6 h-7 w-56" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
