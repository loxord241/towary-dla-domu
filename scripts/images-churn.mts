/**
 * Images-churn measurement (read-only) — diagnostics for the audit P2:
 * each sync's images phase was rewriting ~12-13k product_images rows.
 * Hypothesis: the supplier shuffles pictures[] order between fetches, so
 * the canonical sort_order/is_main (derived from list index) flip wholesale.
 *
 * Usage:
 *   node scripts/images-churn.mts --save               # BEFORE sync: snapshot to logs/images-churn-<ts>.json
 *   node scripts/images-churn.mts --compare <file>     # AFTER sync: diff current state against a snapshot
 *
 * Read-only: only .select() via service-role; snapshots live in logs/ (gitignored).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function currentState() {
  const state: Record<string, string[]> = {};
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('product_images')
      .select('product_id, image_url, sort_order, is_main')
      .order('product_id')
      .order('sort_order', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`select failed: ${error.message}`);
    for (const r of data ?? []) {
      const pid = String(r.product_id);
      (state[pid] ??= []).push(`${r.is_main ? 'M' : '-'}:${r.image_url}`);
    }
    if ((data ?? []).length < 1000) break;
    from += 1000;
  }
  return state;
}

const mode = process.argv[2];
if (mode === '--save') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(root, 'logs', `images-churn-${ts}.json`);
  const state = await currentState();
  writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), state }));
  console.log(`snapshot: ${Object.keys(state).length} products -> ${path.basename(file)}`);
} else if (mode === '--compare') {
  const file = process.argv[3];
  if (!file || !existsSync(file)) { console.error('usage: --compare logs/images-churn-<ts>.json'); process.exit(2); }
  const before = JSON.parse(readFileSync(file, 'utf8')).state as Record<string, string[]>;
  const after = await currentState();
  let same = 0, changed = 0, added = 0, removed = 0;
  const changedSamples: string[] = [];
  for (const [pid, imgs] of Object.entries(before)) {
    if (!after[pid]) { removed++; continue; }
    if (imgs.join('\n') === after[pid].join('\n')) same++;
    else { changed++; if (changedSamples.length < 5) changedSamples.push(pid); }
  }
  for (const pid of Object.keys(after)) if (!before[pid]) added++;
  console.log(`products: same=${same} changedOrderOrMain=${changed} added=${added} removed=${removed}`);
  console.log(`changed samples: ${changedSamples.join(', ') || '—'}`);
  console.log(changed === 0 ? 'NO CHURN — images phase converged.' : 'CHURN CONFIRMED — investigate pictures[] order determinism.');
} else {
  console.error('usage: --save | --compare <snapshot.json>');
  process.exit(2);
}
