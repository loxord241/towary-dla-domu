/**
 * Admin API guard invariants (2026-08-27 security stage).
 *
 * Every route handler under app/api/admin/** MUST gate on
 * requireAdminApi() before touching privileged state: the helper is the
 * single server-side entry point that (1) validates the caller JWT,
 * (2) verifies the admin_users row and only then (3) exposes the
 * service-role client.
 *
 * This test walks the filesystem DYNAMICALLY instead of pinning a fixed
 * list of files, so a newly added admin route without a guard fails CI
 * automatically. There are currently NO exceptions to the rule; if one
 * is ever introduced it must be added to DOCUMENTED_GUARD_EXEMPTIONS
 * with a written justification reviewed at GO time.
 *
 * The reconciliation route lives under this tree as well and must stay
 * GET-only on top of the shared guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Documented guard exemptions — empty by policy. */
const DOCUMENTED_GUARD_EXEMPTIONS: string[] = [];

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRouteFiles(full));
    else if (entry.isFile() && entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** Extract `export async function NAME(...)` handler bodies from source. */
function exportedHandlers(source: string): Array<{ name: string; body: string }> {
  const handlers: Array<{ name: string; body: string }> = [];
  const re = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // Skip the balanced parameter list (signatures use destructured
    // objects like { params }: { params: Promise<...> }) to locate the
    // real opening brace of the function body.
    let i = source.indexOf('(', match.index);
    if (i === -1) continue;
    let parenDepth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '(') parenDepth++;
      else if (source[i] === ')') {
        parenDepth--;
        if (parenDepth === 0) break;
      }
    }
    i = source.indexOf('{', i);
    if (i === -1) continue;
    let depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const name = match[1];
    assert.ok(name !== undefined, 'regex group 1 must capture the handler name');
    handlers.push({ name, body: source.slice(match.index, i) });
  }
  return handlers;
}

function rel(path: string): string {
  return path.slice(root.length + 1).replaceAll('\\', '/');
}

test('ADMIN-GUARD: every app/api/admin route file is discovered dynamically', () => {
  const files = listRouteFiles(join(root, 'app/api/admin'));
  assert.ok(files.length > 0, 'admin routes directory must not be empty');
  assert.ok(
    files.some((f) => f.endsWith('orders/reconciliation/route.ts')),
    'the reconciliation route must exist and be part of the guarded set'
  );
});

test('ADMIN-GUARD: every HTTP handler in every admin route gates on requireAdminApi()', () => {
  const files = listRouteFiles(join(root, 'app/api/admin'));
  const violations: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const handlers = exportedHandlers(src)
      .filter((h) => (HTTP_METHODS as readonly string[]).includes(h.name));

    if (handlers.length === 0) {
      violations.push(`${rel(file)}: no HTTP method handler exported at all`);
      continue;
    }

    for (const handler of handlers) {
      const exempted =
        DOCUMENTED_GUARD_EXEMPTIONS.includes(rel(file)) ||
        DOCUMENTED_GUARD_EXEMPTIONS.includes(`${rel(file)}#${handler.name}`);
      if (exempted) continue;
      if (!handler.body.includes('requireAdminApi')) {
        violations.push(
          `${rel(file)}#${handler.name}: missing requireAdminApi() gate`
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('ADMIN-GUARD: reconciliation route stays GET-only', () => {
  const src = readFileSync(
    join(root, 'app/api/admin/orders/reconciliation/route.ts'),
    'utf8'
  );
  const handlerNames = exportedHandlers(src)
    .map((h) => h.name)
    .filter((n) => (HTTP_METHODS as readonly string[]).includes(n));
  assert.deepEqual(handlerNames, ['GET']);
});
