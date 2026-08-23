import { redirect } from 'next/navigation';

// Variant management lives inside the per-product panel on /admin/products
// (Варіанти button). This route is kept only to redirect old links there.
export default function VariantsPage() {
  redirect('/admin/products');
}
