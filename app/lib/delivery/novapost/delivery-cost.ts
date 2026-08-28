/**
 * Delivery cost calculation — SERVER-ONLY.
 *
 * Official endpoint: POST /shipments/calculations
 * Documented request fields used here: payerType (enum Sender/Recipient/
 * ThirdPerson), parcels[] (cargoCategory enum parcel|documents|pallet;
 * actualWeight in GRAMS, "Only precision up to 10 grams (0.01 kg) is
 * supported" and "round weight values to the nearest 10 g"; width/length/
 * height in MILLIMETERS, integer >= 1; insuranceCost > 0; rowNumber >= 1),
 * recipient: { countryCode (ISO alpha-2), divisionId (integer) } OR
 * recipient.addressParts { city, street, building, flat, postCode }.
 * Documented response fields used here: scheduledDeliveryDate (nullable
 * date-time), recipient { settlementId, divisionId } (nullable), services[]
 * with cost/price/discount/amount >= 0 and deliveryTypeName.
 *
 * Money handling: a service without a finite, non-negative `cost` is
 * dropped; an unknown value is NEVER coerced to 0. If no service survives
 * validation the call fails as unexpected_response — no fake price is
 * ever returned.
 */

import type { NovaPostClient } from './client.ts';
import { NovaPostError } from './errors.ts';
import type { NpDeliveryQuote, RawNpService } from './types.ts';

const SENDER_COUNTRY_CODE = 'UA';
const RECIPIENT_COUNTRY_CODE = 'UA';
const CARGO_CATEGORIES = ['parcel', 'documents', 'pallet'] as const;
const MAX_PARCELS = 10;
const ADDRESS_TEXT_MAX = 100;
const POSTCODE_MAX = 10;

export interface ParsedCalculation {
  parcels: {
    cargoCategory: 'parcel' | 'documents' | 'pallet';
    rowNumber: number;
    actualWeightGrams: number;
    widthMm: number | null;
    lengthMm: number | null;
    heightMm: number | null;
    insuranceCost: number | null;
  }[];
  recipientDivisionId: number | null;
  /**
   * Courier locator (stage 2G, live-verified): the ONLY working city
   * resolution is the integer GET /settlements id sent as
   * recipient.settlementId; addressParts city text is display-only.
   */
  recipientSettlementId: number | null;
  recipientAddress: {
    city: string | null;
    street: string;
    building: string;
    flat: string | null;
    postCode: string | null;
  } | null;
}

