import type { ReactNode } from 'react';

// Checkout flow and the HMAC-token success view are transactional private
// surfaces — noindex,nofollow for both via this segment layout
// (SEO package 2026-08-26, spec E).
export const metadata = {
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
