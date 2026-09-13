import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { CartProvider } from "@/app/lib/cart-context";
import { FavoritesProvider } from "@/app/lib/favorites-context";
import TrafficSourceTracker from "@/app/components/TrafficSourceTracker";
import OrganizationJsonLd from "@/app/components/OrganizationJsonLd";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  // Cyrillic is required: the storefront is lang="uk" and without this
  // subset every Ukrainian glyph falls back outside Geist.
  subsets: ["cyrillic", "latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["cyrillic", "latin"],
});

// themeColor (2026-09 audit): blue-600 (#2563eb) — the brand accent the
// header renders (logo, active nav, focus rings) and the global
// .btn-primary color in globals.css. Next 16 convention: a static
// `viewport` export in the root layout (Next 9→14 moved themeColor out of
// metadata; docs: 01-app/03-api-reference/04-functions/generate-viewport).
export const viewport: Viewport = {
  themeColor: '#2563eb',
  // viewport-fit=cover: иначе env(safe-area-inset-*) == 0 и все
  // safe-area-паддинги bottom-sheet'ов/лайтбокса не работают на iPhone.
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  ),
  // Google Merchant Center ownership verification (2026-09-05): renders as
  // <meta name="google-site-verification"> in <head>. Must stay — removing
  // it de-verifies the shop in Merchant Center.
  verification: {
    google: 'nbNl-kRrgRqXRmhVQx4YtAQZAatM2MgisQW_A68WOTw',
  },
  title: "Товари для дому — Інтернет-магазин",
  description:
    "Найкращі товари за найкращими цінами — з доставкою по всій Україні",
  openGraph: {
    title: "Товари для дому — Інтернет-магазин",
    description:
      "Найкращі товари за найкращими цінами — з доставкою по всій Україні",
    locale: "uk_UA",
    type: "website",
    siteName: "Товари для дому",
    // Default OG image for every page that does not override openGraph.
    // Committed static asset — resolvable by social crawlers without JS,
    // same origin as the site itself. Resolved against metadataBase.
    images: ['/og-image.png'],
  },
  // Audit 2026-09-13: twitter:card was missing, so X/Telegram/Viber reposts
  // fell back to a bare link preview. Only the card type is declared here —
  // twitter:title/description/image inherit from openGraph per segment
  // (pages that override og — home/PDP/catalog/oboi — carry their own cards).
  twitter: {
    card: 'summary_large_image',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="uk"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* SEO audit P2 (2026-09-12): Organization + LocalBusiness graph on
            every SSR page — facts only (contacts page, /public assets). */}
        <OrganizationJsonLd />
        <CartProvider>
          <FavoritesProvider>{children}</FavoritesProvider>
        </CartProvider>
        <TrafficSourceTracker />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
