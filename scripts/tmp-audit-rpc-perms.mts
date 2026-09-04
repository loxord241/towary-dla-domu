/**
 * RPC permission probes — SAFE by construction: every call passes a
 * malformed argument so Postgres fails at PARSE time before any row is
 * touched. No valid arguments = no possible write. Read-only audit.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const { createClient } = await import('@supabase/supabase-js');
const anon: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  { auth: { persistSession: false } }
);

// Malformed payloads: JSONB param must be jsonb-typed — passing a NUMBER
// fails coercion at parse time; int param gets a non-int string.
const cases: [string, Record<string, unknown>][] = [
  ['place_order', { payload: 12345 }],                       // expected: EXECUTABLE (granted) → type error
  ['admin_set_order_status', { p_order_id: 'x', p_new_status: 'x' }],
  ['admin_cancel_order', { p_order_id: 'not-a-uuid' }],
  ['expire_pending_orders', { p_limit: 'not-an-int' }],
];

for (const [fn, args] of cases) {
  const { error } = await anon.rpc(fn, args);
  if (!error) {
    console.log(`${fn}: NO ERROR?! unexpected success — inspect manually`);
  } else if (/permission denied|not found|schema cache|does not exist/i.test(error.message) || error.code === '42501') {
    console.log(`${fn}: DENIED (${error.code}) — ${error.message.slice(0, 90)}`);
  } else {
    // e.g. "invalid input syntax for type jsonb" = function RAN but args rejected
    console.log(`${fn}: REACHED (args rejected: ${error.code}) — ${error.message.slice(0, 90)}`);
  }
}
