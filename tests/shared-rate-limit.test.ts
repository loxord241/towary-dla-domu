/**
 * Shared (cross-instance) rate limiting — 2026-09-13, owner-approved
 * «7. делай что лучше».
 *
 * The in-process window (app/lib/rate-limit.ts) stays as the cheap first
 * line; the authoritative decision moved into Postgres
 * (migration 047: rate_limit_hits + rate_limit_hit RPC). Covered here:
 *   - migration contract (table, RPC, RLS/revoke, sweep, VERIFY markers);
 *   - rules payload mapping (ms → sec, same order);
 *   - decision mapping (allowed/retry) over a stubbed RPC seam;
 *   - fail-open on any RPC failure (in-memory decision stands);
 *   - identifier never stored raw (HMAC, domain-separated);
 *   - async wiring of both entry points (enforceRateLimit / ByKey).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const shared = await import(
  pathToFileURL(path.join(root, 'app/lib/rate-limit-shared.ts')).href
) as typeof import('../app/lib/rate-limit-shared.ts');

const MIGRATION = src('database/migrations/047_shared_rate_limit.sql');
const LIB = src('app/lib/rate-limit.ts');

test('MIGRATION 047: table + RPC + sweep exist, clients get no table access', () => {
  assert.match(MIGRATION, /create table if not exists public\.rate_limit_hits/);
  assert.match(MIGRATION, /create or replace function public\.rate_limit_hit\(/);
  assert.match(MIGRATION, /enable row level security/);
  assert.match(
    MIGRATION,
    /revoke all on public\.rate_limit_hits from anon, authenticated/
  );
  assert.match(MIGRATION, /create or replace function public\.rate_limit_sweep\(/);
  assert.match(MIGRATION, /VERIFY-PRE/);
  assert.match(MIGRATION, /VERIFY-POST/);
});

test('PAYLOAD: rules map to RPC jsonb (max + window_sec, order preserved)', () => {
  assert.deepEqual(
    shared.sharedRulesPayload([
      { max: 5, windowMs: 60_000 },
      { max: 20, windowMs: 60 * 60_000 },
    ]),
    [
      { max: 5, window_sec: 60 },
      { max: 20, window_sec: 3600 },
    ]
  );
  assert.deepEqual(shared.sharedRulesPayload([{ max: 120, windowMs: 60_000 }]), [
    { max: 120, window_sec: 60 },
  ]);
});

test('HASH: IP identifier is HMAC-hashed with a domain-separated key, never stored raw', () => {
  const a = shared.rateLimitIpHash('203.0.113.7', 'secret');
  const b = shared.rateLimitIpHash('203.0.113.8', 'secret');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(shared.rateLimitIpHash('203.0.113.7', 'secret'), a, 'deterministic');
  assert.doesNotMatch(a, /203\.0\.113/);
  // a different secret yields a different hash (domain separation matters)
  assert.notEqual(a, shared.rateLimitIpHash('203.0.113.7', 'other'));
});

type RpcCall = { fn: string; args: Record<string, unknown> };

function stubRpc(response: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  const calls: RpcCall[] = [];
  const rpc = async (
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }> => {
    calls.push({ fn, args });
    return { data: response.data ?? null, error: response.error ?? null };
  };
  return {
    rpc: rpc as unknown as Parameters<typeof shared.sharedRateDecision>[0],
    calls,
  };
}

const RULES = [
  { max: 3, windowMs: 60_000 },
  { max: 10, windowMs: 60 * 60_000 },
];

test('DECISION: allowed → ok with retry 0; denied → retry from RPC', async () => {
  const allow = stubRpc({ data: { allowed: true, retry_after_sec: 0 } });
  const d1 = await shared.sharedRateDecision(allow.rpc, 'orders', RULES, '1.2.3.4', 'secret');
  assert.deepEqual(d1, { ok: true, retryAfterSec: 0 });
  assert.equal(allow.calls.length, 1);
  assert.equal(allow.calls[0]!.fn, 'rate_limit_hit');
  assert.equal(allow.calls[0]!.args.p_name, 'orders');
  assert.deepEqual(allow.calls[0]!.args.p_rules, [
    { max: 3, window_sec: 60 },
    { max: 10, window_sec: 3600 },
  ]);
  const hash = String(allow.calls[0]!.args.p_ip_hash);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, shared.rateLimitIpHash('1.2.3.4', 'other-secret'));

  const deny = stubRpc({ data: { allowed: false, retry_after_sec: 42 } });
  const d2 = await shared.sharedRateDecision(deny.rpc, 'lookup', RULES, '1.2.3.4', 'secret');
  assert.deepEqual(d2, { ok: false, retryAfterSec: 42 });
});

test('FAIL-OPEN: RPC error or garbage shape keeps the request allowed', async () => {
  const err = stubRpc({ error: { message: 'connection refused' } });
  assert.deepEqual(
    await shared.sharedRateDecision(err.rpc, 'orders', RULES, 'x', 'secret'),
    { ok: true, retryAfterSec: 0 }
  );

  const garbage = stubRpc({ data: { weird: true } });
  assert.deepEqual(
    await shared.sharedRateDecision(garbage.rpc, 'orders', RULES, 'x', 'secret'),
    { ok: true, retryAfterSec: 0 }
  );
});

test('WIRING: both entry points are async and consult the shared layer', () => {
  assert.match(LIB, /export async function enforceRateLimitByKey\(/);
  assert.match(LIB, /export async function enforceRateLimit\(/);
  assert.match(LIB, /if \(!local\.ok\) return local;/);
  assert.match(LIB, /return sharedRateDecision\(/);
  // fail-open documented at the decision site
  assert.match(src('app/lib/rate-limit-shared.ts'), /fail open/);
});
