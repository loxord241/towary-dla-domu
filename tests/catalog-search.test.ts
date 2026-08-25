/**
 * Search-term sanitization for the PostgREST `or=` expression
 * (app/lib/catalog.ts → fetchCatalogProducts).
 *
 * Contract: the sanitized term can never inject or corrupt the logic-tree
 * grammar (`,` `"` `(` `)` `%`), while ordinary search text — Cyrillic,
 * Latin, digits, spaces, hyphens, apostrophes, dots — passes through.
 * Grammar sensitivity itself was verified LIVE against Supabase/PostgREST
 * on 2026-08 (see PROJECT_CONTEXT.md, F3): raw `,` → PGRST100; raw `"`,
 * `(`, `)` silently corrupt the ilike pattern; raw `%` broadens matches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// catalog.ts creates its Supabase client at module load; provide the
// publishable-env placeholders BEFORE the import (no network happens).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
const { sanitizeSearchTerm, buildSearchConditions } = await import(
  '../app/lib/catalog.ts'
);

// ---- buildSearchConditions: multi-token AND search (UX fix: word order
// must not matter — «TEFAL мультипіч» and «мультипіч TEFAL» are equivalent).

test('buildSearchConditions: word order does not matter (same condition set)', () => {
  const a = buildSearchConditions('мультипіч TEFAL');
  const b = buildSearchConditions('TEFAL мультипіч');
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.deepEqual([...(a as string[])].sort(), [...(b as string[])].sort());
});

test('buildSearchConditions: every token becomes an AND-ed or() expression', () => {
  const conds = buildSearchConditions('парова щітка') as string[];
  assert.equal(conds.length, 2);
  for (const cond of conds) {
    // each token must match in name OR short_description
    assert.match(cond, /^name\.ilike\.%[^%]+%,short_description\.ilike\.%[^%]+%$/);
  }
  const tokens = conds.map((c) => c.split('ilike.%')[1].split('%')[0]);
  assert.deepEqual(tokens.sort(), ['парова', 'щітка'].sort());
});

test('buildSearchConditions: single token keeps legacy shape', () => {
  assert.deepEqual(buildSearchConditions('щітка'), [
    'name.ilike.%щітка%,short_description.ilike.%щітка%',
  ]);
});

test('buildSearchConditions: empty / whitespace / specials-only → null', () => {
  assert.equal(buildSearchConditions(''), null);
  assert.equal(buildSearchConditions('   '), null);
  assert.equal(buildSearchConditions(',""'), null);
  assert.equal(buildSearchConditions('%","%('), null);
});

test('buildSearchConditions: duplicate tokens collapse', () => {
  const conds = buildSearchConditions('щітка щітка') as string[];
  assert.equal(conds.length, 1);
});

test('buildSearchConditions: token fan-out is capped at 10 (ILIKE cost bound)', () => {
  const many = Array.from({ length: 25 }, (_, i) => `слово${i + 1}`).join(' ');
  const conds = buildSearchConditions(many) as string[];
  assert.equal(conds.length, 10);
});

test('buildSearchConditions: cyrillic, digits, hyphens, apostrophes, dots preserved', () => {
  const conds = buildSearchConditions("фото-альбом 10x15 l'oreal") as string[];
  assert.equal(conds.length, 3);
  const joined = conds.join('|');
  assert.ok(joined.includes('фото-альбом'));
  assert.ok(joined.includes('10x15'));
  assert.ok(joined.includes("l'oreal"));
});

test('buildSearchConditions: adversarial input can never inject or= grammar', () => {
  const adversarial = [
    'Ніж TRAMONTINA CENTURY поварський6" (24010/106)',
    '"iphone 15", (в наявності) 100%',
    'foo,bar"baz',
    '%","%(',
  ];
  for (const input of adversarial) {
    const conds = buildSearchConditions(input);
    if (!conds) continue;
    for (const cond of conds) {
      // strip the known scaffolding, inspect only the pattern values
      const values = [...cond.matchAll(/ilike\.%([^%]*)%/g)].map((m) => m[1]);
      for (const value of values) {
        for (const ch of [',', '"', '(', ')', '%']) {
          assert.ok(
            !value.includes(ch),
            `pattern ${JSON.stringify(value)} contains reserved ${JSON.stringify(ch)}`
          );
        }
      }
    }
  }
});

test('buildSearchConditions: F3 corrupted-name case stays findable', () => {
  // The live-verified F3 name; its sanitized tokens must each be searchable.
  const conds = buildSearchConditions(
    'Ніж TRAMONTINA CENTURY поварський6" (24010/106)'
  ) as string[];
  const joined = conds.join('|');
  assert.ok(joined.includes('TRAMONTINA'));
  assert.ok(joined.includes('поварський6'));
  assert.ok(joined.includes('24010/106'));
});

test('sanitizeSearchTerm: comma becomes a space, tokens stay searchable', () => {
  assert.equal(sanitizeSearchTerm('foo,bar'), 'foo bar');
});

test('sanitizeSearchTerm: double quotes are stripped in all positions', () => {
  assert.equal(sanitizeSearchTerm('"foo"'), 'foo');
  assert.equal(sanitizeSearchTerm('foo"bar'), 'foo bar');
});

test('sanitizeSearchTerm: combined comma + quote', () => {
  assert.equal(sanitizeSearchTerm('foo,bar"baz'), 'foo bar baz');
});

test('sanitizeSearchTerm: parens and percent are stripped too', () => {
  assert.equal(sanitizeSearchTerm('(альбом)'), 'альбом');
  assert.equal(sanitizeSearchTerm('100%'), '100');
  assert.equal(sanitizeSearchTerm('фото (10x15)"'), 'фото 10x15');
});

test('sanitizeSearchTerm: ordinary product text is preserved', () => {
  assert.equal(sanitizeSearchTerm('Фотоальбом 10x15'), 'Фотоальбом 10x15');
  assert.equal(sanitizeSearchTerm('Парова щітка TEFAL DT2026E1'), 'Парова щітка TEFAL DT2026E1');
  assert.equal(sanitizeSearchTerm('philips-oneblade'), 'philips-oneblade');
  assert.equal(sanitizeSearchTerm("l'oreal"), "l'oreal");
  assert.equal(sanitizeSearchTerm('Вбуд. поверхня WHIRLPOOL AKT 8210 LX'), 'Вбуд. поверхня WHIRLPOOL AKT 8210 LX');
});

test('sanitizeSearchTerm: interior whitespace runs collapse to single spaces', () => {
  assert.equal(sanitizeSearchTerm('  a   b  '), 'a b');
  // adjacent specials must not leave multi-space gaps between tokens
  assert.equal(sanitizeSearchTerm('foo,",bar'), 'foo bar');
});

test('sanitizeSearchTerm: empty and whitespace-only input', () => {
  assert.equal(sanitizeSearchTerm(''), '');
  assert.equal(sanitizeSearchTerm('   '), '');
  assert.equal(sanitizeSearchTerm(',""'), '');
});

test('sanitizeSearchTerm: output can never inject or= grammar characters', () => {
  const adversarial = [
    'foo,bar',
    '"foo"',
    'foo"bar',
    'foo,bar"baz',
    '",("',
    '%","%("',
    'Ніж TRAMONTINA CENTURY поварський6" (24010/106)',
    '"iphone 15", (в наявності) 100%',
  ];
  for (const input of adversarial) {
    const out = sanitizeSearchTerm(input);
    for (const ch of [',', '"', '(', ')', '%']) {
      assert.ok(
        !out.includes(ch),
        `output ${JSON.stringify(out)} contains reserved ${JSON.stringify(ch)}`
      );
    }
  }
});

test('sanitizeSearchTerm: real corrupted-name case now yields a usable keyword term', () => {
  // Live-verified F3 case: this exact name was unfindable pre-fix because
  // the quote silently corrupted the ilike pattern.
  const name = 'Ніж TRAMONTINA CENTURY поварський6" (24010/106)';
  const out = sanitizeSearchTerm(name);
  assert.equal(out, 'Ніж TRAMONTINA CENTURY поварський6 24010/106');
  assert.ok(out.includes('TRAMONTINA'));
});
