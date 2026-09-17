import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  catalogCategoryRedirect,
  catalogCategoryFilteredRewrite,
  oboiFilteredRewrite,
  linoleumFilteredRewrite,
} from '@/app/lib/catalog-paths';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The matcher includes /catalog (canonicalizing redirect + ISR rewrite)
  // and /oboi (ISR rewrite). EVERY non-admin path must return before the
  // admin session gate below — otherwise anonymous storefront visitors
  // would be bounced to /admin/login. The admin gate itself (matcher
  // '/admin/:path*') behaves exactly as before these routes were added.
  if (!pathname.startsWith('/admin')) {
    const redirectPath = catalogCategoryRedirect(
      pathname,
      request.nextUrl.searchParams,
      request.method
    );
    if (redirectPath) {
      return NextResponse.redirect(new URL(redirectPath, request.url), 308);
    }
    // ISR split (perf/SEO audit 2026-09-14): query-carrying requests to the
    // ISR-rendered paths go to the internal dynamic twin routes so filtered
    // views never serve the cached pure-view HTML. The query string is
    // preserved verbatim — only the internal pathname changes.
    const rewritePath =
      catalogCategoryFilteredRewrite(pathname, request.nextUrl.search) ??
      oboiFilteredRewrite(pathname, request.nextUrl.search) ??
      linoleumFilteredRewrite(pathname, request.nextUrl.search);
    if (rewritePath) {
      const url = request.nextUrl.clone();
      url.pathname = rewritePath;
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  // ----- admin gate (unchanged; only /admin paths reach this point) -----

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not trust unverified session cookies.
  // getUser() validates the token with the Auth server and refreshes
  // the session if needed (refreshed cookies land on `response`).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPage = pathname === '/admin/login' || pathname.startsWith('/admin/login/');

  if (isLoginPage) {
    // The login page must always be reachable. No auth requirement,
    // no admin_users check and no auto-redirect here — otherwise an
    // authenticated non-admin would loop between /admin/login and /admin.
    return response;
  }

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = '/admin/login';
    url.search = '';
    const redirectResponse = NextResponse.redirect(url);
    // Preserve refreshed session cookies on the redirect response.
    response.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  // Admin role verification is intentionally NOT done here.
  // It lives in the server-side dashboard layout (app/admin/(dashboard)/layout.tsx).
  return response;
}

export const config = {
  // '/catalog/:path*' matches zero or more segments, so bare /catalog (the
  // 308 redirect) and every /catalog/<slug> shape (the ISR rewrite) are
  // covered by one pattern; '/oboi' and '/linoleum' feed the same rewrite.
  matcher: ['/admin/:path*', '/catalog/:path*', '/oboi', '/linoleum'],
};