/** Strict parse of the client-supplied JSON body; null when invalid. */
export function parseDeliveryCostBody(body: unknown): ParsedCalculation | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  const rawParcels = raw.parcels;
  if (!Array.isArray(rawParcels) || rawParcels.length < 1 || rawParcels.length > MAX_PARCELS) {
    return null;
  }
  const parcels: ParsedCalculation['parcels'] = [];
  for (let i = 0; i < rawParcels.length; i += 1) {
    const entry = rawParcels[i];
    if (typeof entry !== 'object' || entry === null) return null;
    const p = entry as Record<string, unknown>;

    const cargoCategory = p.cargoCategory;
    if (
      typeof cargoCategory !== 'string' ||
      !(CARGO_CATEGORIES as readonly string[]).includes(cargoCategory)
    ) {
      return null;
    }

    // Docs: grams, precision up to 10 g — round to the nearest 10 g before
    // sending; a non-multiple of 10 is silently floored by the provider, so
    // we reject instead of shipping a value the provider would adjust.
    const actualWeight = p.actualWeightGrams;
    if (
      typeof actualWeight !== 'number' ||
      !Number.isInteger(actualWeight) ||
      actualWeight < 10 ||
      actualWeight > 2_147_483_647 ||
      actualWeight % 10 !== 0
    ) {
      return null;
    }

    const optDimMm = (value: unknown): number | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        return null;
      }
      return value;
    };
    const widthMm = optDimMm(p.widthMm);
    const lengthMm = optDimMm(p.lengthMm);
    const heightMm = optDimMm(p.heightMm);
    // Dimensions are documented as a set used together for volumetric
    // weight — accept all three or none, never a partial trio.
    const dimsPresent = [widthMm, lengthMm, heightMm].filter(
      (d) => d !== null
    ).length;
    if (dimsPresent !== 0 && dimsPresent !== 3) return null;

    let insuranceCost: number | null = null;
    if (p.insuranceCost !== undefined && p.insuranceCost !== null) {
      if (
        typeof p.insuranceCost !== 'number' ||
        !Number.isFinite(p.insuranceCost) ||
        p.insuranceCost <= 0
      ) {
        return null;
      }
      insuranceCost = p.insuranceCost;
    }

    parcels.push({
      cargoCategory: cargoCategory as ParsedCalculation['parcels'][number]['cargoCategory'],
      rowNumber: i + 1,
      actualWeightGrams: actualWeight,
      widthMm,
      lengthMm,
      heightMm,
      insuranceCost,
    });
  }

  let recipientDivisionId: number | null = null;
  if (raw.recipientDivisionId !== undefined && raw.recipientDivisionId !== null) {
    if (
      typeof raw.recipientDivisionId !== 'number' ||
      !Number.isInteger(raw.recipientDivisionId) ||
      raw.recipientDivisionId < 1
    ) {
      return null;
    }
    recipientDivisionId = raw.recipientDivisionId;
  }

  let recipientSettlementId: number | null = null;
  if (raw.recipientSettlementId !== undefined && raw.recipientSettlementId !== null) {
    if (
      typeof raw.recipientSettlementId !== 'number' ||
      !Number.isInteger(raw.recipientSettlementId) ||
      raw.recipientSettlementId < 1
    ) {
      return null;
    }
    recipientSettlementId = raw.recipientSettlementId;
  }

  let recipientAddress: ParsedCalculation['recipientAddress'] = null;
  if (raw.recipientAddress !== undefined && raw.recipientAddress !== null) {
    if (recipientDivisionId !== null) return null; // XOR: division OR address/settlement
    if (typeof raw.recipientAddress !== 'object') return null;
    const a = raw.recipientAddress as Record<string, unknown>;
    const requiredText = (value: unknown): string | null =>
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= ADDRESS_TEXT_MAX
        ? value.trim()
        : null;
    const optionalText = (value: unknown, max: number): string | null =>
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= max
        ? value.trim()
        : null;
    const street = requiredText(a.street);
    const building = requiredText(a.building);
    if (street === null || building === null) return null;
    // With a settlementId the city text is display-only (the provider
    // ignores it); the legacy free-text branch still requires a city.
    const city = optionalText(a.city, ADDRESS_TEXT_MAX);
    if (recipientSettlementId === null && city === null) return null;
    recipientAddress = {
      city,
      street,
      building,
      flat: optionalText(a.flat, 10),
      postCode: optionalText(a.postCode, POSTCODE_MAX),
    };
  }

  if (recipientSettlementId !== null && recipientAddress === null) return null;
  if (recipientDivisionId === null && recipientAddress === null) return null;

  return { parcels, recipientDivisionId, recipientSettlementId, recipientAddress };
}

