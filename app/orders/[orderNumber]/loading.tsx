/**
 * Route-level skeleton for /orders/[orderNumber] — the page validates the
 * access token and reads order + items sequentially, so navigation from the
 * lookup form previously froze the old page with no feedback.
 * Static-only: no page logic duplicated here.
 */
export default function OrderStatusLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mx-auto max-w-2xl">
          <div className="skeleton h-7 w-56 mb-2" />
          <div className="skeleton h-4 w-72 mb-6" />
          <div className="card p-6 space-y-4">
            <div className="skeleton h-5 w-36" />
            <div className="space-y-2">
              <div className="skeleton h-3 w-full" />
              <div className="skeleton h-3 w-4/5" />
              <div className="skeleton h-3 w-3/5" />
            </div>
            <div className="skeleton h-12 w-full rounded-lg" />
            <div className="skeleton h-4 w-48" />
          </div>
        </div>
      </div>
    </div>
  );
}
