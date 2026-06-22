# Buyer Match Production Audit

Audit date: 2026-06-22  
Worktree: `/Users/ryankindle/rei-automation-buyer-match-lock`  
Branch: `buyer-match-production-lock`  
Starting HEAD: `9efe5e625e83770097c4246a2e87114f8801349b`

## Executive summary

Buyer Match operates through **Inbox → `BuyerMatchWorkspace` → `buyer-match-engine.js` → `get_buyer_match_candidates` RPC**, with demand rollups from `buyer_geo_rollups_v2` and comps from `recently_sold_properties`. A parallel legacy path (`match-engine.js` / Podio) and standalone `/buyer-match` view remain but are not the production cockpit path.

This pass wires the **canonical Comp Intelligence subject contract**, idempotent job snapshots, sanitized API errors, automatic matching on property selection, canonical buyer-demand outputs, and theme-safe UI tokens.

## Architecture map

| Layer | Location | Role |
| --- | --- | --- |
| Workspace UI | `apps/dashboard/src/modules/inbox/components/BuyerMatchWorkspace.tsx` | Map + buyer cards + Deal Command Dossier |
| Error sanitization | `apps/dashboard/src/domain/buyer/buyer-match-errors.ts` | UI-safe operational events |
| Coordinate resolver (shared) | `apps/dashboard/src/domain/comp-intelligence/coordinate-resolver.ts` | Same resolver as Comp Intelligence / Map |
| Canonical subject (shared) | `apps/api/src/lib/domain/comp-intelligence/canonical-subject-property.js` | Subject loader — not duplicated |
| Engine | `apps/api/src/lib/intel/buyer-match-engine.js` | RPC match, rollup, comps, persist |
| Demand output | `apps/api/src/lib/intel/buyer-match-demand.js` | Canonical liquidity/demand for offer engine |
| Job contract | `apps/api/src/lib/intel/buyer-match-job-service.js` | Idempotency + cache |
| API errors | `apps/api/src/lib/intel/buyer-match-api-errors.js` | No stack traces to clients |
| API routes | `apps/api/src/app/api/cockpit/buyer-match/**` | Property, run, candidates |
| Intel route | `apps/api/src/app/api/intel/buyer-match/route.js` | Passive prefetch (`persist:false`) |
| Legacy engine | `apps/api/src/lib/domain/buyers/match-engine.js` | Podio-only — not Supabase path |

## Data sources

### `properties`

| Attribute | Value |
| --- | --- |
| Grain | One row per property |
| Canonical ID | `property_id` |
| Join keys | `master_owner_id`, `property_address_zip`, `market` |
| Coordinates | `latitude`, `longitude` via shared `resolveCanonicalCoordinates` |
| Frontend usage | Subject rail, map centering, RPC filters |
| Gap before pass | Workspace read `dealContext.latitude` only — missed property record coords |
| Deduplication risk | Low — canonical ID is property_id |

### `buyer_purchase_events_v2`

| Attribute | Value |
| --- | --- |
| Grain | One row per verified purchase event |
| Canonical ID | Event row `id` (inferred from code) |
| Join keys | `buyer_entity_id`, `buyer_key`, `property_address_zip`, `market` |
| Columns used | `sale_date`, `purchase_price`, `normalized_asset_class`, buyer type flags |
| Coverage | Geo filters zip → market → state |
| Reliability | High when backfilled; zero rows = data gap not UI bug |
| Frontend usage | Purchase trail, fallback rollup, map pins |
| Gap before pass | UI ordered by `purchase_date` (wrong column) |
| Deduplication risk | Medium — same deed under variant grantee names |

### `buyer_entities_v2`

| Attribute | Value |
| --- | --- |
| Grain | Canonical buyer entity |
| Canonical ID | `buyer_entity_id` |
| Join keys | `buyer_key`, `markets_active`, `zips_active` |
| Coverage | Market-scoped entity counts |
| Reliability | Depends on entity graph backfill |
| Deduplication risk | High — see dedup audit |