export function toProviderBody(
  parsed: ParsedCalculation,
  senderDivisionId?: number
): unknown {
  // payerType is fixed server-side: business rule — the RECIPIENT (buyer)
  // pays for delivery. Never accepted from the client.
  // senderDivisionId: the live endpoint (verified 2026-08-27) rejects
  // requests whose sender carries no division/address location; callers
  // that know the dispatch division pass it here.
  const sender: Record<string, unknown> = { countryCode: SENDER_COUNTRY_CODE };
  if (senderDivisionId !== undefined) {
    sender.divisionId = senderDivisionId;
  }
  const recipient: Record<string, unknown> = {
    countryCode: RECIPIENT_COUNTRY_CODE,
  };
  if (parsed.recipientDivisionId !== null) {
    recipient.divisionId = parsed.recipientDivisionId;
  } else if (parsed.recipientSettlementId !== null && parsed.recipientAddress) {
    // Courier branch (stage 2G, live-verified): the settlementId integer is
    // the ONLY city resolution key; addressParts.city is display text the
    // provider stores but never validates.
    const a = parsed.recipientAddress;
    recipient.settlementId = parsed.recipientSettlementId;
    recipient.addressParts = {
      ...(a.city ? { city: a.city } : {}),
      street: a.street,
      building: a.building,
      ...(a.flat ? { flat: a.flat } : {}),
      ...(a.postCode ? { postCode: a.postCode } : {}),
    };
  } else if (parsed.recipientAddress) {
    const a = parsed.recipientAddress;
    recipient.addressParts = {
      city: a.city,
      street: a.street,
      building: a.building,
      ...(a.flat ? { flat: a.flat } : {}),
      ...(a.postCode ? { postCode: a.postCode } : {}),
    };
  }
  return {
    payerType: 'Recipient',
    sender,
    recipient,
    parcels: parsed.parcels.map((p) => ({
      cargoCategory: p.cargoCategory,
      rowNumber: p.rowNumber,
      actualWeight: p.actualWeightGrams,
      ...(p.widthMm !== null
        ? { width: p.widthMm, length: p.lengthMm, height: p.heightMm }
        : {}),
      ...(p.insuranceCost !== null ? { insuranceCost: p.insuranceCost } : {}),
    })),
  };
}

function normalizeQuote(body: unknown): NpDeliveryQuote {
  if (typeof body !== 'object' || body === null) {
    throw new NovaPostError('unexpected_response', 'calculation: bad payload');
  }
  const raw = body as Record<string, unknown>;
  const servicesRaw = raw.services;
  if (!Array.isArray(servicesRaw)) {
    throw new NovaPostError('unexpected_response', 'calculation: no services');
  }

  const optText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0
      ? value.slice(0, 100)
      : null;
  const optNonNegative = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;

  const services = [];
  for (const entry of servicesRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const s = entry as RawNpService;
    // cost is mandatory and must be a sane money value; never default to 0.
    const cost = optNonNegative(s.cost);
    if (cost === null) continue;
    services.push({
      deliveryTypeName: optText(s.deliveryTypeName),
      serviceName: optText(s.serviceName),
      amount: optNonNegative(s.amount),
      price: optNonNegative(s.price),
      discount: optNonNegative(s.discount),
      cost,
      paymentStatus: optText(s.paymentStatus),
    });
  }
  if (services.length === 0) {
    throw new NovaPostError(
      'unexpected_response',
      'calculation: no valid service cost'
    );
  }

  const scheduled = raw.scheduledDeliveryDate;
  const recipient = raw.recipient;
  return {
    scheduledDeliveryDate:
      typeof scheduled === 'string' && scheduled.length > 0
        ? scheduled
        : null,
    recipientSettlementId:
      typeof recipient === 'object' &&
      recipient !== null &&
      typeof (recipient as Record<string, unknown>).settlementId === 'number' &&
      Number.isInteger((recipient as Record<string, unknown>).settlementId) &&
      ((recipient as Record<string, unknown>).settlementId as number) >= 1
        ? ((recipient as Record<string, unknown>).settlementId as number)
        : null,
    recipientDivisionId:
      typeof recipient === 'object' &&
      recipient !== null &&
      typeof (recipient as Record<string, unknown>).divisionId === 'number' &&
      Number.isInteger((recipient as Record<string, unknown>).divisionId) &&
      ((recipient as Record<string, unknown>).divisionId as number) >= 1
        ? ((recipient as Record<string, unknown>).divisionId as number)
        : null,
    services,
  };
}

export async function calculateDeliveryCost(
  client: NovaPostClient,
  parsed: ParsedCalculation,
  senderDivisionId?: number
): Promise<NpDeliveryQuote> {
  const body = await client.postJson(
    'shipments/calculations',
    toProviderBody(parsed, senderDivisionId)
  );
  return normalizeQuote(body);
}
