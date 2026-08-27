/**
 * Maps NovaPostError kinds to HTTP status + safe client-facing message.
 *
 * Pure function (no Next.js imports) so the mapping is unit-testable;
 * route handlers stay thin wrappers around it. Messages are fixed strings
 * (Ukrainian, matching project style) and NEVER embed provider payloads,
 * the api key or internal error text.
 */

import { isNovaPostError } from './errors.ts';

export interface NovaPostFailure {
  status: number;
  message: string;
}

const MESSAGES = {
  notConfigured: 'Доставка тимчасово недоступна',
  unavailable: 'Доставка тимчасово недоступна. Спробуйте пізніше',
  providerRejected: 'Перевізник не прийняв параметри відправлення',
  lookupFailed: 'Не вдалося виконати пошук. Спробуйте пізніше',
  divisionsFailed: 'Не вдалося завантажити відділення. Спробуйте пізніше',
  calculationFailed: 'Не вдалося розрахувати вартість. Спробуйте пізніше',
  invalidInput: 'Некоректні параметри відправлення',
  invalidQuery: 'Некоректний пошуковий запит',
  invalidSettlement: 'Некоректне місто',
} as const;

export const NOVA_POST_MESSAGES = MESSAGES;

/**
 * Returns the failure for a known NovaPostError, or null for unexpected
 * errors (caller logs and answers 502).
 */
export function mapNovaPostFailure(error: unknown): NovaPostFailure | null {
  if (!isNovaPostError(error)) return null;
  switch (error.kind) {
    case 'not_configured':
      return { status: 503, message: MESSAGES.notConfigured };
    case 'unavailable':
      return { status: 503, message: MESSAGES.unavailable };
    case 'invalid_input':
      return { status: 400, message: MESSAGES.invalidInput };
    case 'provider_error':
      return { status: 422, message: MESSAGES.providerRejected };
    case 'unauthorized':
    case 'unexpected_response':
      return { status: 502, message: MESSAGES.calculationFailed };
  }
}
