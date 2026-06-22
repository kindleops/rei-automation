# Comp Intelligence Production Audit

Audit date: 2026-06-22  
Repository: `rei-automation-inbox-fix`  
Branch: `inbox-live-fix`

## Executive summary

Comp Intelligence was operating as a monolithic frontend workspace that read coordinates only from a narrow `dealContext.latitude/longitude` path, fell back to market-level comp queries when coordinates were absent, and kept valuation cards in an indefinite **Pending** state. The Acquisition Decision Engine already contained robust subject loading, comp RPC usage, and scoring primitives, but Comp Intelligence was not wired into that pipeline.

This pass introduces a canonical subject-property contract, shared coordinate resolver, API-backed comp discovery with explainable expansion, automatic valuation snapshot persistence, and universal coordinate synchronization across Comp Intelligence, Buyer Match, and Map.

## Architecture map

| Layer | Location | Role |
| --- | --- | --- |
| Workspace UI | `apps/dashboard/src/views/comp-intelligence/CompIntelligenceWorkspace.tsx` | Evidence canvas + valuation dossier |
| Frontend domain | `apps/dashboard/src/domain/comp-intelligence/*` | Coordinate resolver, API client, `useCompIntelligence` hook |
| API routes | `apps/api/src/app/api/cockpit/properties/[property_id]/subject/route.js` | Canonical subject contract |
| API routes | `apps/api/src/app/api/cockpit/properties/[property_id]/comp-intelligence/route.js` | Full evidence + valuation pipeline |
| API routes | `apps/api/src/app/api/cockpit/properties/[property_id]/comps/route.js` | Legacy comp RPC wrapper (preserved) |
| Domain services | `apps/api/src/lib/domain/comp-intelligence/*` | Resolver, discovery, scoring, valuation, events |
| Acquisition engine | `apps/api/src/lib/acquisition/acquisitionDecisionEngine.js` | Preserved — final offer strategy owner |
| Deal dossier | `apps/api/src/lib/cockpit/deal-intelligence-dossier.js` | `resolveCanonicalLocation()` reused |
| Universal context | `apps/dashboard/src/domain/entity-graph/universal-entity-context.ts` | Property/thread/opportunity persistence |
| Buyer Match | `apps/dashboard/src/modules/inbox/components/BuyerMatchWorkspace.tsx` | Now uses shared coordinate resolver |
| Map | `apps/dashboard/src/lib/data/commandMapData.ts` | Seller pins + comp bounds via `v_recent_sold_comps` / RPC |

## Data sources

### `properties`

| Attribute | Value |
| --- | --- |
| Grain | One row per property |
| Canonical ID | `property_id` |
| Join keys | `master_owner_id`, `property_address_zip`, `market` |
| Coordinate columns | `latitude`, `longitude` (aliases `lat`, `lng` supported by resolver) |
| Enrichment | `raw_payload_json`, building fields, valuation fields |
| Freshness | `updated_at` |
| Reliability | High for address; medium for coordinates (gaps observed) |
| Asset applicability | All asset types |
| Frontend usage before | Partial via `dealContext` |
| Missing integration before | `raw_payload_json` coordinates unused in Comp Intelligence |

### `get_comp_candidates_for_subject` RPC

| Attribute | Value |
| --- | --- |
| Grain | Comp candidate per subject search |
| Canonical ID | `property_id` / `comp_id` |
| Join keys | `p_subject_property_id` |
| Coverage | Radius + lookback constrained |
| Reliability | High when subject coordinates exist |
| Frontend usage before | Direct Supabase RPC from dashboard |
| Missing integration before | No explainable expansion metadata returned to UI |

### `v_recent_sold_comps`

| Attribute | Value |
| --- | --- |
| Grain | Sold/list evidence row |
| Canonical ID | `property_id` |
| Join keys | `market`, `property_address_zip`, bounds |
| Coverage | Market/ZIP fallback |
| Reliability | Medium — broad market, not parcel exact |
| Frontend usage before | `loadMarketComps()` fallback |
| Missing integration before | Used without explicit market-only labeling |

### `property_valuation_snapshots`

| Attribute | Value |
| --- | --- |
| Grain | Versioned valuation snapshot |
| Canonical ID | `id` |
| Join keys | `property_id`, `master_owner_id` |
| Coverage | Persisted valuations |
| Reliability | High once written |
| Frontend usage before | Manual POST only |
| Missing integration before | No automatic idempotent persistence from Comp Intelligence |

### `property_acquisition_scores`

