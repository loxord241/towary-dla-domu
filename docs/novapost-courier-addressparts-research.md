# Nova Post API — Courier delivery: `recipient.addressParts` / `settlementId`

Live-verified on **production** (`https://api.novapost.com/v.1.0/`), 2026-08-28.
All tests were read-only (`POST /shipments/calculations`, `GET /settlements`,
`GET /streets`). No shipments/TTNs were created.

## TL;DR — working courier payload

```json
{
  "recipient": {
    "countryCode": "UA",
    "settlementId": 118064,
    "addressParts": {
      "city": "Київ",
      "street": "вул. Хрещатик",
      "building": "22"
    }
  }
}
```

**The key is the undocumented sibling field `recipient.settlementId` (integer).**
It is the `id` returned by `GET /settlements` — the same dictionary our app's
`/api/delivery/novapost/settlements` search already uses. The `city` **text**
inside `addressParts` is ignored by the API (see matrix below); street/building
are stored for the courier but are **not validated** at calculation time.

## Evidence matrix (POST /shipments/calculations)

| # | `recipient` variant | Result |
|---|---------------------|--------|
| A–S | `addressParts.city` = «Київ», «Kyiv», «місто Київ», «city Kyiv», «київ», «Киев», «kyiv», «м. Київ», settlement id (string/number), externalId UUID, garbage; ± `region`, `postCode`, `streetId`, `settlementId`-inside-addressParts, `cityDistrict`, `cityType` | 422 `RecipientCityName not selected` |
| L | `recipient.settlementId` alone (no addressParts/division) | 422 — validator: one of `recipient.divisionId` / `recipient.divisionNumber` / `recipient.address` / `recipient.addressParts` is required |
| **CA** | `settlementId: 118064` + `addressParts{city,street,building}` | **200**, echo `recipient.settlementId: 118064`, `divisionId: null`, cost returned |
| **CB** | `settlementId: 118064` + `addressParts{street,building}` (no city) | **200** — city text not required |
| CC | `settlementId` + English texts | **200** |
| DA | `settlementId` + garbage city `"QQQ"` | **200** — city text is NOT resolved/validated |
| DB | `settlementId` + garbage street `"QQQ"` | **200** — street text NOT validated at calculation |
| DC | `settlementId: 999999999` (unknown) + city text | 422 `settlement not found` |
| DD | `settlementId` only, no `addressParts` | 422 (validator requires addressParts branch) |
| BC | `recipient.divisionId` (warehouse) baseline | 200 — known-good control |
| — | `POST /shipments` probe with invalid `cargoCategory` (never 201) | 422 lists only parcel errors; validator confirms the same 4 recipient branches (divisionId/divisionNumber/address/addressParts) |

## Settlement linkage

- `recipient.settlementId` (request) == `GET /settlements` item `id` (integer).
  Confirmed by the API echoing `recipient.settlementId: 118064` for Kyiv, and by
  the provider's own registry docs (Postman collection: `senderSettlementId:
  "118064"`, `senderSettlementExternalId` = the settlement `externalId` UUID).
- `externalId` (UUID) is NOT accepted anywhere in the recipient location.
- Canonical settlement names include the type prefix: `місто Київ`, `село
  Київське`; `/settlements` textSearch in uk for «Київ» returns «село
  Київське» villages above «місто Київ» (only `boost: 503` ranks the city) —
  do NOT rely on the first search hit; the search UI must surface name+region.
- Streets: `GET /streets?settlementId={id}&name={query}` (the filter param is
  `name`, NOT `textSearch` — it is silently ignored otherwise). Canonical form
  includes the type prefix: `вул. Хрещатик`. Undocumented endpoint but stable;
  item shape: `{id, name, settlement: {id, name}, alternativeNames[], …}`.

## Why plain city names fail

The 422 `RecipientCityName not selected` comes from the legacy UA backend
terminology (legacy `InternetDocument` schema: `RecipientCityName` /
`RecipientAddressName`). The REST v.1.0 `/shipments` recipient location is
resolved **only** via `divisionId` / `divisionNumber` / `settlementId`
(undocumented) — never by free-text city matching. A legacy JSON bridge
(`POST /json`, `Address.searchSettlements`) is documented in the portal but
returns 404 on production and both sandboxes (not deployed).

## Sender address location (verified 2026-08-28, Кривий Ріг)

`sender.settlementId` works exactly like `recipient.settlementId` — integer id
from `GET /settlements`. Verified with `POST /shipments/calculations` → 200:

```json
{
  "sender": {
    "countryCode": "UA",
    "settlementId": 119638,
    "addressParts": {
      "city": "Кривий Ріг",
      "street": "вул. Гетьмана Івана Мазепи",
      "building": "64"
    }
  }
}
```

- «місто Кривий Ріг» (Криворізький район, Дніпропетровська обл.) = **119638**.
  Do not confuse with «село Кривий Ріг» (Херсонська обл.) = 119637.
- Street «вул. Гетьмана Івана Мазепи» in Kryvyi Rih: `/streets` id **5694732**.
  ⚠️ Three similar streets exist in the dictionary — `вул. Мазепи` (4573271),
  `вул. Івана Мазепи ` (5703555, trailing space), `вул. Гетьмана Івана Мазепи`
  (5694732). Match on the exact canonical name / id.
- Street text (and even garbage street) is accepted at calculation time —
  resolution is keyed by `settlementId` alone, street/building are stored.
- Sender division <SEE-ENV> (the live value of the server-side
  `NOVA_POST_SENDER_DIVISION_ID` env — never commit the value) sits in the
  same settlement (its echo was `sender.settlementId: 119638`); address-based
  sender location returns `sender.divisionId: null` instead of the division id.

## Rules for Stage 2G (courier TTN creation)

1. Checkout settlement search: store the `/settlements` item `id` → send as
   `recipient.settlementId` (integer).
2. `addressParts.city`: send the selected settlement `name` for consistency;
   the API ignores it. Do NOT rely on it for routing.
3. `addressParts.street` / `building`: required by our own input contract;
   provider stores but does not validate at calculation time. If street
   autocomplete is added later, use `GET /streets?settlementId=&name=`.
4. `flat`, `postCode`, `block`, `note`: optional (schema maxLengths 10/10/100/100).
5. `POST /shipments` shares the same recipient validator branches, so the same
   shape should be accepted at TTN creation (not live-tested — that would
   create a real TTN). First real courier TTN should be reconciled via
   `clientOrder` and deleted by Ref ID if wrong.
6. `recipient.settlementId` is undocumented in the official OpenAPI for
   `/shipments` + `/shipments/calculations`; treat provider silence on it as a
   compatibility risk and keep a fallback error path (422 → user-facing
   "проверьте адрес" message).

## Live-test scripts

`/tmp/opencode/np-research*.mjs`, `/tmp/opencode/np-legacy*.mjs` (ephemeral;
they read `NOVA_POST_API_KEY` from `.env.local` and never print it).
