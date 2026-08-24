/** One-off READ-ONLY verification that migration 009 landed correctly. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: key, Authorization: `Bearer ${key}` };

const res = await fetch(`${url}/rest/v1/products?select=id,sku,name,yugcontract_id,is_active&limit=50`, { headers: H });
const rows = await res.json().catch(() => null);
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(rows, null, 2));

const cnt = await fetch(`${url}/rest/v1/products?select=count`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
console.log('content-range:', cnt.headers.get('content-range'));
