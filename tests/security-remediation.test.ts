/**
 * Security remediation invariants (2026-09-02 audit).
 *
 * Covers the audit fixes that are expressible as pure units or as
 * source/SQL invariants:
 *   - escapeIlikePattern: ILIKE wildcard escaping used by the admin guard
 *     (an unescaped `_` let a lookalike email match an admin row).
 *   - no admin check may pass a user email straight into .ilike().
 *   - migration 032: the SQL statements each audit fix depends on.
 *   - importer CLI: the 48h interval gate is keyed to --run/--force/--resume.
 *   - launchers: no EnvironmentFile with secrets; lock + stamp gate in ps1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeIlikePattern } from '../app/lib/ilike.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// escapeIlikePattern
// ---------------------------------------------------------------------------

test('escapeIlikePattern escapes every ILIKE wildcard', () => {
  assert.equal(escapeIlikePattern('support@shop.com'), 'support@shop.com');
  assert.equal(escapeIlikePattern('suppo_t@shop.com'), 'suppo\\_t@shop.com');
  assert.equal(escapeIlikePattern('a%b'), 'a\\%b');
  assert.equal(escapeIlikePattern('a\\b'), 'a\\\\b');
});

test('escaped lookalike email no longer matches the plain admin row', () => {
  // Model Postgres ILIKE semantics: `\_`/`\%`/`\\` are LITERALS, unescaped
  // `_` = any single char, `%` = any run. With the old bug the pattern
  // `suppo_t@shop.com` matched the admin row; with the fix it must not.
  const toMatcher = (pattern: string) => {
    const esc = (ch: string) => ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    let re = '^';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern.charAt(i);
      if (ch === '\\' && i + 1 < pattern.length) {
        re += esc(pattern.charAt(++i)); // escaped wildcard -> literal character
      } else if (ch === '_') {
        re += '.';
      } else if (ch === '%') {
        re += '.*';
      } else {
        re += esc(ch);
      }
    }
    return new RegExp(re + '$', 'i');
  };
  const adminRow = 'support@shop.com';
  // unescaped (the old bug): matches — escalation
  assert.match(adminRow, toMatcher('suppo_t@shop.com'));
  // escaped (the fix): does not match — `\_` is a literal underscore
  assert.doesNotMatch(adminRow, toMatcher(escapeIlikePattern('suppo_t@shop.com')));
  // the real admin email still matches its own escaped pattern
  assert.match(adminRow, toMatcher(escapeIlikePattern(adminRow)));
  // escaped `%` also stops globbing
  assert.doesNotMatch(adminRow, toMatcher(escapeIlikePattern('support@shop.co%')));
});

const ADMIN_AUTH_FILES = [
  'app/lib/admin-api.ts',
  'app/admin/(dashboard)/layout.tsx',
  'app/admin/login/page.tsx',
];

test('no admin check passes a user email straight into .ilike()', () => {
  for (const rel of ADMIN_AUTH_FILES) {
    const src = readFileSync(join(root, rel), 'utf8');
    assert.ok(
      src.includes('escapeIlikePattern'),
      `${rel} must escape the ILIKE pattern`
    );
    assert.ok(
      !/\.ilike\('email',\s*(user\.email|user\.email \?\? '')\)/.test(src),
      `${rel} must not pass the raw email as an ILIKE pattern`
    );
  }
});

// ---------------------------------------------------------------------------
// migration 032 invariants
// ---------------------------------------------------------------------------

function migrationFiles(): string[] {
  return readdirSync(join(root, 'database/migrations'))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

test('migrations are sequentially numbered with no gaps above 030', () => {
  const nums = migrationFiles().map((f) => parseInt(f.slice(0, 3), 10));
  for (let i = 1; i < nums.length; i++) {
    const prev = nums[i - 1];
    const curr = nums[i];
    assert.ok(prev !== undefined && curr !== undefined);
    assert.equal(curr, prev + 1, `gap between ${prev} and ${curr}`);
  }
  // Pinned to the latest migration: 049 (category SEO description drafts)
  // follows 048 (NP status cache), 047 (shared rate limiting),
  // 046 (data-integrity CHECKs), 045 (orders.access_token_hash),
  // 044 (advisors fixes), 043 (restock FK).
  assert.equal(nums[nums.length - 1], 49);
});

const m032 = readFileSync(
  join(root, 'database/migrations/032_security_remediation.sql'),
  'utf8'
);

test('032: admin_users and product_attribute_values are locked to service_role', () => {
  assert.match(m032, /alter table public\.admin_users enable row level security/);
  assert.match(m032, /revoke all on public\.admin_users from anon, authenticated/);
  assert.match(
    m032,
    /alter table public\.product_attribute_values enable row level security/
  );
  assert.match(
    m032,
    /revoke all on public\.product_attribute_values from anon, authenticated/
  );
});

test('032: default world-readable tables are revoked', () => {
  assert.match(
    m032,
    /alter default privileges for role postgres revoke select on tables from public/
  );
});

test('032: is_current_user_admin pins search_path and loses public EXECUTE', () => {
  const fn = m032.slice(m032.indexOf('function public.is_current_user_admin'));
  const body = fn.slice(0, fn.indexOf('product_review_summary'));
  assert.match(body, /set search_path = public/);
  assert.match(body, /revoke execute on function public\.is_current_user_admin\(\) from anon, authenticated/);
});

test('032: shipment plan cap is back to 10 (026 regression)', () => {
  const fn = m032.slice(m032.indexOf('admin_replace_shipment_plan('));
  const body = fn.slice(0, fn.indexOf('place_order'));
  assert.match(body, /jsonb_array_length\(v_parcels\) > 10 then/);
  assert.match(body, /must be an array \(max 10\)/);
  assert.doesNotMatch(body, /jsonb_array_length\(v_parcels\) > 50/);
  // 026's courier-address logic must be preserved (not a revert to 023)
  assert.match(body, /courier address/);
  // parcel-level error prints the parcel index again
  assert.match(body, /parcels\[%\] must be an object', v_j/);
});

test('032: place_order replay is bound to the caller email', () => {
  const fn = m032.slice(m032.indexOf('place_order(payload jsonb, p_idempotency_key'));
  const body = fn.slice(0, fn.indexOf('product_review_summary'));
  // fast-path: select includes email, conflict raise present
  assert.match(body, /select id, order_number, total_amount, currency, email/);
  assert.match(body, /IDEMPOTENCY_KEY_CONFLICT/);
  assert.match(body, /v_replay_email is distinct from v_email/);
  // race-path: bound too
  assert.match(body, /where idempotency_key = v_ik and email = v_email/);
  // business logic untouched: pricing/stock/notify contract intact
  assert.match(body, /'created',\s+false/);
  assert.match(body, /stock_quantity >= v_line\.qty/);
});

test('032: lookup brute-force counter exists and is service-role only', () => {
  assert.match(m032, /create table if not exists public\.failed_lookup_counters/);
  assert.match(
    m032,
    /revoke all on public\.failed_lookup_counters from anon, authenticated/
  );
  assert.match(m032, /grant execute on function public\.record_failed_lookup\(\) to service_role/);
});

test('lookup route consults the shared fail counter', () => {
  const src = readFileSync(join(root, 'app/api/orders/lookup/route.ts'), 'utf8');
  assert.match(src, /failed_lookup_counters/);
  assert.match(src, /record_failed_lookup/);
  assert.match(src, /LOOKUP_FAIL_CAP/);
});

// ---------------------------------------------------------------------------
// importer gate + launchers
// ---------------------------------------------------------------------------

test('importer CLI gates --run on the 48h interval, bypassable by --force', () => {
  const src = readFileSync(join(root, 'scripts/yugcontract-import-run.ts'), 'utf8');
  assert.match(src, /mode === 'run' && !resumeId && !force/);
  assert.match(src, /yc_import_batches/);
  assert.match(src, /--force/);
});

test('systemd units no longer load .env.local into the environment', () => {
  const src = readFileSync(
    join(root, 'scripts/wsl/install-yugcontract-timer.sh'),
    'utf8'
  );
  assert.doesNotMatch(src, /EnvironmentFile=/);
});

test('windows launcher has an exclusive lock and a 48h stamp gate', () => {
  const src = readFileSync(
    join(root, 'scripts/windows/yugcontract-sync.ps1'),
    'utf8'
  );
  assert.match(src, /FileShare\]::None/);
  assert.match(src, /yugcontract-last-success/);
  assert.match(src, /-lt 47/);
});

test('CI stays canonical: no --force in the workflow (repo invariant)', () => {
  const src = readFileSync(
    join(root, '.github/workflows/yugcontract-sync.yml'),
    'utf8'
  );
  // Manual force runs go through the WSL/Windows launchers; CI relies on the
  // importer's DB gate and must not carry any bypass flag.
  assert.doesNotMatch(src, /--force/);
  assert.match(src, /run: node scripts\/yugcontract-import-run\.ts --run\s*$/m);
});

test('launchers forward --force to the importer DB gate (manual GO path)', () => {
  const sh = readFileSync(join(root, 'scripts/wsl/yugcontract-sync.sh'), 'utf8');
  assert.match(sh, /--run \$\{FORCE:\+--force\}/);
  const ps1 = readFileSync(
    join(root, 'scripts/windows/yugcontract-sync.ps1'),
    'utf8'
  );
  assert.match(ps1, /if \(\$Force\) \{ \$importerArgs \+= '--force' \}/);
});

// ---------------------------------------------------------------------------
// client fixes (source invariants — components are not unit-mountable here)
// ---------------------------------------------------------------------------

test('CheckoutForm guards divisions/streets lookups against stale responses', () => {
  // 2026-09-13 mechanical split: the guards' refs/state stay in
  // CheckoutForm.tsx; the settlement click handler (with two of the four
  // fetchDivisionsApi guards) moved to parts/NovaPostDelivery.tsx. Counts
  // run over the combined source so the pin keeps its original strength.
  const form = readFileSync(join(root, 'app/checkout/CheckoutForm.tsx'), 'utf8');
  const npPart = readFileSync(
    join(root, 'app/checkout/parts/NovaPostDelivery.tsx'),
    'utf8'
  );
  const src = `${form}\n${npPart}`;
  assert.match(form, /const divisionsRequestSeq = useRef\(0\)/);
  assert.match(form, /const streetRequestSeq = useRef\(0\)/);
  // every divisions fetch callback checks the sequence before setState
  // (definition at line 1 excluded — only call sites count)
  const divisionsCalls = src.match(/(?<!function )fetchDivisionsApi\(/g)?.length ?? 0;
  assert.equal(divisionsCalls, 2);
  const staleGuards = src.match(
    /seq !== divisionsRequestSeq\.current/g
  )?.length;
  assert.ok(
    staleGuards !== undefined && staleGuards >= divisionsCalls * 2,
    'each fetchDivisionsApi callback (success+error) must drop stale responses'
  );
  // settlement change resets the previously picked division/street
  const settle = npPart.indexOf('setSettlement(s);');
  assert.ok(settle !== -1, 'settlement list-click handler not found');
  const after = npPart.slice(settle, settle + 700);
  assert.match(after, /setDivision\(null\)/);
  assert.match(after, /setStreet\(null\)/);
});

test('POST /variants validates availability_status like PUT does', () => {
  const src = readFileSync(
    join(root, 'app/api/admin/products/[id]/variants/route.ts'),
    'utf8'
  );
  assert.match(
    src,
    /const availabilityStatus = strOrNull\(body\.availability_status\) \?\? 'in_stock';/
  );
  assert.match(
    src,
    /\['in_stock', 'limited_availability', 'out_of_stock'\]\.includes\(availabilityStatus\)/
  );
});

test('AddToCartButton only shows "added" when addItem succeeded', () => {
  const btn = readFileSync(join(root, 'app/components/AddToCartButton.tsx'), 'utf8');
  assert.match(btn, /const addedOk = addItem\(/);
  // A failed add must never flip to the "У кошику" state; since 2026-09-04
  // the full-cart case surfaces an explicit limit notice instead of silence.
  assert.match(btn, /if \(!addedOk\) \{\n\s*setLimitNotice\(true\);\n\s*return;\n\s*\}/);
  assert.match(btn, /setAdded\(true\)/);
  assert.match(btn, /У кошику максимум/);
  const ctx = readFileSync(join(root, 'app/lib/cart-context.tsx'), 'utf8');
  assert.match(ctx, /\) => boolean;/);
  assert.match(ctx, /state\.items\.length >= MAX_CART_LINES\) return false/);
});

test('CatalogFilters re-syncs the draft when the applied filters change', () => {
  const src = readFileSync(join(root, 'app/catalog/CatalogFilters.tsx'), 'utf8');
  assert.match(src, /const \[syncedKey, setSyncedKey\] = useState\(initialKey\)/);
  assert.match(src, /if \(syncedKey !== initialKey\)/);
});

// ---------------------------------------------------------------------------
// baseline migrations deployable on a fresh database
// ---------------------------------------------------------------------------

test('baseline policies no longer reference the nonexistent attributes.is_active', () => {
  for (const f of [
    'database/migrations/final_001_initial_schema.sql',
    'database/migrations/final_002_constraints_and_indexes.sql',
  ]) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.ok(
      !src.includes('FROM attributes WHERE is_active'),
      `${f} still references attributes.is_active`
    );
  }
});

test('final_001 no longer grants SELECT on all tables to public', () => {
  const src = readFileSync(
    join(root, 'database/migrations/final_001_initial_schema.sql'),
    'utf8'
  );
  assert.doesNotMatch(src, /GRANT SELECT ON TABLES TO public/);
  assert.match(src, /REVOKE SELECT ON TABLES FROM public/);
});

test('final_002 duplicate translation FKs are gone (matches its own comment)', () => {
  const src = readFileSync(
    join(root, 'database/migrations/final_002_constraints_and_indexes.sql'),
    'utf8'
  );
  assert.ok(!src.includes('ADD CONSTRAINT chk_attributes_translations_attribute_id'));
  assert.ok(
    !src.includes('ADD CONSTRAINT chk_attribute_values_translations_attribute_value_id')
  );
});
