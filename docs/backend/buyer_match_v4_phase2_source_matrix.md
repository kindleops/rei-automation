# Buyer Match V4 Phase 2 — Source-of-Truth Matrix

Audit date: 2026-06-28  
Branch: `seller-autopilot` (read-only inspection; no migrations applied)

## Executive findings (verified)

| Symptom | Root cause |
| --- | --- |
| 25/25 buyers labeled institutional in UI | `mapInstitutionalStatus()` sets `CORPORATE` on every `is_corporate_buyer`; dashboard `countBuyers()` counts `CORPORATE` as institutional |
| Government agencies in disposition rankings | V4 projection has no government/lender channel filter; RPC institutional bonus uses `buyer_type` only |
| Card vs dossier purchase count mismatch | Cards use RPC `purchase_count_180d`; dossier recounts raw `purchaseEvents` filtered by `buyerId` (different grain, no dedup) |
| 61 mapped vs fewer visible markers | Map legend uses filtered event count; markers capped at 150; activity period/radius filters differ from market summary |
| Activity shows visible events but zero mapped | Filtered geocoded subset empty while feed still shows ungeocoded rows |
| Package shown as single-property price | `mapPurchaseEvents()` exposes raw `purchase_price` with no package scope or allocation |
| Unknown buyers dominate feed | Fallback `buyerId: 'unknown'` and `buyerName: 'Unknown buyer'` with no identity resolution |
| Invalid bid ranges | Broad `likely_buyer_price_range` from demand rollup; per-buyer low/high not repaired when base missing |
| Raw table names in UI | `source: 'buyer_purchase_events_v2'` passed through to components |

---

## Source matrix

### `get_buyer_match_candidates` (RPC)

| Attribute | Value |
| --- | --- |
| Grain | One scored buyer candidate per subject search |
| Canonical key | `buyer_entity_id` (fallback `buyer_key`) |
| Buyer key | `buyer_key` |
| Property key | Subject `p_property_id` (not per-event) |
| Event key | N/A (aggregated counts only) |
| Package key | N/A |
| Parent-company key | **Not exposed** |
| Reliability | High for geo scoring when events exist |
| Date coverage | `last_purchase_date`, `purchase_count_180d`, `purchase_count_365d` |
| Null coverage | `purchases90d` not returned (UI left null) |
| Duplication risk | Low per run; entity variants may appear as separate candidates |
| Package-price risk | Indirect — uses `median_purchase_price` / `avg_purchase_price` from matched events without package quarantine |

### `buyer_purchase_events_v2`

| Attribute | Value |
| --- | --- |
| Grain | One row per (buyer, parcel) purchase event |
| Canonical key | `id` |
| Buyer key | `buyer_entity_id`, `buyer_key`, `buyer_name` |
| Property key | `comp_property_id`, `raw_id`, `property_address_full` |
| Event key | `id`, `source_dedup_key` |
| Package key | **Derived** — cluster by `(buyer_key, purchase_date, purchase_price)` across distinct parcels |
| Parent-company key | **Not present** |
| Reliability | High for demand geography; price contaminated on ~13% package broadcasts |
| Date coverage | `purchase_date`, `recording_date` |
| Null coverage | `latitude`/`longitude` sometimes null; `comp_property_id` often null |
| Duplication risk | Medium — same deed under variant grantee names; `source_dedup_key` mitigates |
| Package-price risk | **High** — total consideration stamped per parcel |

**Columns used in Phase 2 projection:** `id`, `buyer_entity_id`, `buyer_key`, `buyer_name`, `buyer_type`, `is_corporate_buyer`, `comp_property_id`, `raw_id`, `property_address_full`, `property_zip`, `market`, `latitude`, `longitude`, `purchase_date`, `recording_date`, `purchase_price`, `purchase_price_source`, `document_type`, `normalized_asset_class`, `source`, `source_dedup_key`

### `buyer_entities_v2`

| Attribute | Value |
| --- | --- |
| Grain | One row per canonical buyer (`buyer_key`) |
| Canonical key | `id` / `buyer_key` |
| Buyer key | `buyer_key`, `normalized_buyer_name` |
| Property key | N/A |
| Event key | N/A |
| Package key | N/A |
| Parent-company key | **Not present** (no subsidiary graph in v2) |
| Reliability | High for buy-box rollups when join hits (~4% comp join rate) |
| Date coverage | `purchase_count`, `purchase_count_180d`, `purchase_count_365d` |
| Null coverage | Sparse join for comp-derived names |
| Duplication risk | High — LLC variants may split across keys |
| Package-price risk | Rollup medians may include package contamination |

### `buyer_geo_rollups_v2`

| Attribute | Value |
| --- | --- |
| Grain | `geo_level` × `geo_key` × `normalized_asset_class` |
| Keys | `geo_level`, `geo_key`, `normalized_asset_class` |
| Reliability | Medium — market-level fallback |
| Package-price risk | Inherited from event ETL |

### `buyerIdentityResolution.js` (deterministic classifier)

| Attribute | Value |
| --- | --- |
| Grain | Per grantee name + optional entity buy-box |
| Outputs | `archetype`, `identity_confidence`, `canonical_buyer_id` |
| Government detection | `GOV_RE` (HUD, Secretary of Veterans Affairs, housing authority, etc.) |
| Institutional detection | `INSTITUTIONAL_BUYER_PATTERNS` + entity volume thresholds |
| Parent-company key | N/A |
| Name-only merge | **Explicitly forbidden** |

### `transactionClustering.js` (package detection)

| Attribute | Value |
| --- | --- |
| Grain | Economic transaction cluster |
| Package key | `(normalized_buyer, date, consideration)` |
| Reliability | High for broadcast package detection |
| Package-price risk | Quarantines package consideration from single-asset pricing |

### `buildCanonicalBuyerDemand` (`buyer-match-demand.js`)

| Attribute | Value |
| --- | --- |
| Grain | Subject-level demand summary |
| Institutional count | `buyer_type === 'institutional' \|\| institutional_score >= 70` |
| Bid range | `likely_buyer_price_range` from rollup + candidates |
| Package-price risk | May include unsegmented broad range |

---

## Phase 2 canonical layer (new, read-only)

| Module | Responsibility |
| --- | --- |
| `buyer-match-v4-identity.js` | Buyer family projection, buyer class, demand eligibility, institutional subtype |
| `buyer-match-v4-transactions.js` | Canonical purchase events, package scope, dedup, source labels |
| `buyer-match-v4-aggregations.js` | Windowed unique-asset counts, bid repair, market rollups |

**Family grouping rule:** group by verified `buyer_key` when present; never merge on normalized name similarity alone; parent platform unresolved when DB has no relationship edge.

**Ranking rule:** only `DISPOSITION_BUYER` families appear in default Best Match directory.