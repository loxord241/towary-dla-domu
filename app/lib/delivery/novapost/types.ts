/**
 * Nova Post data contracts — only fields confirmed by the official
 * documentation (api-portal.novapost.com, API v.1.0 OpenAPI specs).
 *
 * Raw* types mirror the provider response; the normalized types are the
 * ONLY shapes that leave the server-side layer towards our API routes.
 */

/** GET /settlements response item (official OpenAPI schema). */
export interface RawNpSettlement {
  id: number;
  name: string;
  country?: { name?: string; code?: string } | null;
  region?: {
    id: number;
    name: string;
    parent?: { id: number; name: string } | null;
  } | null;
  alternativeNames?: unknown;
  [key: string]: unknown;
}

/** GET /divisions response item (official OpenAPI schema, whitelisted). */
export interface RawNpDivision {
  id: number;
  name: string;
  shortName?: string | null;
  address?: string | null;
  number?: string | null;
  divisionCategory?: string | null;
  status?: string | null;
  maxWeightPlaceSender?: number | null;
  maxWeightPlaceRecipient?: number | null;
  settlement?: { id: number; name: string } | null;
  [key: string]: unknown;
}

/** POST /shipments/calculations response `services[]` item (whitelisted). */
export interface RawNpService {
  deliveryTypeName?: string | null;
  serviceName?: string | null;
  amount?: number | null;
  price?: number | null;
  discount?: number | null;
  cost?: number | null;
  paymentStatus?: string | null;
  [key: string]: unknown;
}

/** GET /settlements — normalized item returned to our routes. */
export interface NpSettlement {
  id: number;
  name: string;
  regionName: string | null;
  regionParentName: string | null;
}

/** GET /divisions — normalized item returned to our routes. */
export interface NpDivision {
  id: number;
  name: string;
  shortName: string | null;
  address: string | null;
  number: string | null;
  category: string | null;
  maxWeightPlaceSenderGrams: number | null;
  maxWeightPlaceRecipientGrams: number | null;
}

/** POST /shipments/calculations — normalized quote returned to our routes. */
export interface NpDeliveryQuote {
  scheduledDeliveryDate: string | null;
  recipientSettlementId: number | null;
  recipientDivisionId: number | null;
  services: NpDeliveryService[];
}

export interface NpDeliveryService {
  deliveryTypeName: string | null;
  serviceName: string | null;
  amount: number | null;
  price: number | null;
  discount: number | null;
  cost: number;
  paymentStatus: string | null;
}
