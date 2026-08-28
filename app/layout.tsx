import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { CartProvider } from "@/app/lib/cart-context";
import { FavoritesProvider } from "@/app/lib/favorites-context";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  ),
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
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="uk"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <CartProvider>
          <FavoritesProvider>{children}</FavoritesProvider>
        </CartProvider>
        <Analytics />
      </body>
    </html>
  );
}
