/** Pure validation unit tests for product-review submissions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReviewInput,
  REVIEW_MIN_LENGTH,
  REVIEW_MAX_LENGTH,
  REVIEW_NAME_MAX_LENGTH,
} from '../app/lib/reviews.ts';

const okRating = 5;
const okText = 'Дуже задоволений покупкою, рекомендую!';

test('REVIEW VALIDATION: accepts integer ratings 1..5', () => {
  for (const rating of [1, 2, 3, 4, 5]) {
    const result = validateReviewInput({ rating, text: okText });
    assert.equal(result.ok, true, `rating ${rating} must pass`);
    if (result.ok) assert.equal(result.rating, rating);
  }
});

test('REVIEW VALIDATION: rejects out-of-range and non-integer ratings', () => {
  for (const rating of [0, 6, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      validateReviewInput({ rating, text: okText }).ok,
      false,
      `rating ${rating} must fail`
    );
  }
});

test('REVIEW VALIDATION: rejects non-number rating types (string "5" included)', () => {
  for (const rating of ['5', null, undefined, { v: 5 }, [5], true]) {
    assert.equal(validateReviewInput({ rating, text: okText }).ok, false);
  }
});

test('REVIEW VALIDATION: rejects text shorter than min and longer than max', () => {
  assert.equal(validateReviewInput({ rating: okRating, text: 'коротко' }).ok, false);
  assert.equal(
    validateReviewInput({ rating: okRating, text: 'а'.repeat(REVIEW_MAX_LENGTH + 1) })
      .ok,
    false
  );
  assert.ok(REVIEW_MIN_LENGTH === 10 && REVIEW_MAX_LENGTH === 1000);
});

test('REVIEW VALIDATION: accepts boundary lengths and strips control chars/trim', () => {
  const boundary = 'в'.repeat(REVIEW_MAX_LENGTH);
  const padded = validateReviewInput({
    rating: okRating,
    text: `  ${boundary}\u0007  `,
  });
  assert.equal(padded.ok, true);
  if (padded.ok) assert.equal(padded.text, boundary);

  const minLen = 'м'.repeat(REVIEW_MIN_LENGTH);
  assert.equal(validateReviewInput({ rating: okRating, text: minLen }).ok, true);
});

test('REVIEW VALIDATION: keeps meaningful newlines/tabs, drops other control chars', () => {
  const result = validateReviewInput({
    rating: okRating,
    text: 'перший рядок\nдругий\tрядок\u0000кінець',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, 'перший рядок\nдругий\tрядоккінець');
});

test('REVIEW VALIDATION: rejects non-string text', () => {
  for (const text of [null, undefined, 123, {}, []]) {
    assert.equal(validateReviewInput({ rating: okRating, text }).ok, false);
  }
});

test('REVIEW VALIDATION: optional displayName trimmed, capped at 40, empty -> null', () => {
  const named = validateReviewInput({ rating: okRating, text: okText, displayName: '  Оксана  ' });
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.displayName, 'Оксана');

  const anon = validateReviewInput({ rating: okRating, text: okText, displayName: '   ' });
  assert.equal(anon.ok, true);
  if (anon.ok) assert.equal(anon.displayName, null);

  const atCap = validateReviewInput({
    rating: okRating,
    text: okText,
    displayName: 'д'.repeat(REVIEW_NAME_MAX_LENGTH),
  });
  assert.equal(atCap.ok, true);

  const overCap = validateReviewInput({
    rating: okRating,
    text: okText,
    displayName: 'д'.repeat(REVIEW_NAME_MAX_LENGTH + 1),
  });
  assert.equal(overCap.ok, false);
});

test('REVIEW VALIDATION: missing displayName field behaves as anonymous', () => {
  const result = validateReviewInput({ rating: okRating, text: okText });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.displayName, null);
});
