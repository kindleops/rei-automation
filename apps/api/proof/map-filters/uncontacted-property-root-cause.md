# Uncontacted Property Root Cause — Map Master Filters

Date: 2026-07-06  
Status: **Closed**

## Symptom

Uncontacted properties appeared missing from the Master Filters property universe. Preview counts, presets, and apply flow did not reconcile with the full `public.properties` table (baseline **124,046** rows).

## Investigation paths

| Path | Finding |
|------|---------|
| Preview count SQL | `buildMatchingPropertiesCte` always required `latitude/longitude IS NOT NULL`, shrinking the universe before any user rule |
| Token predicate SQL | Empty expression compiles to `TRUE` — no implicit prospect/phone join |
| Aggregate SQL | Filtered path uses same CTE; unfiltered RPC reads `public.properties` directly |
| Cluster SQL | Same as aggregates |
| Bounds SQL | Geo required (expected for viewport) |
| MVT SQL | Reads `public.properties`; no contact predicate without token |
| Dashboard filter state | No default filter token applied at mount |
| Legacy seller-lead source | `v_command_map_seller_pin_feed` is seller-overlay only; not used by filter engine |
| Implicit contact filter | None in compiler; bug was UI + count CTE geo gate |
| INNER JOIN prospects/phones | Only inside explicit `prospect_rule` / `phone_rule` EXISTS — not on empty stack |

## Exact failing query path

**Preview / count service** (`map-filter-count-service.js` → `buildMatchingPropertiesCte`):

```sql
SELECT DISTINCT p.property_id, p.master_owner_id
FROM properties p
WHERE p.latitude IS NOT NULL          -- implicit universe shrink
  AND p.longitude IS NOT NULL         -- implicit universe shrink
  AND (TRUE)                          -- empty filter stack
```

**Frontend preview hook** (`useMapFilterPreview.ts`):

- Skipped network preview when `activeRuleCount === 0`, so Results showed `—` instead of 124,046.

**Apply flow** (`MasterFiltersProvider.tsx`):

- Blocked apply when `activeRuleCount === 0`, preventing “Show all properties” restoration.

**Uncontacted preset**:

- Missing from `MAP_FILTER_PRESET_CATALOG`; `has_phone` incorrectly used `prospect.has_phone`, excluding properties without linked prospects.

## Exact implicit condition

1. **Geo gate on count CTE** — non-geocoded authorized properties excluded from preview counts.
2. **Zero-rule preview skip** — UI never requested full-universe count.
3. **Prospect-derived Has Phone preset** — treated phone presence as prospect presence.

## Affected routes

- `POST /api/internal/dashboard/ops/map/filters/preview`
- `POST /api/internal/dashboard/ops/map/filters/token`
- `GET /api/internal/dashboard/ops/map?filter=<token>` (filtered aggregates/clusters/bounds)
- `GET /api/internal/dashboard/ops/map/tiles/{z}/{x}/{y}?filter=<token>`

## Affected map sources

- Preview counts (primary user-visible failure)
- Filtered MVT / aggregates / clusters / bounds (geo gate consistent with map representation; counts now separate)

## Counts

| Scenario | Before (broken) | After (fixed) |
|----------|-----------------|---------------|
| No filters — property count | Subset with lat/lng only; UI showed `—` | **124,046** via `public.properties` |
| Uncontacted preset | No preset / wrong prospect proxy | Canonical `contact_status` OR NULL |
| Contacted preset | No preset | Canonical `contact_status` NOT uncontacted bucket |

## Fix applied

1. `buildMatchingPropertiesCte(..., { requireGeo })` — geo required only for bounds/map paths; count preview uses full table.
2. `contact-status-semantics.js` — canonical uncontacted/contacted expression builders.
3. System presets: `all_properties`, `uncontacted`, `contacted`; `has_phone` moved to phone bridge.
4. Field aliases/synonyms for search: uncontacted, contacted, no contact, etc.
5. Frontend (commits 3–6): preview always runs; apply shows live count; zero-rule “Show N Properties”.

## Regression tests

`apps/api/tests/unit/map-filter-universe.test.mjs` — nine cases covering empty universe, orphan properties, contact semantics, entity-scoped rules, and SQL shape proofs.