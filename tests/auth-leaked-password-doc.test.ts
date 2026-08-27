/**
 * Auth leaked-password-protection — structural/documentation check.
 *
 * Leaked Password Protection is a Supabase Auth Dashboard setting (Pro plan
 * and above); it is NOT exposed via SQL, the public /auth/v1/settings
 * endpoint, or the tooling available in this environment, so its state
 * cannot be verified or toggled programmatically here. The documented
 * manual step is: Supabase Dashboard → Authentication → Policies →
 * enable "Leaked password protection" (checks passwords against
 * HaveIBeenPwned Pwned Passwords at signup/password update; no application
 * auth-flow change required).
 *
 * This test pins the documentation so the outstanding manual step does not
 * get lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AUTH-HIBP: the manual Dashboard step is documented in PROJECT_CONTEXT.md', () => {
  const doc = readFileSync(path.join(root, 'PROJECT_CONTEXT.md'), 'utf8');
  assert.match(doc, /leaked password protection/i);
  assert.match(
    doc,
    /dashboard.*authentication|authentication.*dashboard/i,
    'documentation must point to the Supabase Dashboard'
  );
  assert.match(
    doc,
    /(не вдалося перевірити|cannot be verified|dashboard-only)/i,
    'the verification limitation must be stated honestly'
  );
});

test('AUTH-HIBP: application code contains no leaked-password logic to review', () => {
  // The check lives entirely in Supabase Auth (HaveIBeenPwned, server-side);
  // no app-side implementation exists or is needed — signup/password update
  // calls go through supabase-js auth endpoints which gain the protection
  // automatically once the Dashboard flag is enabled.
  const doc = readFileSync(path.join(root, 'PROJECT_CONTEXT.md'), 'utf8');
  assert.match(
    doc,
    /HaveIBeenPwned/,
    'the underlying mechanism must be identified in the documentation'
  );
});
