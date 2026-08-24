/**
 * Pure fallback chain for the product description block.
 * No JSX, no React — unit-testable under node:test.
 *
 * SECURITY INVARIANT: `description` arrives ALREADY SANITIZED by the
 * allowlist sanitizer at import/staging time (app/lib/yugcontract/
 * content-sanitize.ts). Nothing here mutates or re-sanitizes content.
 */

export type ResolvedDescription =
  | { kind: 'html'; value: string }
  | { kind: 'text'; value: string };

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
