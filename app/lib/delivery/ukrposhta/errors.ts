/**
 * Ukrposhta provider error taxonomy (server-side foundation layer).
 * Same kind contract as app/lib/delivery/novapost/errors.ts.
 *
 * `message` MUST never contain the bearer / user token values.
 * Provider response text is only ever surfaced through `providerDetails`
 * as short field->message strings, never as a raw payload dump.
 */

export type UkrposhtaErrorKind =
  | 'not_configured'
  | 'invalid_input'
  | 'unauthorized'
  | 'provider_error'
  | 'unavailable'
  | 'unexpected_response';

const KINDS: readonly UkrposhtaErrorKind[] = [
  'not_configured',
  'invalid_input',
  'unauthorized',
  'provider_error',
  'unavailable',
  'unexpected_response',
];

export class UkrposhtaError extends Error {
  readonly kind: UkrposhtaErrorKind;
  /** Sanitized provider validation details (field -> short message) or null. */
  readonly providerDetails: Record<string, string> | null;

  constructor(
    kind: UkrposhtaErrorKind,
    message: string,
    providerDetails?: Record<string, string>
  ) {
    super(`ukrposhta:${kind}: ${message}`);
    this.name = 'UkrposhtaError';
    this.kind = kind;
    this.providerDetails = providerDetails ?? null;
  }
}

export function isUkrposhtaError(value: unknown): value is UkrposhtaError {
  return (
    value instanceof UkrposhtaError &&
    KINDS.includes((value as UkrposhtaError).kind)
  );
}
