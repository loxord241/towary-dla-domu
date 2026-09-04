/**
 * LiqPay reconciliation keyset pagination — composite cursor contract.
 *
 * Bug under test (2026-09-01 audit, issue #5): both reconciliation paths
 * sort by (created_at ASC, order_number ASC) but advanced the cursor with
 * a plain `.gt('created_at', last.created_at)`. When a group of orders
 * sharing one created_at (rows inserted in a single statement get the same
 * DEFAULT NOW()) straddles a page boundary, the tail of that group is
 * skipped forever — a silent gap in payment reconciliation.
 *
 * Fix contract: next page = created_at > T OR (created_at = T AND
 * order_number > N), expressed as a PostgREST or() filter with quoted
 * values. order_number is UNIQUE (idx_orders_order_number), so the tuple
 * is a total order: no skips, no re-processing.
 *
 * Both paths must behave identically, so the functional test drives an
 * in-memory PostgREST simulation with the ACTUAL or() template extracted
 * from each source file (drift in either file fails CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const SCRIPT = 'scripts/reconcile-liqpay.mts';
const ROUTE = 'app/api/admin/orders/reconciliation/route.ts';

// ---------------------------------------------------------------------------
// or() template extraction — the pagination predicate as written in source
// ---------------------------------------------------------------------------

function extractOrTemplate(source: string, file: string): string {
  const m = source.match(/q\.or\(\s*`([^`]+)`\s*\)/);
  assert.ok(
    m,
    `${file}: keyset pagination must build the composite cursor via q.or(\`...\`) ` +
      `(next page = created_at > T OR (created_at = T AND order_number > N))`
  );
  const template = m[1];
  assert.ok(template !== undefined, 'capture group must hold the or() template');
  return template;
}

function instantiate(
  template: string,
  cursor: { createdAt: string; orderNumber: string }
): string {
  return template
    .replaceAll('${cursor.createdAt}', cursor.createdAt)
    .replaceAll('${cursor.orderNumber}', cursor.orderNumber);
}

// ---------------------------------------------------------------------------
// Minimal PostgREST or-filter evaluator (subset used by the cursor:
// col.eq."v" / col.gt."v" / and(...) over created_at + order_number)
// ---------------------------------------------------------------------------

type Row = { created_at: string; order_number: string };

function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (const ch of expr) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Timestamps compare numerically (DB may mix Z / +00:00 formats). */
function compare(col: keyof Row, rowVal: string, rawVal: string): number {
  if (col === 'created_at') {
    const a = Date.parse(rowVal);
    const b = Date.parse(rawVal);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return rowVal < rawVal ? -1 : rowVal > rawVal ? 1 : 0;
}

function evalTerm(row: Row, term: string): boolean {
  const t = term.trim();
  const andMatch = t.match(/^and\((.+)\)$/);
  if (andMatch) {
    const terms = andMatch[1];
    assert.ok(terms !== undefined, 'and(...) must capture its terms');
    return splitTopLevel(terms).every((inner) => evalTerm(row, inner));
  }
  const m = t.match(/^(created_at|order_number)\.(eq|gt|gte)\."(.*)"$/);
  assert.ok(m, `unsupported predicate term (cursor filter drift?): ${t}`);
  const [, col, op, value] = m as unknown as [string, keyof Row, 'eq' | 'gt' | 'gte', string];
  const c = compare(col, row[col], value);
  if (op === 'eq') return c === 0;
  if (op === 'gt') return c > 0;
  return c >= 0;
}

function evalOr(row: Row, expr: string): boolean {
  return splitTopLevel(expr).some((t) => evalTerm(row, t));
}

// ---------------------------------------------------------------------------
// In-memory PostgREST simulation of the pagination loop
// (created_at >= from, ordered by created_at, order_number, page window)
// ---------------------------------------------------------------------------

interface FixtureOrder extends Row {
  liqpay_order_id: string;
}

function paginateAll(
  orders: FixtureOrder[],
  template: string,
  pageSize: number
): string[] {
  const sorted = [...orders].sort(
    (a, b) =>
      compare('created_at', a.created_at, b.created_at) ||
      compare('order_number', a.order_number, b.order_number)
  );
  const FROM = '2026-08-01T00:00:00+00:00';
  const out: string[] = [];
  let cursor: { createdAt: string; orderNumber: string } | null = null;
  for (;;) {
    let page = sorted.filter((r) => Date.parse(r.created_at) >= Date.parse(FROM));
    if (cursor) page = page.filter((r) => evalOr(r, instantiate(template, cursor!)));
    page = page.slice(0, pageSize);
    if (page.length === 0) break;
    for (const r of page) out.push(r.order_number);
    const last = page[page.length - 1];
    assert.ok(last !== undefined, 'page must be non-empty to advance the cursor');
    cursor = { createdAt: last.created_at, orderNumber: last.order_number };
  }
  return out;
}

// Fixture: a group of FIVE orders sharing created_at "11:00" straddles the
// page-1/page-2 boundary (page size 5). A created_at-only cursor skips
// rows 6-8; the composite cursor must yield every order exactly once.
// Timestamps use the +00:00 offset form that supabase-js actually returns.
const FIXTURE: FixtureOrder[] = [
  { order_number: 'ORD-260830-0001', liqpay_order_id: 'lp1', created_at: '2026-08-30T10:00:00+00:00' },
  { order_number: 'ORD-260830-0002', liqpay_order_id: 'lp2', created_at: '2026-08-30T10:05:00+00:00' },
  { order_number: 'ORD-260830-0003', liqpay_order_id: 'lp3', created_at: '2026-08-30T10:10:00+00:00' },
  { order_number: 'ORD-260830-0004', liqpay_order_id: 'lp4', created_at: '2026-08-30T11:00:00+00:00' },
  { order_number: 'ORD-260830-0005', liqpay_order_id: 'lp5', created_at: '2026-08-30T11:00:00+00:00' },
  { order_number: 'ORD-260830-0006', liqpay_order_id: 'lp6', created_at: '2026-08-30T11:00:00+00:00' },
  { order_number: 'ORD-260830-0007', liqpay_order_id: 'lp7', created_at: '2026-08-30T11:00:00+00:00' },
  { order_number: 'ORD-260830-0008', liqpay_order_id: 'lp8', created_at: '2026-08-30T11:00:00+00:00' },
  { order_number: 'ORD-260830-0009', liqpay_order_id: 'lp9', created_at: '2026-08-30T12:00:00+00:00' },
  { order_number: 'ORD-260830-0010', liqpay_order_id: 'lp10', created_at: '2026-08-30T12:30:00+00:00' },
  { order_number: 'ORD-260830-0011', liqpay_order_id: 'lp11', created_at: '2026-08-30T13:00:00+00:00' },
  { order_number: 'ORD-260830-0012', liqpay_order_id: 'lp12', created_at: '2026-08-30T13:00:00+00:00' },
  { order_number: 'ORD-260830-0013', liqpay_order_id: 'lp13', created_at: '2026-08-30T14:00:00+00:00' },
  { order_number: 'ORD-260830-0014', liqpay_order_id: 'lp14', created_at: '2026-08-30T15:00:00+00:00' },
];
const EXPECTED_ALL = FIXTURE.map((o) => o.order_number).sort();
const PAGE_SIZE = 5;

// ---------------- functional: every order processed exactly once ----------------

test('RECON-PAGE: script pagination yields every order exactly once across a same-timestamp page boundary', () => {
  const template = extractOrTemplate(src(SCRIPT), SCRIPT);
  const got = paginateAll(FIXTURE, template, PAGE_SIZE);
  assert.deepEqual([...got].sort(), EXPECTED_ALL);
  assert.equal(new Set(got).size, got.length, 'no order may be processed twice');
  assert.equal(got.length, FIXTURE.length);
});

test('RECON-PAGE: admin API pagination yields every order exactly once across a same-timestamp page boundary', () => {
  const template = extractOrTemplate(src(ROUTE), ROUTE);
  const got = paginateAll(FIXTURE, template, PAGE_SIZE);
  assert.deepEqual([...got].sort(), EXPECTED_ALL);
  assert.equal(new Set(got).size, got.length, 'no order may be processed twice');
  assert.equal(got.length, FIXTURE.length);
});

test('RECON-PAGE: both reconciliation paths share one identical composite-cursor template', () => {
  const scriptTemplate = extractOrTemplate(src(SCRIPT), SCRIPT);
  const routeTemplate = extractOrTemplate(src(ROUTE), ROUTE);
  assert.equal(scriptTemplate, routeTemplate, 'identical cursor semantics required');
});

// ---------------- structural invariants ----------------

test('RECON-PAGE: composite predicate present, plain gt(created_at) cursor gone (script + route)', () => {
  for (const file of [SCRIPT, ROUTE]) {
    const s = src(file);
    assert.match(s, /q\.or\(\s*`created_at\.gt\./, `${file}: composite cursor missing`);
    assert.match(s, /created_at\.eq\./, `${file}: tuple tie-break branch missing`);
    assert.match(s, /order_number\.gt\./, `${file}: order_number tie-break missing`);
    // The buggy predicate must not survive anywhere in the file.
    assert.doesNotMatch(s, /\.gt\('created_at'/, `${file}: created_at-only cursor still present`);
  }
});

test('RECON-PAGE: ordering preserved as (created_at ASC, order_number ASC) in both paths', () => {
  for (const file of [SCRIPT, ROUTE]) {
    const s = src(file);
    const ia = s.indexOf(".order('created_at')");
    const ib = s.indexOf(".order('order_number')");
    assert.ok(ia !== -1 && ib !== -1 && ia < ib, `${file}: order(created_at) then order(order_number) required`);
  }
});
