/**
 * Nova Post provider error taxonomy (server-side foundation layer).
 *
 * `message` MUST never contain the API key or Authorization values.
 * Provider response text is only ever surfaced through `providerDetails`
 * as short field->message strings, never as a raw payload dump.
 */

export type NovaPostErrorKind =
  | 'not_configured'
  | 'invalid_input'
  | 'unauthorized'
  | 'provider_error'
  | 'unavailable'
  | 'unexpected_response';

const KINDS: readonly NovaPostErrorKind[] = [
  'not_configured',
  'invalid_input',
  'unauthorized',
  'provider_error',
  'unavailable',
  'unexpected_response',
];

export class NovaPostError extends Error {
  readonly kind: NovaPostErrorKind;
  /** Sanitized provider validation details (field -> short message) or null. */
  readonly providerDetails: Record<string, string> | null;

  constructor(
    kind: NovaPostErrorKind,
    message: string,
    providerDetails?: Record<string, string>
  ) {
    super(`nova-post:${kind}: ${message}`);
    this.name = 'NovaPostError';
    this.kind = kind;
    this.providerDetails = providerDetails ?? null;
  }
}

export function isNovaPostError(value: unknown): value is NovaPostError {
  return (
    value instanceof NovaPostError &&
    KINDS.includes((value as NovaPostError).kind)
  );
}
