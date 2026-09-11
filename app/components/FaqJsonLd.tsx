import { buildFaqJsonLd, serializeJsonLd } from '@/app/lib/schema-org';
import type { FaqItemLike } from '@/app/lib/schema-org';

/**
 * The THIRD sanctioned dangerouslySetInnerHTML sink of the whole app/
 * (1 — ProductDescription, 2 — ProductJsonLd; invariant pinned in
 * tests/product-description.test.ts). Input comes exclusively from the
 * WALLPAPER_FAQ list (app/lib/faq-content.ts) through buildFaqJsonLd and
 * is serialized with '<'-escaping, so no stored string can terminate the
 * script element early.
 */
export default function FaqJsonLd({ questions }: { questions: FaqItemLike[] }) {
  const data = buildFaqJsonLd(questions);
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
