/**
 * One-off maintenance (2026-09-15): collapse accidentally duplicated
 * sentences/items in approved generated descriptions (Phase-2 rewrite QA
 * finding: a boolean fact repeated both as a phrase and inside the
 * Оснащення enumeration rendered back-to-back twice).
 *
 * Idempotent: run until it reports 0 changed. Only rows with an approved
 * draft are touched; products.description is kept in sync with the draft.
 *
 *   set -a; source .env.local; set +a
 *   node scripts/dedupe-descriptions.ts
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

try {
  for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && m[2] !== undefined && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
} catch {}

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

/** Drop consecutive duplicate sentences/items + tidy punctuation. */
function dedupeHtml(html: string): string {
  const p = html.match(/^<p>([\s\S]*)<\/p>$/);
  if (p?.[1]) {
    const inner = p[1];
    const sentences = inner.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s, i) => i === 0 || s !== sentences[i - 1]);
    let out = `<p>${kept.join(' ')}</p>`;
    out = out.replace(/;+\./g, '.').replace(/\.{2,}/g, '.');
    return out;
  }
  const ul = html.match(/^(<ul>)([\s\S]*)(<\/ul>)$/);
  if (ul?.[1] && ul[2] !== undefined && ul[3] !== undefined) {
    const [open, body, close] = [ul[1], ul[2], ul[3]] as const;
    const items = body.match(/<li>[\s\S]*?<\/li>/g) ?? [];
    const kept: string[] = [];
    let prev: string | undefined;
    for (const li of items) {
      if (li === prev) continue;
      kept.push(li);
      prev = li;
    }
    let out = `${open}${kept.join('')}${close}`;
    out = out.replace(/;+\./g, '.').replace(/\.{2,}/g, '.');
    return out;
  }
  return html;
}

const BATCH = 300;
let cursor = 0;
let scanned = 0;
let totalFixed = 0;

for (let loop = 0; loop < 40; loop++) {
  const { data, error } = await svc
    .from('product_description_drafts')
    .select('product_id, description_text')
    .eq('status', 'approved')
    .order('product_id')
    .range(cursor, cursor + BATCH - 1);
  if (error) {
    console.error('read failed:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as { product_id: string; description_text: string }[];
  if (rows.length === 0) break;

  for (const row of rows) {
    const fixed = dedupeHtml(row.description_text);
    if (fixed === row.description_text) continue;
    const { error: dErr } = await svc
      .from('product_description_drafts')
      .update({ description_text: fixed })
      .eq('product_id', row.product_id);
    if (dErr) {
      console.error(`draft ${row.product_id} update failed:`, dErr.message);
      continue;
    }
    const { error: pErr } = await svc
      .from('products')
      .update({ description: fixed })
      .eq('id', row.product_id);
    if (pErr) {
      console.error(`product ${row.product_id} update failed:`, pErr.message);
      continue;
    }
    totalFixed++;
  }
  scanned += rows.length;
  cursor += rows.length;
  if (rows.length < BATCH) break;
}

console.log(`done: ${totalFixed} descriptions deduped, ${scanned} scanned`);
