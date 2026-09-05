/**
 * READ-ONLY report: «что искали и не нашли» — zero-result search queries
 * for an assortment-restocking signal (procurement channel).
 *
 * Data sources:
 *  1. Vercel Web Analytics custom events (`search`, payload query/hasResults)
 *     queried via GET /v1/query/web-analytics/events/aggregate with
 *     filter=eventName eq 'search'. Verified live 2026-09-05.
 *     NOTE on OData boolean literals: bare `eq false` returns HTTP 500 from
 *     the API (server-side bug, verified 2026-09-05); quoted `eq 'false'`
 *     works today. hasResults=false events only exist AFTER the
 *     SearchViewTracker flag is deployed — historical events carry NO
 *     hasResults field and match `eventData/hasResults eq null`.
 *  2. For events without the flag (hasResults eq null): replay against the
 *     production DB (service-role, .select() only) reusing the PURE search
 *     helpers of app/lib/catalog.ts (buildSearchConditions → relaxSearchTerm
 *     trim ladder → buildFuzzyFallbackPlan probe) in the same order as
 *     fetchCatalogProducts. The eligibility join is mirrored by the inline
 *     literal 'id, images:product_images!inner(id)' — the same string as
 *     ELIGIBLE_COUNT_SELECT (catalog.ts), which is not exported; if the
 *     eligibility contract changes there, update the literal below.
 *
 * Replay fidelity: identical PostgREST grammar and identical fallback order
 * (exact → trim ladder → ONE batched fuzzy probe), so it is a FAITHFUL
 * replay, not a naive ILIKE approximation — morphology beyond the 1-edit
 * fuzzy variants and the URL-byte-budget candidate cap behave exactly as in
 * production. Only difference: relevance RANKING is not replayed (not
 * needed for a zero/non-zero decision).
 *
 * Contract: nothing is written to the DB, no cron, no UI; output is a
 * markdown table on stdout. The VERCEL_TOKEN is read from .env.local and is
 * never printed. Queries are PII-sanitized client-side already
 * (sanitizeSearchQuery); this script adds no PII.
 *
 * Usage: node scripts/zero-result-report.ts [days=30]
 * Exit:  0 = report printed, 1 = configuration/API failure (no report).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env.local only (same pattern as the other scripts) — no secrets are
// printed anywhere below.
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const VERCEL_API = 'https://api.vercel.com';
/** Mirrors ELIGIBLE_COUNT_SELECT in app/lib/catalog.ts (not exported there). */
const ELIGIBLE_COUNT_SELECT = 'id, images:product_images!inner(id)';
/** Grouped-dimension row cap of the events/aggregate endpoint. */
const AGGREGATE_LIMIT = 100;
const PROJECT_NAME = 'towary-dla-domu';

// Pure catalog search helpers — loaded in main() AFTER .env.local is on
// process.env: importing app/lib/catalog.ts constructs its module-level
// Supabase client from NEXT_PUBLIC_* at import time, so a static import
// would run before the .env.local loader below and throw.
let buildSearchConditions: (search: string) => string[] | null;
let relaxSearchTerm: (search: string) => string[];
let buildFuzzyFallbackPlan: (
  search: string
) => import('../app/lib/catalog.ts').FuzzyFallbackPlan | null;

type AggregateRow = { 'eventData/query'?: string; count?: number };
type AggregateResponse = { data?: AggregateRow[] };
type CountResponse = { data?: { count?: number } };

function fail(message: string): never {
  console.error(`zero-result-report: ${message}`);
  process.exit(1);
}

/** GET with Bearer auth; returns parsed JSON or fails with status + body head. */
async function apiGet<T>(url: string, params: Record<string, string>): Promise<T> {
  const token = process.env.VERCEL_TOKEN ?? '';
  if (!token) fail('VERCEL_TOKEN is not set in .env.local');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bodyText = await res.text();
  if (!res.ok) {
    fail(
      `GET ${url} failed: HTTP ${res.status}: ${bodyText.slice(0, 300)}`
    );
  }
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    fail(`GET ${url} returned non-JSON response`);
  }
}

/**
 * Resolve team/project scope. Explicit VERCEL_TEAM_ID/VERCEL_PROJECT_ID env
 * vars win; otherwise the project list is fetched and the target project is
 * picked UNAMBIGUOUSLY (single project, or exactly one named match).
 */
