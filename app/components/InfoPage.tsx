import type { ReactNode } from 'react';
import SiteHeader from '@/app/components/SiteHeader';
import SiteFooter from '@/app/components/SiteFooter';

interface InfoPageProps {
  title: string;
  /** Explicit list of what content must be provided by the store owner.
   * Only rendered while a page has no real content (no children). */
  requiredContent?: string[];
  intro?: string;
  children?: ReactNode;
}

/**
 * Shared template for informational pages. Content is intentionally NOT
 * invented: each page shows a structured placeholder listing exactly what
 * the owner must supply before publishing.
 */
export default function InfoPage({
  title,
  requiredContent,
  intro,
  children,
}: InfoPageProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <div className="container mx-auto px-4 py-10">
        <div className="card max-w-2xl mx-auto p-8">
          <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 mb-2">
            {title}
          </h1>
          <div aria-hidden className="mb-6 h-1 w-12 rounded bg-blue-600" />
          {intro && (
            <p className="mb-6 text-base leading-relaxed text-gray-600">{intro}</p>
          )}
          {children ? (
            children
          ) : (
            <div className="mt-8 border border-dashed border-amber-400 bg-amber-50 rounded-lg p-5">
              <p className="text-sm font-semibold text-amber-800 mb-3">
                ⚠️ Цей розділ очікує контент від власника магазину. Текст
                навмисно не вигадано.
              </p>
              <p className="mb-2 text-sm text-amber-800">Потрібно надати:</p>
              <ul className="list-disc list-inside space-y-1 text-sm text-amber-900">
                {(requiredContent ?? []).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
