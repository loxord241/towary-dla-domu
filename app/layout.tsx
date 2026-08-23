import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { CartProvider } from "@/app/lib/cart-context";
import { FavoritesProvider } from "@/app/lib/favorites-context";
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
  title: "E-Shop — Інтернет-магазин",
  description:
    "Найкращі товари за найкращими цінами — з доставкою по всій Україні",
  openGraph: {
    title: "E-Shop — Інтернет-магазин",
    description:
      "Найкращі товари за найкращими цінами — з доставкою по всій Україні",
    locale: "uk_UA",
    type: "website",
    siteName: "E-Shop",
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
      </body>
    </html>
  );
}
