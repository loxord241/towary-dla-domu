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
 * CSP REPORT-ONLY (2026-08-27 stage): evidence-gathering only, zero risk
 * to storefront/checkout/LiqPay/Supabase by construction.
 *
 * Every directive is derived from audited facts about the app:
 *  - script-src 'self' 'unsafe-inline': Next.js self-hosted chunks plus
 *    unavoidable inline scripts (App Router hydration payloads and the
 *    JSON-LD <script> sinks). A nonce/'strict-dynamic' policy requires
 *    runtime changes and is explicitly deferred; production Next does NOT
 *    need an eval source, and none is granted.
 *  - style-src 'self' 'unsafe-inline': compiled CSS plus React inline
 *    style attributes (4 sanctioned components).
 *  - img-src: own origin, Supabase public bucket, Yugcontract hotlinks.
 *  - font-src 'self': next/font/google self-hosts woff2 at build time.
 *  - connect-src: same-origin APIs + Supabase Auth/REST (client-side on
 *    admin login, order status, checkout success). No realtime/websockets.
 *  - form-action: LiqPay checkout is a top-level POST navigation.
 *  - frame-ancestors/base-uri/object-src harden the defaults.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
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
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
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
            // Report-only: browsers log violations but do not block,
            // so checkout, LiqPay redirect/callback and Supabase flows
            // are untouched until a separate enforcement GO.
            key: "Content-Security-Policy-Report-Only",
            value: CSP_REPORT_ONLY,
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
