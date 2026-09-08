/**
 * Delivery cost calculation — SERVER-ONLY, Bearer Ecom API.
 *
 * Official endpoint: POST /ecom/0.0.1/domestic/delivery-price
 *
 * UNIT CONTRACT (Ukrposhta Ecom):
 *   - weight      — GRAMS (integer);
 *   - dimensions  — CENTIMETERS (our DB stores order_shipment_parcels
 *                   dimensions in MILLIMETERS; toProviderBody converts
 *                   mm → cm with Math.round, i.e. UP TO 5 mm of precision
 *                   can be lost per side — 105 mm becomes 11 cm, 104 mm
 *                   becomes 10 cm. The rounding loss is accepted and
 *                   documented here: the provider has no mm interface);
 *   - declaredPrice — UAH.
 *
 * REQUEST SHAPE (official docs as mirrored by community SDKs; the Ecom
 * API is Bearer-only with NO public sandbox, so this contract could NOT
 * be live-verified without a signed contract — the first bearer-bearing
 * call must be a sandboxed verification before production use):
 *   { addressFrom: { postcode }, addressTo: { postcode }, weight,
 *     length, width, height, declaredPrice, type: 'STANDARD',
 *     deliveryType: 'W2W' | 'W2D' | 'D2W' | 'D2D' }
 * RESPONSE SHAPE: { deliveryPrice, rawDeliveryPrice, calculationDescription }.
 *
 * FIXED SERVER-SIDE: deliveryType is pinned to 'W2W' (office → office):
 * MVP Ukrposhta checkout is warehouse-only, there is no courier branch to
 * price. type stays 'STANDARD'. Neither is ever accepted from the client.
 *
 * FAIL-CLOSED: without a configured bearer the calculation throws a typed
 * not_configured UkrposhtaError BEFORE any network activity (mapped to
 * HTTP 503 by the route), never a network throw and never a fake price.
 */

import type { UkrposhtaClient } from './client.ts';
import { UkrposhtaError } from './errors.ts';
import type { UpDeliveryQuote } from './types.ts';

const DELIVERY_TYPE_W2W = 'W2W';
const TYPE_STANDARD = 'STANDARD';
const POSTINDEX_RE = /^\d{5}$/;
/** Max weight the route accepts (grams) — provider rejects more anyway. */
const MAX_WEIGHT_GRAMS = 500_000;
const MAX_MONEY_UAH = 99_999_999;

/** Strict parse of the client-supplied JSON body; null when invalid. */
export interface ParsedUkrposhtaCostBody {
  recipientPostIndex: string;
  weightGrams: number;
  widthMm: number | null;
  lengthMm: number | null;
  heightMm: number | null;
  declaredPriceUah: number;
}

export function parseDeliveryCostBody(body: unknown): ParsedUkrposhtaCostBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  if (typeof raw.recipientPostIndex !== 'string') return null;
  const recipientPostIndex = raw.recipientPostIndex.trim();
  if (!POSTINDEX_RE.test(recipientPostIndex)) return null;

  // weight: integer grams, positive, sane ceiling.
  const weightGrams = raw.weightGrams;
  if (
    typeof weightGrams !== 'number' ||
    !Number.isInteger(weightGrams) ||
    weightGrams < 1 ||
    weightGrams > MAX_WEIGHT_GRAMS
  ) {
    return null;
  }

  // Dimensions: optional SET (mm integers ≥ 1) — all three or none, never
  // a partial trio (volumetric weight needs the complete cuboid).
  const optDimMm = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return null;
    }
    return value;
  };
  const widthMm = optDimMm(raw.widthMm);
  const lengthMm = optDimMm(raw.lengthMm);
  const heightMm = optDimMm(raw.heightMm);
  const dimsPresent = [widthMm, lengthMm, heightMm].filter(
    (d) => d !== null
  ).length;
  if (dimsPresent !== 0 && dimsPresent !== 3) return null;

  // declaredPrice: finite non-negative UAH (what the shipment is declared
  // worth; 0 is allowed by the route — the provider may reject it).
  const declaredPriceUah = raw.declaredPriceUah;
  if (
    typeof declaredPriceUah !== 'number' ||
    !Number.isFinite(declaredPriceUah) ||
    declaredPriceUah < 0 ||
    declaredPriceUah > MAX_MONEY_UAH
  ) {
    return null;
  }

  return {
    recipientPostIndex,
    weightGrams,
    widthMm,
    lengthMm,
    heightMm,
    declaredPriceUah,
  };
}

/**
 * mm → cm with rounding (documented precision loss: ≤ 5 mm per side).
 * A side smaller than 5 mm rounds to 0 cm — the provider needs ≥ 1 cm,
 * so such input is rejected here rather than sent broken.
 */
export function convertMmToCm(mm: number): number | null {
  const cm = Math.round(mm / 10);
  return cm >= 1 ? cm : null;
}

export function toProviderBody(
  parsed: ParsedUkrposhtaCostBody,
  senderPostIndex: string
): unknown {
  const dims =
    parsed.widthMm !== null && parsed.lengthMm !== null && parsed.heightMm !== null
      ? {
          width: convertMmToCm(parsed.widthMm),
          length: convertMmToCm(parsed.lengthMm),
          height: convertMmToCm(parsed.heightMm),
        }
      : null;
  if (dims && (dims.width === null || dims.length === null || dims.height === null)) {
    throw new UkrposhtaError(
      'invalid_input',
      'parcel dimension rounds to 0 cm — send dimensions ≥ 5 mm'
    );
  }
  return {
    addressFrom: { postcode: senderPostIndex },
    addressTo: { postcode: parsed.recipientPostIndex },
    weight: parsed.weightGrams,
    ...(dims ?? {}),
    declaredPrice: parsed.declaredPriceUah,
    type: TYPE_STANDARD,
    deliveryType: DELIVERY_TYPE_W2W,
  };
}

/**
 * Whitelisted quote normalization: a response without a finite,
 * non-negative deliveryPrice is an unexpected_response — an unknown value
 * is NEVER coerced to 0 and no fake price is ever returned.
 */
export function normalizeQuote(body: unknown): UpDeliveryQuote {
  if (typeof body !== 'object' || body === null) {
    throw new UkrposhtaError('unexpected_response', 'delivery-price: bad payload');
  }
  const raw = body as Record<string, unknown>;
  const deliveryPrice = raw.deliveryPrice;
  if (
    typeof deliveryPrice !== 'number' ||
    !Number.isFinite(deliveryPrice) ||
    deliveryPrice < 0
  ) {
    throw new UkrposhtaError(
      'unexpected_response',
      'delivery-price: no valid deliveryPrice'
    );
  }
  const rawDeliveryPrice = raw.rawDeliveryPrice;
  const calculationDescription = raw.calculationDescription;
  return {
    deliveryPriceUah: deliveryPrice,
    rawDeliveryPriceUah:
      typeof rawDeliveryPrice === 'number' &&
      Number.isFinite(rawDeliveryPrice) &&
      rawDeliveryPrice >= 0
        ? rawDeliveryPrice
        : null,
    calculationDescription:
      typeof calculationDescription === 'string' &&
      calculationDescription.trim().length > 0
        ? calculationDescription.slice(0, 300)
        : null,
  };
}

export async function calculateDeliveryCost(
  client: UkrposhtaClient,
  parsed: ParsedUkrposhtaCostBody,
  senderPostIndex: string
): Promise<UpDeliveryQuote> {
  const body = await client.ecomPost(
    'domestic/delivery-price',
    toProviderBody(parsed, senderPostIndex)
  );
  return normalizeQuote(body);
}
