import Link from 'next/link';

interface SiteFooterProps {
  categories?: { id: string; name: string; slug: string }[];
}

const INFO_LINKS = [
  { href: '/about', label: 'Про нас' },
  { href: '/delivery', label: 'Доставка і оплата' },
  { href: '/returns', label: 'Повернення' },
  { href: '/contacts', label: 'Контакти' },
  { href: '/privacy', label: 'Політика конфіденційності' },
  { href: '/terms', label: 'Умови використання' },
];

/**
 * Shared storefront footer. When `categories` is provided the footer lists
 * them; otherwise it falls back to a single catalog link.
 */
export default function SiteFooter({ categories }: SiteFooterProps) {
  return (
    <footer className="bg-gray-800 text-white py-12">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div>
            <h3 className="text-xl font-bold mb-4">E-Shop</h3>
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
                {categories.map((category) => (
                  <li key={category.id}>
                    <Link
                      href={`/catalog?category=${encodeURIComponent(category.slug)}`}
                      className="hover:text-white"
                    >
                      {category.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-semibold mb-4">Магазин</h4>
            <ul className="space-y-2 text-gray-300">
              {INFO_LINKS.slice(0, 3).map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-white">{link.label}</Link>
                </li>
              ))}
              <li>
                <Link href="/orders/lookup" className="hover:text-white">
                  Статус замовлення
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Інформація</h4>
            <ul className="space-y-2 text-gray-300">
              {INFO_LINKS.slice(3).map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-white">{link.label}</Link>
                </li>
              ))}
              <li>email: info@eshop.ua</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-700 mt-8 pt-8 text-center text-gray-400">
          <p>&copy; {new Date().getFullYear()} E-Shop. Всі права захищені.</p>
        </div>
      </div>
    </footer>
  );
}
