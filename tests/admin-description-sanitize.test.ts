/**
 * Security invariant (audit 2026-08-31, issue #1): products.description is
 * rendered on the storefront via dangerouslySetInnerHTML (ProductDescription),
 * so EVERY writer of this column must pass it through the same allowlist
 * sanitizer used at import/staging time (sanitizeYcDescription).
 * Admin create/update routes are enforced here as source-invariant tests
 * (same convention as tests/admin-products-multicat.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const putRoute = () => readFileSync('app/api/admin/products/[id]/route.ts', 'utf8');
const postRoute = () => readFileSync('app/api/admin/products/route.ts', 'utf8');

const SANITIZER_IMPORT = /import \{ sanitizeYcDescription \} from ['"]@\/app\/lib\/yugcontract\/content-sanitize['"]/;

test('ADMIN-DESCRIPTION: PUT sanitizes description with the existing allowlist sanitizer', () => {
  const s = putRoute();
  assert.match(s, SANITIZER_IMPORT, 'PUT route must import sanitizeYcDescription');
  assert.doesNotMatch(
    s,
    /patch\.description\s*=\s*strOrNull\(body\.description\)/,
    'raw description must never reach the DB un-sanitized'
  );
  assert.match(
    s,
    /patch\.description\s*=\s*rawDescription\s*===\s*null\s*\?\s*null\s*:\s*sanitizeYcDescription\(rawDescription\)/,
    'PUT must sanitize non-null description and keep explicit null'
  );
});

test('ADMIN-DESCRIPTION: POST (create) sanitizes description with the existing allowlist sanitizer', () => {
  const s = postRoute();
  assert.match(s, SANITIZER_IMPORT, 'POST route must import sanitizeYcDescription');
  assert.doesNotMatch(
    s,
    /description:\s*strOrNull\(body\.description\)/,
    'raw description must never reach the DB un-sanitized'
  );
  assert.match(
    s,
    /description:\s*rawDescription\s*===\s*null\s*\?\s*null\s*:\s*sanitizeYcDescription\(rawDescription\)/,
    'POST must sanitize non-null description and keep explicit null'
  );
});

