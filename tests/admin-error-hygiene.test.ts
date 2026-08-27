/**
 * Admin API error hygiene invariants (2026-08-27 security stage).
 *
 * Raw database / internal exception messages must never reach admin API
 * clients: PostgREST messages expose table, column and constraint names,
 * and parser exceptions can embed fragments of upstream payloads.
 *
 * Enforcement is static: every `*.json({ error: <expr>.message })`
 * response site under app/api/admin/** must either be removed, or (for
 * YugcontractError whose messages are curated, credential-free strings
 * built in app/lib/yugcontract/client.ts) carry the explicit marker
 *   // YUGCONTRACT-CURATED-MESSAGE
 * on its own line directly above the response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_DIR = join(root, 'app/api/admin');

const MARKER = 'YUGCONTRACT-CURATED-MESSAGE';

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRouteFiles(full));
    else if (entry.isFile() && entry.name === 'route.ts') out.push(full);
  }
  return out;
}

test('ERROR-HYGIENE: no admin route returns a raw *.message in an error JSON body', () => {
  const files = listRouteFiles(ADMIN_DIR);
  assert.ok(files.length > 0, 'admin routes directory must not be empty');

  const violations: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    const rel = file.slice(root.length + 1).replaceAll('\\', '/');
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/(?:Response|NextResponse)?\.json\(\s*\{[^}]*\.message/.test(line)) continue;
      const context = lines
        .slice(Math.max(0, i - 3), i + 1)
        .join('\n');
      if (context.includes(MARKER)) continue;
      violations.push({ file: rel, line: i + 1, text: line.trim() });
    }
  }

  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.text}`),
    [],
    'raw error.message must not be returned to admin clients'
  );
});

test('ERROR-HYGIENE: curated YugcontractError sites are explicitly marked', () => {
  // The two intentional pass-throughs must stay visible and justified.
  const cat = readFileSync(join(ADMIN_DIR, 'yugcontract/categories/route.ts'), 'utf8');
  const prev = readFileSync(join(ADMIN_DIR, 'yugcontract/preview/route.ts'), 'utf8');
  assert.match(cat, new RegExp(MARKER), 'categories route must document its curated message');
  assert.match(prev, new RegExp(MARKER), 'preview route must document its curated message');
});