async function resolveScope(): Promise<{ teamId?: string; projectId: string }> {
  const teamId = process.env.VERCEL_TEAM_ID || undefined;
  const explicitProject = process.env.VERCEL_PROJECT_ID || undefined;
  if (teamId && explicitProject) return { teamId, projectId: explicitProject };

  const params: Record<string, string> = { limit: '20' };
  if (teamId) params.teamId = teamId;
  const res = await apiGet<{ projects?: { id: string; name: string }[] }>(
    `${VERCEL_API}/v9/projects`,
    params
  );
  const projects = res.projects ?? [];
  if (projects.length === 0) fail('No projects visible to VERCEL_TOKEN');
  const matches = projects.filter((p) => p.name === PROJECT_NAME);
  const picked =
    matches.length === 1
      ? matches[0]
      : projects.length === 1
        ? projects[0]
        : undefined;
  if (!picked) {
    fail(
      `Could not unambiguously pick the project: visible projects are ` +
        `[${projects.map((p) => p.name).join(', ')}] — expected exactly one ` +
        `named ${PROJECT_NAME}. Set VERCEL_PROJECT_ID (and VERCEL_TEAM_ID) ` +
        `in .env.local to disambiguate.`
    );
  }
  return { teamId, projectId: picked.id };
}

/**
 * Events/aggregate grouped by one eventData dimension. Boolean comparisons
 * use QUOTED literals ('false'/'true') — bare `false`/`true` trigger an
 * API-side HTTP 500 (verified 2026-09-05). Missing-field comparison uses
 * `eq null`, which works and is how historical (pre-flag) events are
 * selected.
 */
async function fetchAggregate(
  scope: { teamId?: string; projectId: string },
  since: string,
  until: string,
  filter: string
): Promise<Map<string, number>> {
  const res = await apiGet<AggregateResponse>(
    `${VERCEL_API}/v1/query/web-analytics/events/aggregate`,
    {
      ...(scope.teamId ? { teamId: scope.teamId } : {}),
      projectId: scope.projectId,
      since,
      until,
      by: 'eventData/query',
      filter,
      limit: String(AGGREGATE_LIMIT),
    }
  );
  const out = new Map<string, number>();
  for (const row of res.data ?? []) {
    const query = row['eventData/query'];
    if (typeof query !== 'string' || query === '' || query === 'Others') continue;
    out.set(query, row.count ?? 0);
  }
  return out;
}

/** Total count of `search` events in the window (events/count endpoint). */
async function fetchEventCount(
  scope: { teamId?: string; projectId: string },
  since: string,
  until: string
): Promise<number> {
  const res = await apiGet<CountResponse>(
    `${VERCEL_API}/v1/query/web-analytics/events/count`,
    {
      ...(scope.teamId ? { teamId: scope.teamId } : {}),
      projectId: scope.projectId,
      since,
      until,
      filter: `eventName eq 'search'`,
    }
  );
  return res.data?.count ?? 0;
}

// ---- DB replay (read-only) -------------------------------------------------

/**
 * Reproduce the fetchCatalogProducts count pipeline for one raw query:
 * exact conditions → relaxSearchTerm trim ladder → buildFuzzyFallbackPlan
 * probe (same order, same replace-don't-add semantics). Returns the total
 * the user would have seen (0 = zero-result view).
 */
