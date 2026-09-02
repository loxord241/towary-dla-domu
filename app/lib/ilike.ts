/**
 * Escape Postgres LIKE/ILIKE wildcards in a user-controlled value that is
 * about to be used as a match PATTERN (e.g. `.ilike('email', ...)`).
 *
 * `_` is a legal email character AND the ILIKE "any single character"
 * wildcard: an unescaped pattern `suppo_t@shop.com` matches the admin row
 * `support@shop.com`, which turned a regular account into an admin.
 * `%` and `\` get the same treatment. Pure + dependency-free so it is
 * unit-testable without Supabase/Next imports (supabase-storage precedent).
 */
export function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
