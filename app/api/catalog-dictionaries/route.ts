import { fetchActiveCategories, fetchActiveBrands } from '@/app/lib/catalog';

/**
 * Public read-only dictionaries for the navigation drawer. Serves the same
 * data the catalog filters use, cached — the drawer loads it on first open
 * so static pages that render SiteHeader stay static.
 */
export const revalidate = 300;

export async function GET() {
  const [categories, brands] = await Promise.all([
    fetchActiveCategories(),
    fetchActiveBrands(),
  ]);
  return Response.json(
    { categories, brands },
    {
      headers: {
        'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=600',
      },
    }
  );
}
