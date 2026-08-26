import type { ReactNode } from 'react';

// Cart is a private localStorage-driven surface: keep it out of search
// indexes entirely (SEO package 2026-08-26, spec E).
export const metadata = {
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