| Attribute | Value |
| --- | --- |
| Grain | Acquisition decision per property |
| Owner | Acquisition Decision Engine |
| Integration | Consumes valuation evidence; not replaced in this pass |

### Buyer / institutional evidence

| Source | Notes |
| --- | --- |
| `buyer_geo_rollups_v2` | Buyer Match demand signals |
| `recently_sold_properties` | Acquisition engine fallback when RPC empty |
| Institutional heuristics | Existing buyer-match / command map enrichment |

## Root cause: Don Diego coordinate failure

Observed symptoms:

- Address resolved
- UI showed "No coordinates on file"
- Market fallback comp lookup
- Zero comps / zero included

Verified causes:

1. **Narrow coordinate adapter in Comp Intelligence** — only checked `dealContext.latitude/longitude` and thread aliases, not `property.lat/lng` or `raw_payload_json`.
2. **Zero treated as missing** — `firstNumber(..., 0)` in `dealContext` and `hasCoords` threshold allowed unresolved state without surfacing source attempts.
3. **Market fallback masked as subject failure** — UI copy implied a subject marker could exist when only ZIP/market search was possible.
4. **Direct frontend RPC** — comp search bypassed canonical subject repair and did not persist reproducible snapshots.

## Canonical subject-property contract

Contract version: `comp_intelligence_subject_v1`

Required identifiers:

- `property_id`
- `source_property_id`
- `parcel_apn`
- `canonical_address`
- `normalized_address`
- `master_owner_id`
- `opportunity_id`
- `thread_key`
- `asset_type`
- `units`
- `latitude` / `longitude`
- `coordinate_source`
- `coordinate_confidence`
- `market`, `county`, `state`, `ZIP`

Every enriched field uses evidence wrappers: `value`, `source`, `confidence`, `missing_reason`.

## Coordinate resolution precedence

1. Verified `properties.latitude/longitude` (aliases `lat/lng`)
2. Parcel centroid fields when present
3. Hydrated/enriched property coordinates
4. `raw_payload_json` geocode fields
5. Approved geocode result if supplied by caller
6. Market/ZIP search initialization only — never rendered as subject parcel marker

## Valuation states

Explicit UI states now used instead of indefinite Pending:

- Loading evidence
- Resolving subject
- Searching comps
- Expanding search
- Scoring comps
- Valuing
- Ready
- Ready with limitations
- Blocked: missing subject
- Blocked: insufficient evidence
- Error

## Acquisition Decision Engine integration

- Engine preserved unchanged
- Comp Intelligence auto-persists idempotent valuation snapshots via input hash
- `publishValuationReadyEvent()` emits versioned in-process events for downstream consumers
- Snapshots include methodology, relaxations, included/excluded comps, coordinate source

## UI/UX changes

- Removed manual action-button block (Save Snapshot / Push / Buyer Match / Seller Reply / Mark Hot)
- Added pipeline status panel with explainable search state
- Market fallback now labeled explicitly; no false subject marker
- Light and Red Ops theme contrast fixes
- Buyer Match uses same coordinate resolver as Comp Intelligence

## Don Diego validation (3941 Don Diego St, San Bernardino, CA 92407)

| Field | Result |
| --- | --- |
| Canonical property ID | `217702430` |
| DB coordinates | `34.16738`, `-117.351567` (present in `properties`) |
| Resolver coordinate source | `subject_property` |
| Subject sqft | `1074` |
| 1mi radius comps | 0 (thin market at tight radius) |
| 3mi radius comps | 1 found, 0 included (apartment asset — excluded by scoring) |
| 5mi radius comps | 5 found, 0 included (asset mismatch / weak SFR evidence) |
| ARV at 5mi | Blocked — no qualifying included comps (explainable, not silent zero) |

Additional bug fixed during validation: implicit `asset_class` RPC filtering was removing all candidates before scoring. Filter now applies only when the operator explicitly selects an asset class.

## Remaining limitations

- Don Diego has valid coordinates in production; prior UI failure was adapter/context not DB absence
- Geocode service step is wired but no automatic external geocode mutation is performed
- Mortgage/lien/company/portfolio enrichment panels are contracted in subject loader foundation but not yet fully surfaced in UI cards
- Frontend still contains local ARV animation path; API valuation is authoritative when present

## Status

**READY FOR DATA BACKFILL** — architecture, contracts, resolver, API pipeline, UI states, tests, and theme fixes are in place. Production coordinate completeness for specific subjects (including 3941 Don Diego St) should be validated against live `properties` rows without mutating coordinates.