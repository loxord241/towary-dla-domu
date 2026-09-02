/**
 * Pure decision logic for the product description block.
 * No JSX, no React — unit-testable under node:test.
 *
 * SECURITY INVARIANT: `description` arrives ALREADY SANITIZED by the
 * allowlist sanitizer at import/staging time (app/lib/yugcontract/
 * content-sanitize.ts). Nothing here mutates or re-sanitizes content.
 *
 * NOTE: htmlToPlainText/isPlaceholderDescription live here (not in seo.ts)
 * because this module is imported by the client component ProductDescription,
 * while seo.ts also carries the huge supplier-boilerplate lists that must
 * not ship in the client bundle. seo.ts re-exports both for its meta logic.
 */

export type ResolvedDescription =
  | { kind: 'html'; value: string }
  | { kind: 'text'; value: string };

/** HTML → plain text (same normalization the meta description used). */
export function htmlToPlainText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the description carries no text at all (tags/nbsp/whitespace). */
export function isPlaceholderDescription(html: string | null | undefined): boolean {
  return htmlToPlainText(html) === '';
}

/**
 * Whether the PDP «Опис» section (heading included) should render at all
 * (Task #41 2026-09-02): products with no description or legacy supplier
 * HTML shells like <div><div></div></div> must not show an empty block.
 * Real content in either source keeps the section: a non-placeholder
 * description renders as before, otherwise the short_description fallback
 * still applies. Short real descriptions are never hidden for being short.
 */
export function shouldRenderDescriptionSection(
  description: string | null | undefined,
  shortDescription: string | null | undefined
): boolean {
  if ((shortDescription?.trim() ?? '') !== '') return true;
  return !isPlaceholderDescription(description);
}

/** description (HTML) → short_description → «Опис відсутній». */
export function resolveProductDescription(
  description: string | null | undefined,
  shortDescription: string | null | undefined
): ResolvedDescription {
  const d = description?.trim() ?? '';
  if (d !== '') return { kind: 'html', value: d };
  const s = shortDescription?.trim() ?? '';
  if (s !== '') return { kind: 'text', value: s };
  return { kind: 'text', value: 'Опис відсутній' };
}
