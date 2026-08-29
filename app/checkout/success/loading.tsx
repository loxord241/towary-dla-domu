/**
 * Route-level skeleton for /checkout/success — the page does sequential
 * Supabase reads (order by number + token) and can take a visible moment.
 * Static-only: no page logic duplicated here.
 */
export default function CheckoutSuccessLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full text-center">
        <div className="skeleton h-14 w-14 rounded-full mx-auto mb-4" />
        <div className="skeleton h-6 w-56 mx-auto mb-3" />
        <div className="skeleton h-4 w-72 mx-auto mb-2" />
        <div className="skeleton h-4 w-64 mx-auto mb-6" />
        <div className="card p-6 space-y-3 text-left">
          <div className="skeleton h-4 w-40" />
          <div className="skeleton h-3 w-64" />
          <div className="skeleton h-3 w-52" />
          <div className="skeleton h-10 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
