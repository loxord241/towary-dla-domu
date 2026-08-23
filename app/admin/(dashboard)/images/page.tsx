import { redirect } from 'next/navigation';

// Image management lives inside the per-product panel on /admin/products
// (Photos button). This route is kept only to redirect old links there.
export default function ImagesPage() {
  redirect('/admin/products');
}
