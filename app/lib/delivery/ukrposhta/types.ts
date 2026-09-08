/**
 * Ukrposhta data contracts — only whitelisted fields of the Address
 * Classifier responses (live-verified keyless 2026-09-08 against
 * https://www.ukrposhta.ua/address-classifier/0.0.1/) and the Ecom
 * /domestic/delivery-price endpoint (Bearer-only; contract from the
 * official Ecom docs as mirrored by community SDKs — NOT live-verifiable
 * without a contract with Ukrposhta, see delivery-cost.ts).
 *
 * Raw* types mirror the provider response; the normalized types are the
 * ONLY shapes that leave the server-side layer towards our API routes.
 *
 * NOTE: the classifier returns ALL numeric ids as JSON strings
 * ("REGION_ID":"262", "CITY_ID":"14288", "ID":"1176813") — normalization
 * re-parses them with strict integer-string rules; a numeric string like
 * "1e2" or " 5 " must never pass.
 */

/** GET /get_regions_by_region_ua — raw entry (whitelisted). */
export interface RawUpRegion {
  REGION_ID?: string | number;
  REGION_UA?: string | null;
  REGION_EN?: string | null;
  REGION_KATOTTG?: string | null;
  REGION_KOATUU?: string | null;
  [key: string]: unknown;
}

/**
 * GET /get_city_by_region_id_and_district_id_and_city_ua — raw entry.
 * NAME_UA is the record-status marker ("Активний запис" for live records,
 * per the official classifier docs §"Параметри тіла відповіді").
 */
export interface RawUpCity {
  CITY_ID?: string | number;
  CITY_UA?: string | null;
  CITYTYPE_UA?: string | null;
  SHORTCITYTYPE_UA?: string | null;
  DISTRICT_ID?: string | number;
  DISTRICT_UA?: string | null;
  REGION_ID?: string | number;
  REGION_UA?: string | null;
  NAME_UA?: string | null;
  CITY_KATOTTG?: string | null;
  CITY_KOATUU?: string | null;
  [key: string]: unknown;
}

/**
 * GET /get_postoffices_by_postindex (params pi / pc / poCityId / …) — raw
 * entry. POLOCK_UA is the lock marker ("Активний запис" = active office;
 * LOCK_CODE 0 = active, 65535 = blocked).
 */
export interface RawUpPostOffice {
  ID?: string | number;
  PO_SHORT?: string | null;
  PO_LONG?: string | null;
  POSTINDEX?: string | null;
  ADDRESS?: string | null;
  POCITY_ID?: string | number;
  POLOCK_UA?: string | null;
  LOCK_CODE?: string | number | null;
  TYPE_ACRONYM?: string | null;
  TYPE_SHORT?: string | null;
  PHONE?: string | null;
  ISVPZ?: string | number | null;
  [key: string]: unknown;
}

/** Normalized region returned to our routes. */
export interface UpRegion {
  id: number;
  name: string;
  nameEn: string | null;
  katottg: string | null;
  koatuu: string | null;
}

/** Normalized settlement (city) returned to our routes. */
export interface UpSettlement {
  id: number;
  /** City name proper (CITY_UA), e.g. «Львів». */
  name: string;
  /** Short type prefix (SHORTCITYTYPE_UA), e.g. «м.» / «с.» — display only. */
  shortType: string | null;
  districtName: string | null;
  regionName: string | null;
  /** Stable cross-host code (classifier data), stored alongside the id. */
  katottg: string | null;
  koatuu: string | null;
}

/** Normalized post office returned to our routes. */
export interface UpOffice {
  id: number;
  /** Short display name (PO_SHORT), e.g. «Київ 1». */
  shortName: string | null;
  /** Full display name (PO_LONG). */
  longName: string | null;
  /** Office post index (POSTINDEX), 5 digits as string. */
  postIndex: string | null;
  address: string | null;
  phone: string | null;
  typeAcronym: string | null;
}

/** POST /ecom/0.0.1/domestic/delivery-price — normalized quote. */
export interface UpDeliveryQuote {
  /** Final delivery price in UAH. */
  deliveryPriceUah: number;
  /** Price before discounts, when the provider sends it (UAH). */
  rawDeliveryPriceUah: number | null;
  calculationDescription: string | null;
}
