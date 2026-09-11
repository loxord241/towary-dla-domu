import { WALLPAPER_FAQ } from '@/app/lib/faq-content';

/**
 * «Часті питання» block for wallpaper category pages (server component).
 *
 * Disclosure uses native <details>/<summary>: the content toggles
 * instantly with zero JavaScript and zero CSS animation, so the block is
 * motion-safe by construction (nothing for motion-reduce users to opt
 * out of — the same outcome the project's motion-reduce variants target).
 * All copy is plain React text children — no HTML parsing.
 * Rendered ONLY on page 1 of shpaleri% category views (see
 * app/catalog/page.tsx) so paginated pages never duplicate it.
 */
export default function FaqSection() {
  if (WALLPAPER_FAQ.length === 0) return null;
  return (
    <section aria-labelledby="wallpaper-faq-heading" className="mt-10 border-t border-gray-200 pt-6">
      <h2 id="wallpaper-faq-heading" className="mb-4 text-lg font-bold text-gray-900">
        Часті питання
      </h2>
      <div className="space-y-2">
        {WALLPAPER_FAQ.map((item) => (
          <details
            key={item.question}
            className="rounded-md border border-gray-200 px-4 py-3"
          >
            <summary className="cursor-pointer text-sm font-semibold text-gray-900">
              {item.question}
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              {item.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
