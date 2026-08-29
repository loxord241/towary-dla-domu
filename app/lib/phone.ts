/**
 * Pure UA phone normalizers for the checkout form (extracted verbatim from
 * CheckoutForm.tsx so the paste/autofill regression tests can import them —
 * node:test cannot import JSX client components).
 *
 * Keep in sync with CheckoutForm's fixed +380 prefix rendering and the
 * server-side E.164 validation in /api/orders (never weaken either side).
 */

/** Keep only the 9 national digits after +380. Handles pasted
 * "+380971234567" / "380971234567" / "0971234567" / "971234567". */
export function normalizeUaPhoneDigits(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('380')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.slice(0, 9);
}

/** E.164 value sent to the backend; '' when the field was left empty. */
export function toE164Ua(digits: string): string {
  return digits.length === 9 ? `+380${digits}` : '';
}
