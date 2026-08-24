// Public storage bucket URLs are deterministic:
//   {SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}
// No Supabase client is needed to build them, so these helpers are safe
// to call from server components and browser code alike.

const STORAGE_BUCKET = 'product_images';

/**
 * Get public URL for a storage image
 * @param path - The path to the file in storage (e.g., "products/123/main/image.jpg"),
 *               or an absolute external image URL (e.g. a Yugcontract hotlink),
 *               which is returned unchanged.
 * @returns Public URL or null if not found
 */
export function getPublicImageUrl(path: string): string | null {
  if (!path) return null;

  // External absolute URLs pass through untouched — they never point at
  // our bucket and must not be rewritten into Supabase Storage URLs.
  if (/^https?:\/\//i.test(path)) return path;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return null;

  const cleanPath = path.replace(/^\/+/, '');
  const baseUrl = supabaseUrl.replace(/\/+$/, '');

  return `${baseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${cleanPath}`;
}

/**
 * Normalize a product_images.image_url value into a storage object path.
 * Relative paths pass through; full public URLs of OUR bucket are reduced
 * to their object path; EXTERNAL absolute URLs (e.g. Yugcontract hotlinks)
 * return '' — there is no storage object behind them, so delete flows must
 * skip the Storage remove call.
 * Pure + dependency-free so node:test can exercise it directly.
 */
export function storagePathFromImageUrl(imageUrl: string): string {
  const marker = '/storage/v1/object/public/product_images/';
  const index = imageUrl.indexOf(marker);
  if (index !== -1) {
    return decodeURIComponent(imageUrl.slice(index + marker.length));
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    return '';
  }
  return decodeURIComponent(imageUrl.replace(/^\/+/, ''));
}

/**
 * Get multiple public image URLs for a product
 * @param productImages - Array of product image objects from database
 * @returns Array of public URLs
 */
export function getPublicImageUrls(productImages: {
  id: string;
  product_id: string;
  image_url: string;
  alt?: string | null;
  sort_order?: number;
  is_main?: boolean;
}[]): string[] {
  if (!productImages || productImages.length === 0) return []

  return productImages
    .map(img => getPublicImageUrl(img.image_url))
    .filter(Boolean) as string[]
}

/**
 * Get main public image URL for a product
 * @param productImages - Array of product image objects from database
 * @returns Main public URL or null
 */
export function getMainPublicImageUrl(productImages: {
  id: string;
  product_id: string;
  image_url: string;
  alt?: string | null;
  sort_order?: number;
  is_main?: boolean;
}[]): string | null {
  if (!productImages || productImages.length === 0) return null

  const mainImage = productImages.find(img => img.is_main)
  if (mainImage) {
    return getPublicImageUrl(mainImage.image_url)
  }

  // Fallback: return first image
  return getPublicImageUrl(productImages[0].image_url)
}
