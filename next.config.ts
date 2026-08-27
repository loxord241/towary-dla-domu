import type { NextConfig } from "next";

// Supabase REST/Auth host — resolved from the SAME env var the client
// runtime uses, so the policy can never drift from the real backend.
const SUPABASE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host;
  } catch {
    return "";
  }
})();

// Yugcontract product imagery is hotlinked (import architecture); social
// cards and next/image requests must stay allowed in img-src.
const YUGCONTRACT_IMAGE_ORIGIN = "https://b2b.yugcontract.ua";

/**
 * CSP ENFORCING (2026-08-27 security hardening stage).
 *
 * Every directive is derived from audited facts about the app:
 *  - script-src 'self' 'unsafe-inline': Next.js self-hosted chunks plus
 *    unavoidable inline scripts (App Router hydration payloads and the
 *    JSON-LD <script> sinks — app/components/ProductJsonLd.tsx). Removing
 *    'unsafe-inline' requires a nonce, and per Next.js docs (guides/
 *    content-security-policy) nonce-based CSP forces DYNAMIC rendering of
 *    every page: ISR/static generation disabled, PPR incompatible. This
 *    storefront is ISR-based (home ISR 60s, static pages, sitemap), so a
 *    nonce policy is an architectural rework, not a hardening patch —
 *    consciously deferred. 'unsafe-eval' is NOT granted in production
 *    (Next/React do not need it there); it is appended ONLY in
 *    development, where React dev tooling uses eval.
 *  - style-src 'self' 'unsafe-inline': compiled CSS plus React inline
 *    style attributes (4 sanctioned components). Same nonce/dynamic-
 *    rendering constraint applies; kept minimal and documented.
 *  - img-src: own origin, Supabase public bucket, Yugcontract hotlinks.
 *  - font-src 'self': next/font/google self-hosts woff2 at build time.
 *  - connect-src: same-origin APIs + Supabase Auth/REST (client-side on
 *    admin login, order status, checkout success). No realtime/websockets.
 *    (CSP scheme matching: https://host also permits wss://host.)
 *  - form-action: LiqPay checkout is a top-level POST navigation
 *    (PayWithLiqPayButton builds a form POST to https://www.liqpay.ua).
 *  - frame-ancestors/base-uri/object-src harden the defaults.
 *
 * Dev-only relaxations ('unsafe-eval' for React dev eval, ws: for HMR) are
 * appended exclusively when NODE_ENV=development and never reach production.
 */
function buildCsp(isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self'", SUPABASE_HOST && `https://${SUPABASE_HOST}`, YUGCONTRACT_IMAGE_ORIGIN]
      .filter(Boolean)
      .join(" "),
    "font-src 'self'",
    ["connect-src 'self'", SUPABASE_HOST && `https://${SUPABASE_HOST}`]
      .filter(Boolean)
      .join(" "),
    "form-action 'self' https://www.liqpay.ua",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ];
  if (isDev) {
    // HMR websocket to the local dev server (localhost is same-host, but
    // keep the dev tunnel origin usable too). Production policy untouched.
    directives.push("connect-src 'self' ws: wss:");
  }
  return directives.join("; ");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    // Read at call time (not module load) so the enforcing policy can be
    // exercised for both environments in tests.
    const isDev = process.env.NODE_ENV === "development";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            // Enforcing since 2026-08-27: the identical policy ran as
            // Report-Only first; directives are derived from audited app
            // facts (see buildCsp). Production never gets 'unsafe-eval'.
            key: "Content-Security-Policy",
            value: buildCsp(isDev),
          },
        ],
      },
    ];
  },
  // LocalTunnel assigns a NEW random <name>.loca.lt subdomain on every
  // restart, so allow the whole loca.lt subdomain space instead of
  // hardcoding hosts. Without this, the dev server 403-blocks every
  // /_next/static chunk requested with a tunnel Origin/Referer
  // ("Blocked cross-origin request to Next.js dev resource ..."), so client
  // JS never loads on the phone and pages that render their content only
  // after hydration (/cart, /favorites) hang on the SSR spinner forever.
  // Dev-only setting: production builds ignore it entirely.
  allowedDevOrigins: ["*.loca.lt"],
};

export default nextConfig;
