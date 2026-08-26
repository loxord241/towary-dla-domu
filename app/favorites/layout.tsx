import type { ReactNode } from 'react';

// Favorites live only in the visitor's localStorage: a private surface that
// must stay out of search indexes (SEO package 2026-08-26, spec E).
export const metadata = {
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
