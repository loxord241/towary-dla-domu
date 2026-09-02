import type { Metadata } from 'next';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { escapeIlikePattern } from '@/app/lib/ilike';

// Admin entry point is a private surface: never index it
// (SEO package 2026-08-26, spec E).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

async function handleLogin(formData: FormData) {
  'use server';

  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  if (!email || !password) {
    redirect('/admin/login?error=' + encodeURIComponent('Email and password are required'));
  }

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
            // In a Server Action cookie writes are allowed;
            // this branch is unreachable but kept for safety.
          }
        },
      },
    }
  );

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Stay on the login page and show the error — no redirect loop.
    redirect('/admin/login?error=' + encodeURIComponent(error.message));
  }

  redirect('/admin');
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error: loginError } = await searchParams;

  // Check whether the visitor is already an authenticated ADMIN.
  // Only admins are sent to /admin. A plain authenticated non-admin
  // must still see the form — redirecting them would recreate the loop.
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
            // Server Component — proxy refreshes session cookies.
          }
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user?.email) {
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
        // admin_users rows may be written with mixed case. The email is
        // escaped so `_`/`%` cannot widen the match (admin bypass via
        // e.g. `suppo_t@` matching `support@`).
        .ilike('email', escapeIlikePattern(user.email))
        .maybeSingle();
      isAdmin = !error && !!data;
    } catch {
      isAdmin = false;
    }

    if (isAdmin) {
      redirect('/admin');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full">
        <h1 className="mb-6 text-center text-2xl font-bold">Вхід для адміністратора</h1>

        <p className="text-gray-600 mb-6">
          Please sign in to access the admin panel
        </p>

        {loginError && (
          <div
            role="alert"
            className="mb-4 px-4 py-3 rounded bg-red-100 border border-red-300 text-red-700 text-sm"
          >
            {loginError}
          </div>
        )}

        <form action={handleLogin}>
          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              type="password"
              id="password"
              name="password"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 transition"
          >
            Sign In
          </button>
        </form>

        <p className="mt-4 text-sm text-gray-500 text-center">
          Contact administrator if you need access
        </p>
      </div>
    </div>
  );
}
