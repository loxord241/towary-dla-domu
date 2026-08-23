import type { NextConfig } from "next";

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
