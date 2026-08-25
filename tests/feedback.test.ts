/**
 * Anonymous feedback (2026-08 client UX request).
 *
 * Real anonymity contract: the ONLY user-provided datum is the message
 * text. These tests pin the pure validation rules (unit — the validator is
 * plain TS), the honest not-yet-configured storage behaviour of the API
 * route (501, no persistence), and the absence of any PII collection
 * (no user-agent persistence, no IP persistence, no DB writes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const {
  validateFeedbackMessage,
  FEEDBACK_MIN_LENGTH,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_DAILY_CAP,
} = await import('../app/lib/feedback.ts');

// ---- pure validator (unit)

test('FEEDBACK: accepts a normal message and trims it', () => {
  const res = validateFeedbackMessage('  Додайте фільтр за кольором, будь ласка  ');
  assert.deepEqual(res, { ok: true, text: 'Додайте фільтр за кольором, будь ласка' });
});

test('FEEDBACK: rejects empty, whitespace, non-string input', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(validateFeedbackMessage(bad).ok, false, JSON.stringify(bad));
  }
});

test(`FEEDBACK: rejects messages shorter than ${FEEDBACK_MIN_LENGTH}`, () => {
  assert.equal(validateFeedbackMessage('коротко').ok, false);
});

test(`FEEDBACK: rejects messages longer than ${FEEDBACK_MAX_LENGTH}`, () => {
  const long = 'а'.repeat(FEEDBACK_MAX_LENGTH + 1);
  assert.equal(validateFeedbackMessage(long).ok, false);
  assert.equal(validateFeedbackMessage('б'.repeat(FEEDBACK_MAX_LENGTH)).ok, true);
});

test('FEEDBACK: strips control characters from the message', () => {
  const res = validateFeedbackMessage('Нормальний відгук\u0000 з текстом\u0007');
  assert.ok(res.ok);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(res.text ?? ''));
});

// ---- API route: persists ONLY the message, degrades honestly, zero PII

test('FEEDBACK: route is POST-only, rate-limited, persists only the message', () => {
  const route = src('app/api/feedback/route.ts');
  assert.match(route, /export\s+async function POST/);
  assert.match(route, /enforceRateLimit/);
  // honeypot: bot-filled field short-circuits without processing
  assert.match(route, /website|honeypot/i);
  // storage: insert carries the validated message text and nothing else
  assert.match(route, /\.insert\(\{\s*message:\s*validated\.text\s*\}\)/);
  assert.match(route, /SUPABASE_SERVICE_ROLE_KEY/, 'writes go through the server-side service client');
});

test('FEEDBACK: honest states — 201 success, 429 daily cap, 503 storage missing', () => {
  const route = src('app/api/feedback/route.ts');
  assert.match(route, /status: 201/, 'success state');
  assert.match(route, /status: 429/, 'daily cap state');
  assert.match(route, /feedback_storage_not_configured/);
  assert.match(route, /status: 503/, 'honest degradation until the migration is applied');
  assert.ok(!/status: 501/.test(route), 'no fake not-implemented path anymore');
});

test(`FEEDBACK: global daily cap (${FEEDBACK_DAILY_CAP}) is shared and identifier-free`, () => {
  assert.ok(FEEDBACK_DAILY_CAP > 0);
  const route = src('app/api/feedback/route.ts');
  assert.match(route, /FEEDBACK_DAILY_CAP/);
  // the cap counts rows by created_at only — no user attribute in the query
  assert.match(route, /created_at/);
});

test('FEEDBACK: no PII collection anywhere in the route', () => {
  const route = src('app/api/feedback/route.ts');
  assert.ok(!route.includes('user-agent'), 'must not read user-agent');
  assert.ok(!route.includes('fs.') && !route.includes('writeFile'), 'no file persistence');
  assert.ok(!/console\.\w+\([^)]*(ip|forwarded)/i.test(route), 'IP must not be logged');
  // the insert payload must not carry any identifier fields
  assert.ok(
    !/insert\(\{[^}]*(ip\b|agent|email|name\b)[^}]*\}/i.test(route),
    'insert must carry the message only'
  );
});

test('FEEDBACK: migration exists and is RLS-hardened', () => {
  const migration = src('database/migrations/013_feedback.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.feedback/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /char_length\(message\) BETWEEN 10 AND 1000/);
  // no identifier columns at all
  assert.ok(!/ip|agent|email|user_/i.test(migration.replace(/--[^\n]*/g, '')), 'table must store message + timestamp only');
});

test('FEEDBACK: rate limit rule exists', () => {
  const rl = src('app/lib/rate-limit.ts');
  assert.match(rl, /feedback:/);
});

// ---- footer UI

test('FEEDBACK: footer exposes the entry button and the modal is wired', () => {
  const footer = src('app/components/SiteFooter.tsx');
  assert.match(footer, /Як покращити сайт\?/);
  assert.match(footer, /FeedbackModal/);
});

test('FEEDBACK: modal has dialog semantics, textarea limits and all UI states', () => {
  const modal = src('app/components/FeedbackModal.tsx');
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-label="Зворотний зв'язок"|aria-label="Як покращити сайт\?"/);
  assert.match(modal, /maxLength=\{FEEDBACK_MAX_LENGTH\}|maxLength=\{1000\}/);
  // states: submit disabled while empty/loading, error and success rendering
  assert.match(modal, /disabled=/);
  assert.match(modal, /Помилка|error/i);
  assert.match(modal, /Дякуємо|success/i);
  // escape + overlay close
  assert.match(modal, /Escape/);
  // honeypot field invisible to humans
  assert.match(modal, /tabIndex=\{-1\}/);
  // anonymous promise shown to the user
  assert.match(modal, /анонімно/i);
});
