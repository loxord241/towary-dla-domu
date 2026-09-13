/**
 * Nova Poshta tracking statuses (owner task 2026-09-13, key provided) —
 * SERVER-ONLY logic, kept free of next/server imports so node:test can
 * load it directly (project pattern).
 *
 * Provider: the CLASSIC Nova Poshta internet API
 *   POST https://api.novaposhta.ua/v2.0.0/TrackingDocument/getStatusDocuments/
 * (distinct from the Nova Post platform client in
 * app/lib/delivery/novapost/* — that one serves dictionaries/costs).
 * The apiKey lives only in NOVA_POSHTA_API_KEY (server env) and is sent
 * exclusively inside the outbound request body.
 *
 * Degradation contract: ANY failure (network, Cloudflare interstitial,
 * non-JSON, error envelope) yields an EMPTY map — callers keep rendering
 * the plain tracking link they showed before this module existed. A status
 * is display-only cache (order_shipments.np_status + np_status_checked_at),
 * never authoritative for money or stock decisions.
 */

/** Refresh cadence: page renders never hit the provider more than this. */
export const NP_TRACKING_STALE_MS = 15 * 60_000;

/** Reads the server-side key; null when unconfigured (degrades to links). */
export function readNpTrackingApiKey(): string | null {
  const key = process.env.NOVA_POSHTA_API_KEY;
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const NP_TRACKING_TIMEOUT_MS = 8_000;

const NP_TRACKING_URL =
  'https://api.novaposhta.ua/v2.0.0/TrackingDocument/getStatusDocuments/';

/** A shipment row this module knows how to refresh. */
export interface NpShipmentInput {
  id: string;
  ttn_number: string | null;
  np_status: string | null;
  np_status_checked_at: string | null;
  /** Recipient contact phone in E.164 (+380…) or raw digits; null-tolerant. */
  phone: string | null;
}

export function isNpStatusStale(
  checkedAt: string | null,
  now: number = Date.now()
): boolean {
  if (typeof checkedAt !== 'string' || checkedAt === '') return true;
  const t = Date.parse(checkedAt);
  if (!Number.isFinite(t)) return true;
  return now - t >= NP_TRACKING_STALE_MS;
}

/**
 * NP getStatusDocuments wants the recipient phone; the accepted local
 * format is 0XXXXXXXXX. Accepts E.164 (+380…), 380…, 0… or bare digits
 * and returns the 0-prefixed local form, or null when the input cannot
 * plausibly be one (the provider call then just omits the phone).
 */
export function normalizeNpPhone(phone: string | null): string | null {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 12 && digits.startsWith('380')) {
    return '0' + digits.slice(3);
  }
  if (digits.length === 9) return '0' + digits;
  return null;
}

export interface NpStatusDocPayload {
  DocumentNumber: string;
  Phone: string;
}

/**
 * Request body for getStatusDocuments. Phone goes last-4-or-full? — full
 * normalized local number (the waybill's recipient phone as the admin
 * entered it at NP); providers that mismatch phones answer per-document
 * errors, which parseNpStatusResponse simply skips.
 */
export function buildGetStatusDocumentsPayload(
  apiKey: string,
  docs: NpStatusDocPayload[]
): Record<string, unknown> {
  return {
    apiKey,
    modelName: 'TrackingDocument',
    calledMethod: 'getStatusDocuments',
    methodProperties: {
      Documents: docs.map((d) => ({
        DocumentNumber: d.DocumentNumber,
        Phone: d.Phone,
      })),
    },
  };
}

/**
 * Strict whitelist of the provider answer: data[] entries with string
 * Number + Status. Everything else (errors, Cloudflare HTML, junk) is
 * skipped — the provider is NOT trusted.
 */
export function parseNpStatusResponse(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (raw === null || typeof raw !== 'object') return out;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const number = (entry as { Number?: unknown }).Number;
    const status = (entry as { Status?: unknown }).Status;
    if (typeof number !== 'string' || number.length === 0) continue;
    if (typeof status !== 'string' || status.length === 0) continue;
    if (number.length > 20 || status.length > 120) continue;
    out.set(number, status);
  }
  return out;
}

export type FetchImpl = typeof fetch;

/**
 * One batched provider call for up to `docs.length` documents (NP caps the
 * array; callers pass ≤ 20). Never throws: failures return an empty map.
 */
export async function fetchNpStatuses(
  docs: NpStatusDocPayload[],
  apiKey: string,
  fetchImpl: FetchImpl = fetch
): Promise<Map<string, string>> {
  if (docs.length === 0 || apiKey === '') return new Map();
  try {
    const res = await fetchImpl(NP_TRACKING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (compatible; TowaryDlaDomu/1.0; tracking refresh)',
      },
      body: JSON.stringify(buildGetStatusDocumentsPayload(apiKey, docs)),
      signal: AbortSignal.timeout(NP_TRACKING_TIMEOUT_MS),
    });
    const raw: unknown = await res.json();
    return parseNpStatusResponse(raw);
  } catch {
    return new Map();
  }
}

/** Persist a refreshed status (display cache only). */
export type NpStatusWriter = (
  shipmentId: string,
  status: string,
  checkedAtIso: string
) => Promise<void>;

/**
 * Refresh stale NP shipments in one batched call; writes via the injected
 * writer. Non-NP shipments, missing TTNs and fresh entries are skipped.
 */
export async function refreshNpStatuses(
  shipments: NpShipmentInput[],
  apiKey: string | null,
  write: NpStatusWriter,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now()
): Promise<void> {
  if (apiKey === null || apiKey === '' || shipments.length === 0) return;
  const stale = shipments.filter(
    (s) =>
      typeof s.ttn_number === 'string' &&
      s.ttn_number.trim() !== '' &&
      isNpStatusStale(s.np_status_checked_at, now)
  );
  if (stale.length === 0) return;
  const docs = stale.map((s) => ({
    DocumentNumber: (s.ttn_number ?? '').trim(),
    Phone: normalizeNpPhone(s.phone) ?? '',
  }));
  const statuses = await fetchNpStatuses(docs, apiKey, fetchImpl);
  if (statuses.size === 0) return;
  const checkedAtIso = new Date(now).toISOString();
  await Promise.all(
    stale
      .filter((s) => statuses.has((s.ttn_number ?? '').trim()))
      .map((s) =>
        write(s.id, statuses.get((s.ttn_number ?? '').trim())!, checkedAtIso)
      )
  );
}
