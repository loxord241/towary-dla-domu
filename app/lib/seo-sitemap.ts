/**
 * Bounded paged collection for the sitemap builder. PostgREST caps any
 * response at 1000 rows, so product enumeration walks explicit windows;
 * the CALLER owns ordering (.order('id')) — this module owns termination
 * (short page ⇒ done) and the absolute row cap that bounds worst-case
 * latency no matter how large the catalog grows.
 */
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS = 100_000;

export async function collectPaged<T>(
  fetchPage: (from: number, limit: number) => Promise<T[]>,
  opts: { pageSize?: number; maxRows?: number } = {}
): Promise<T[]> {
  const pageSize = Math.min(
    Math.max(opts.pageSize ?? MAX_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  const out: T[] = [];
  let from = 0;
  for (;;) {
    const limit = Math.min(pageSize, maxRows - out.length);
    if (limit <= 0) return out;
    const rows = await fetchPage(from, limit);
    out.push(...rows);
    if (rows.length < limit) return out;
    from += limit;
  }
}
