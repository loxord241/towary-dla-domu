import { ReactNode } from 'react';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

async function createAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
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
            // Called from a Server Component — safe to ignore,
            // the proxy refreshes session cookies.
          }
        },
      },
    }
  );
}

export async function signOut() {
  'use server';

  const supabase = await createAuthClient();
  await supabase.auth.signOut();
  redirect('/admin/login');
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const supabase = await createAuthClient();

  // getUser() validates the token with the Auth server
  // (unlike getSession(), which trusts unverified cookies).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/admin/login');
  }

  // Verify admin role against the admin_users table.
  // Service role key is used server-side only.
  let isAdmin = false;
  try {
    const adminSupabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data, error } = await adminSupabase
      .from('admin_users')
      .select('email')
      // Case-insensitive: auth tokens carry lowercased emails while
      // admin_users rows may be written with mixed case.
      .ilike('email', user.email ?? '')
      .maybeSingle();

    isAdmin = !error && !!data;
  } catch (e) {
    console.error('Admin check error:', e);
  }

  if (!isAdmin) {
    // Authenticated but not an admin: explain the rejection instead of
    // silently bouncing the user back to an empty login form.
    redirect('/admin/login?error=' + encodeURIComponent('Цей обліковий запис не має прав адміністратора'));
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-blue-600">Адмін-панель</h1>
          <div className="flex items-center space-x-4">
            <span className="text-gray-700">Вітаємо, {user.email}</span>
            <form action={signOut}>
              <button
                type="submit"
                className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition"
              >
                Logout
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
