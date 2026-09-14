import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function AdminPage() {
  // Defense in depth: the (dashboard) layout already enforces auth+admin.
  // This page re-checks the session so a direct hit on /admin never renders
  // for an anonymous visitor.
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — the proxy refreshes
            // session cookies, so this is safe to ignore.
          }
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/admin/login');
  }

  const cards = [
    {
      href: '/admin/orders',
      icon: '🧾',
      title: 'Замовлення',
      description: 'Статуси, скасування, повернення залишку',
    },
    {
      href: '/admin/products',
      icon: '📦',
      title: 'Товари',
      description: 'Каталог, зображення, варіанти',
    },
    {
      href: '/admin/categories',
      icon: '🗂️',
      title: 'Категорії',
      description: 'Дерево категорій',
    },
    {
      href: '/admin/brands',
      icon: '🏷️',
      title: 'Бренди',
      description: 'Довідник брендів',
    },
    {
      href: '/admin/feedback',
      icon: '💬',
      title: "Зворотний зв'язок",
      description: 'Анонімні пропозиції відвідувачів',
    },
    {
      href: '/admin/announcements',
      icon: '📢',
      title: 'Повідомлення магазину',
      description: 'Оголошення та попередження для покупців',
    },
    {
      href: '/admin/descriptions',
      icon: '📝',
      title: 'Чернетки описів товарів',
      description: 'Згенеровані описи — затвердити або відхилити',
    },
  ];

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-gray-900">
        Панель керування
      </h1>
      <p className="mb-6 text-sm text-gray-500">
        Керування каталогом і замовленнями магазину
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <a
            key={card.href}
            href={card.href}
            className="group flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:border-blue-200 hover:shadow-md"
          >
            <span aria-hidden className="text-3xl">
              {card.icon}
            </span>
            <span className="flex-1">
              <span className="block text-lg font-semibold text-gray-900 group-hover:text-blue-700">
                {card.title}
              </span>
              <span className="mt-0.5 block text-sm text-gray-500">
                {card.description}
              </span>
            </span>
            <span
              aria-hidden
              className="self-center text-gray-300 transition-colors group-hover:text-blue-600"
            >
              →
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
