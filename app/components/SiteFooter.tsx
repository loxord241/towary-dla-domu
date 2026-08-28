import Link from 'next/link';
import FeedbackModal from './FeedbackModal';

interface SiteFooterProps {
  categories?: { id: string; name: string; slug: string }[];
}

const INFO_LINKS = [
  { href: '/contacts', label: 'Контакти' },
  { href: '/privacy', label: 'Політика конфіденційності' },
  { href: '/terms', label: 'Умови використання' },
];

/** Public support e-mail shown in the footer (single source for mailto). */
export const CONTACT_EMAIL = 'magazinujut@gmail.com';

/**
 * Shared storefront footer. When `categories` is provided the footer lists
 * them; otherwise it falls back to a single catalog link.
 */
export default function SiteFooter({ categories }: SiteFooterProps) {
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
                {/* Only the first 5 categories: the full supplier list
                    (~200 entries) made the footer endless. */}
                {categories.slice(0, 5).map((category) => (
                  <li key={category.id}>
                    <Link
                      href={`/catalog?category=${encodeURIComponent(category.slug)}`}
                      className="hover:text-white"
                    >
                      {category.name}
                    </Link>
                  </li>
                ))}
                {categories.length > 5 && (
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
