import Link from 'next/link';
import FeedbackModal from './FeedbackModal';
import { CONTACT_EMAIL } from '@/app/lib/site';
import {
  selectFooterCategories,
  footerCategoryLabel,
} from '@/app/lib/merch-categories';

interface SiteFooterProps {
  categories?: {
    id: string;
    name: string;
    slug: string;
    parent_id?: string | null;
  }[];
}

const INFO_LINKS = [
  { href: '/contacts', label: 'Контакти' },
  { href: '/privacy', label: 'Політика конфіденційності' },
  { href: '/terms', label: 'Умови використання' },
];

// Re-exported for backward compatibility: the constant itself lives in
// app/lib/site.ts (single source, importable from client components too).
export { CONTACT_EMAIL };

/**
 * Shared storefront footer. When `categories` is provided the footer lists
 * them; otherwise it falls back to a single catalog link.
 *
 * Category links (Task #28 internal linking): the crawlable SSR anchors are
 * the merchandising categories plus every OTHER top-level category — the
 * hub pages of the tree (~13 links today, hard-capped in
 * merch-categories.ts). The previous «first 5 rows» slice linked an
 * arbitrary id-ordered subset and left all other hub pages without a
 * single crawlable internal link (the drawer and the filter <select> are
 * client-only). Mid/leaf levels stay reachable by links through their
 * parent hubs: every pure, indexable category view lists its direct
 * non-empty children as crawlable anchors (app/lib/category-seo.ts +
 * app/catalog/page.tsx), and PDP breadcrumbs add the parent chain — no
 * link farm.
 */
export default function SiteFooter({ categories }: SiteFooterProps) {
  const footerCategories = categories
    ? selectFooterCategories(categories)
    : [];
  return (
    <footer className="bg-gray-800 text-white py-12">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div>
            <h3 className="text-xl font-bold mb-4">Товари для дому</h3>
            <p className="text-gray-300">Найкращі товари для вашого життя</p>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Категорії</h4>
            {!categories || categories.length === 0 ? (
              <ul className="space-y-2 text-gray-300">
                <li><Link href="/catalog" className="hover:text-white">Каталог</Link></li>
              </ul>
            ) : (
              <ul className="space-y-2 text-gray-300">
                {footerCategories.map((category) => (
                  <li key={category.id}>
                    <Link
                      href={`/catalog?category=${encodeURIComponent(category.slug)}`}
                      className="hover:text-white"
                    >
                      {footerCategoryLabel(category)}
                    </Link>
                  </li>
                ))}
                {categories.length > footerCategories.length && (
                  <li>
                    <Link href="/catalog" className="font-medium text-white hover:underline">
                      Усі категорії →
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-semibold mb-4">Інформація</h4>
            <ul className="space-y-2 text-gray-300">
              <li>
                <Link href="/orders/lookup" className="hover:text-white">
                  Статус замовлення
                </Link>
              </li>
              {INFO_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-white">{link.label}</Link>
                </li>
              ))}
              <li>
                {/* Public support e-mail — kept as a real mailto link so it
                    stays one click away everywhere on the site. */}
                <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white underline decoration-gray-500 underline-offset-2">
                  {CONTACT_EMAIL}
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-700 mt-8 pt-8 text-center text-gray-400">
          <p className="mb-3">
            <FeedbackModal label="Як покращити сайт?" />
          </p>
          <p>&copy; {new Date().getFullYear()} Товари для дому. Всі права захищені.</p>
        </div>
      </div>
    </footer>
  );
}