async function replaySearchCount(
  supabase: SupabaseClient,
  rawQuery: string
): Promise<number> {
  const countWith = async (conditions: string[] | null): Promise<number> => {
    let q = supabase
      .from('products')
      .select(ELIGIBLE_COUNT_SELECT, { count: 'exact', head: true })
      .eq('is_active', true);
    if (conditions) {
      for (const condition of conditions) {
        q = q.or(condition);
      }
    }
    const { count, error } = await q;
    if (error) throw new Error(`replay count failed: ${error.message}`);
    return count ?? 0;
  };

  let total = await countWith(buildSearchConditions(rawQuery));
  if (total === 0) {
    for (const relaxedTerm of relaxSearchTerm(rawQuery)) {
      const relaxedConditions = buildSearchConditions(relaxedTerm);
      if (!relaxedConditions) continue;
      total = await countWith(relaxedConditions);
      if (total > 0) return total;
    }
  }
  if (total === 0) {
    const plan = buildFuzzyFallbackPlan(rawQuery);
    if (plan) total = await countWith(plan.conditions);
  }
  return total;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function main(): Promise<void> {
  const daysArg = process.argv[2] ?? '30';
  const days = Number.parseInt(daysArg, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    fail(`days must be an integer in 1..365, got "${daysArg}"`);
  }

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);

  // Pure catalog search helpers — dynamic import AFTER .env.local is on
  // process.env: importing app/lib/catalog.ts constructs its module-level
  // Supabase client from NEXT_PUBLIC_* at import time, so a static import
  // would run before the .env.local loader and throw. Needed before any
  // replaySearchCount call below.
  const catalog = await import('../app/lib/catalog.ts');
  buildSearchConditions = catalog.buildSearchConditions;
  relaxSearchTerm = catalog.relaxSearchTerm;
  buildFuzzyFallbackPlan = catalog.buildFuzzyFallbackPlan;

  const scope = await resolveScope();

  // Three windowed aggregates: everything, flag-explicit zeros, flag-explicit
  // founds. Events with NO hasResults field (historical) are those left over:
  // unknown = all − flagZero − flagTrue (floored at 0, in case the quoted-
  // literal matching ever drifts from the real boolean semantics).
  const [all, flagZero, flagTrue, totalEvents] = await Promise.all([
    fetchAggregate(scope, iso(since), iso(until), `eventName eq 'search'`),
    fetchAggregate(
      scope,
      iso(since),
      iso(until),
      `eventName eq 'search' and eventData/hasResults eq 'false'`
    ),
    fetchAggregate(
      scope,
      iso(since),
      iso(until),
      `eventName eq 'search' and eventData/hasResults eq 'true'`
    ),
    fetchEventCount(scope, iso(since), iso(until)),
  ]);

  if (all.size >= AGGREGATE_LIMIT) {
    console.error(
      `warning: aggregate hit the ${AGGREGATE_LIMIT}-row cap — top-value ` +
        `grouping may have folded rare queries into "Others"`
    );
  }

  // Service-role Supabase client, used ONLY for .select() count queries.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    fail('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  interface ZeroRow {
    query: string;
    count: number;
    flagCount: number;
    replayCount: number;
    replayResults: number | null;
  }
  const rows: ZeroRow[] = [];

  for (const [query, allCount] of all) {
    const flagCount = flagZero.get(query) ?? 0;
    const foundCount = flagTrue.get(query) ?? 0;
    const unknownCount = Math.max(0, allCount - flagCount - foundCount);
    if (flagCount === 0 && unknownCount === 0) continue;

    // Replay ALWAYS (both for unknown-event queries and as a sanity check
    // for flag-explicit zeros): count queries are head-only and cheap.
    let replayResults: number | null = null;
    try {
      replayResults = await replaySearchCount(supabase, query);
    } catch (err) {
      console.error(
        `warning: replay failed for "${query}": ${
          err instanceof Error ? err.message : String(err)
        } (row reported with replay=n/a)`
      );
    }

    const replayIsZero = replayResults === 0;
    const unknownZeroPart = replayIsZero ? unknownCount : 0;
    const totalCount = flagCount + unknownZeroPart;
    if (totalCount === 0) continue;
    rows.push({
      query,
      count: totalCount,
      flagCount,
      replayCount: unknownZeroPart,
      replayResults,
    });
  }

  rows.sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));

  // ---- stdout report ----
  console.log(
    `# Zero-result search queries — last ${days} days ` +
      `(${iso(since)} … ${iso(until)})`
  );
  console.log('');
  console.log('| query | раз | источник (flag/replay) | результатов replay |');
  console.log('| --- | ---: | --- | ---: |');
  for (const row of rows) {
    const source =
      row.flagCount > 0 && row.replayCount > 0
        ? 'flag+replay'
        : row.flagCount > 0
          ? 'flag'
          : 'replay';
    const replayCell = row.replayResults === null ? 'n/a' : String(row.replayResults);
    console.log(
      `| ${mdCell(row.query)} | ${row.count} | ${source} | ${replayCell} |`
    );
  }
  if (rows.length === 0) {
    console.log('| — | 0 | — | — |');
  }
  console.log('');
  console.log(
    `Итог: всего событий search — ${totalEvents}; уникальных запросов — ${all.size}; ` +
      `zero-result запросов — ${rows.length} ` +
      `(событий zero-result — ${rows.reduce((s, r) => s + r.count, 0)}).`
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