### `buyer_geo_rollups_v2`

| Attribute | Value |
| --- | --- |
| Grain | Geo level × asset class rollup |
| Keys | `geo_level`, `geo_key`, `normalized_asset_class` |
| Metrics | `purchase_count`, `buyer_count`, `liquidity_score`, `buyer_heat_score` |
| Fallback | zip → market → state |
| Deduplication risk | Low at rollup grain |

### `buyer_match_runs` / `buyer_match_candidates`

| Attribute | Value |
| --- | --- |
| Grain | Run per property match execution; candidates per buyer per run |
| Canonical IDs | `buyer_match_run_id`, `buyer_match_candidate_id` |
| Persisted snapshot | `selected_property_snapshot` JSON with idempotency_key |
| Gap before pass | Fallback Supabase query used `run_id`, `total_match_score` (wrong columns) |
| Deduplication risk | Low — new runs versioned by idempotency key |

### `get_buyer_match_candidates` RPC

| Attribute | Value |
| --- | --- |
| Grain | Scored buyer candidate per subject search |
| Inputs | lat/lng, zip, market, state, asset_class, radius |
| Outputs | `total_match_score`, `match_grade`, `reason_for_match`, `fallback_level` |
| Reliability | Requires coordinates for best results |
| Explainability | Grade + `reason_for_match` + component scores |

### `recently_sold_properties`

| Attribute | Value |
| --- | --- |
| Grain | Sold/list evidence row |
| Shared with | Comp Intelligence comps |
| Reliability | Medium — zip/radius ranked |

### `buyer_comp_raw_v2` / views

| Attribute | Value |
| --- | --- |
| Views | `v_buyer_entity_purchases`, `v_buyer_entities_from_comps`, `v_buyer_entity_leaderboard` |
| Function | `get_buyers_for_property` (legacy dashboard RPC) |
| Migration | `20260517172105_buyer_entity_intelligence_from_comps.sql` |

### `deal_context_index`

| Attribute | Value |
| --- | --- |
| Buyer fields | `buyer_demand_score`, `buyer_match_score`, `buyer_match_count`, `buyer_match_data` |
| Integration | Universal context index refresh |

## Comp Intelligence dependency

Buyer Match consumes (does not recalculate):

- `loadCanonicalSubjectProperty` for subject identity and coordinates
- `property_valuation_snapshots` via context `valuation_snapshot_id` (idempotency)
- `recently_sold_properties` comps
- Shared coordinate resolver — **coordinate equality** with Comp Intelligence and Map when same `property_id` is selected

## Acquisition Decision Engine integration

Published via `buildCanonicalBuyerDemand`:

- `liquidity_score`, `demand_score`, `likely_buyer_price_range`, `investor_exit_range`
- `qualified_buyer_count`, grade breakdowns, `fallback_level`, `data_state`
- Consumed automatically — no manual Generate Offer gate

## Root cause: Sentry vendor-chunk UI error

| Factor | Finding |
| --- | --- |
| Symptom | `Cannot find module './vendor-chunks/@sentry.js'` in UI |
| Running processes | Two `next dev` from `rei-automation-inbox-fix` on ports 3000/3001 |
| Cause | Stale `.next` server chunks from interrupted/mixed build; API served HTML error page with webpack paths |
| Fix | Sanitize client errors; rebuild API from buyer-match worktree; never expose module paths in JSON |

## Status

| Item | Status |
| --- | --- |
| Canonical subject contract | Implemented |
| Coordinate parity | Shared resolver — proven by existing comp-intelligence tests |
| API JSON error contract | Implemented |
| Auto matching | Implemented |
| Manual command buttons | Removed from primary UX |
| Theme tokens | Dark / Light / Red Ops overrides added |
| Production buyer data | **READY FOR BUYER DATA BACKFILL** if `buyer_purchase_events_v2` empty in env |