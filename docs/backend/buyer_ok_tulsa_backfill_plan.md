# OK / Tulsa Buyer Data Backfill Plan (Read-Only)

Audit date: 2026-06-22  
Status: **PLAN ONLY — no production mutations in this pass**  
Branch: `buyer-match-production-lock`

## Objective

Enable Buyer Match for Oklahoma subjects (including **120 N 44th Ave W, Tulsa, OK 74127**, `property_id: 2109544499`) by landing verified purchase events into `buyer_purchase_events_v2` and refreshing `buyer_entities_v2` + `buyer_geo_rollups_v2`.

## Current state

| Asset | OK count | Notes |
| --- | ---: | --- |
| `buyer_comp_raw_v2` | 104 events / 66 buyers | Source of truth for OK deed comps today |
| `v_buyer_entity_purchases` | 104 | View — not consumed by match RPC |
| `recently_sold_properties` | 0 OK | **ETL blocker** for existing population function |
| `buyer_purchase_events_v2` | 0 OK | Match RPC reads this table only |
| `buyer_entities_v2` Tulsa market | 0 | No `markets_active` contains `Tulsa, OK` |

## Root cause

`populate_buyer_entities_from_sold_data()` ingests exclusively from `recently_sold_properties`. OK sales exist in `buyer_comp_raw_v2` but were never copied/normalized into `recently_sold_properties`.

## Backfill strategy (three phases)

### Phase 1 — Bridge raw comps → sold table (OK scope)

**Goal:** 104 OK rows become ETL-eligible without touching non-OK data.

Proposed migration/job: `backfill_ok_recently_sold_from_buyer_comp_raw`

```sql
-- PSEUDOCODE — review before apply_migration
INSERT INTO recently_sold_properties (
  property_id,
  property_address_full,
  property_address_city,
  property_address_state,
  property_address_zip,
  property_address_county_name,
  market,
  latitude,
  longitude,
  sale_date,
  sale_price,
  buyer_name,
  buyer_name_clean,
  is_corporate_owner,
  property_type,
  total_bedrooms,
  total_baths,
  building_square_feet,
  units_count,
  year_built,
  estimated_value,
  price_per_sqft,
  raw_payload
)
SELECT
  b.property_id,
  b.property_address_full,
  b.property_address_city,
  b.property_address_state,
  b.property_address_zip,
  NULL, -- county if available on raw
  CASE
    WHEN b.property_address_city ILIKE '%tulsa%' THEN 'Tulsa, OK'
    WHEN b.property_address_city ILIKE '%oklahoma%' THEN 'Oklahoma City, OK'
    ELSE concat_ws(', ', b.property_address_city, 'OK')
  END AS market,
  b.latitude,
  b.longitude,
  b.sale_date,
  coalesce(b.sale_price, b.mls_sold_price),
  coalesce(b.owner_name, b.owner_1_name),
  normalize_buyer_name_etl(coalesce(b.owner_name, b.owner_1_name)),
  coalesce(b.is_corporate_owner, false),
  b.property_type,
  b.total_bedrooms,
  b.total_baths,
  b.building_square_feet,
  NULL,
  b.year_built,
  NULL,
  b.price_per_sqft,
  jsonb_build_object('backfill_source', 'buyer_comp_raw_v2', 'comp_id', b.id)
FROM buyer_comp_raw_v2 b
WHERE b.property_address_state = 'OK'
  AND b.sale_date IS NOT NULL
  AND coalesce(b.sale_price, b.mls_sold_price) > 0
  AND coalesce(b.owner_name, b.owner_1_name) IS NOT NULL
ON CONFLICT (...) DO NOTHING; -- define dedup key: property_id + sale_date + buyer
```

**Pre-flight checks (read-only):**

```sql
-- Rows to bridge
SELECT COUNT(*) FROM buyer_comp_raw_v2
WHERE property_address_state = 'OK'
  AND sale_date IS NOT NULL
  AND coalesce(sale_price, mls_sold_price) > 0;

-- Tulsa metro ZIPs in raw (not 74127-heavy)
SELECT property_address_zip, COUNT(*)
FROM buyer_comp_raw_v2 WHERE property_address_state = 'OK'
GROUP BY 1 ORDER BY 2 DESC;

-- Collisions with existing recently_sold
SELECT COUNT(*) FROM buyer_comp_raw_v2 b
JOIN recently_sold_properties r ON r.property_id = b.property_id::text
WHERE b.property_address_state = 'OK';
```

**Expected outcome:** ~104 new OK rows in `recently_sold_properties` with `buyer_name` populated.

### Phase 2 — Incremental ETL into v2 tables

**Goal:** Upsert OK buyers/events without reprocessing entire 55k national dataset.

Option A (preferred): Add parameter to existing function:

```sql
populate_buyer_entities_from_sold_data(
  p_dry_run boolean DEFAULT false,
  p_state_filter text DEFAULT NULL  -- 'OK' for incremental
)
```

Option B: One-shot SQL job mirroring Phase 1+2 of existing function scoped to `property_address_state = 'OK'`.

**Execution order:**

1. `SELECT populate_buyer_entities_from_sold_data(true);` — baseline dry-run
2. Apply OK bridge migration
3. `SELECT populate_buyer_entities_from_sold_data(false);` — or OK-scoped variant
4. `SELECT rebuild_buyer_geo_rollups();`

**Dedup key (existing):**

```
md5(buyer_key || '::' || property_id || '::' || sale_date)
```

Stored as `source_dedup_key` on `buyer_purchase_events_v2`.

### Phase 3 — Geo rollups + validation

**Rollup keys to expect after backfill:**

| geo_level | geo_key | Expected |
| --- | --- | --- |
| state | `OK` | ~104 purchases |
| market | `Tulsa, OK` | ~15–25 (Tulsa ZIPs) |
| market | `Oklahoma City, OK` | ~60–80 |
| zip | `74110`, `74104`, `73110`, … | per-ZIP counts |

**Validation queries:**

```sql
-- Tulsa subject coordinates
SELECT property_id, latitude, longitude, market
FROM properties WHERE property_id = '2109544499';

-- RPC after backfill (expect limited matches — sparse 74127 data)
SELECT buyer_name, match_grade, total_match_score, fallback_level, reason_for_match
FROM get_buyer_match_candidates(
  '2109544499', 36.156445, -96.042336,
  '74127', 'Tulsa, OK', 'OK', NULL, 'single_family', NULL, 25, 10
);

-- Houston control (must remain stable)
SELECT COUNT(*) FROM get_buyer_match_candidates(
  '2131309217', 29.841899, -95.464943,
  '77091', 'Houston, TX', 'TX', NULL, 'single_family', NULL, 25, 25
);
```

**Realistic Tulsa expectation after Phase 1–2:**

- Subject `2109544499` may still show **low match count** — only 1 raw comp in ZIP 74127
- Matches should appear at **`fallback_level: radius` or `state`** from Tulsa/OKC purchases within 25mi
- `data_state` should become `buyers_exist_no_match` or partial match — **not** `source_unavailable`

## Phase 4 — Expand raw comp ingest (beyond 104 rows)

104 OK events is insufficient for production Tulsa liquidity. Separate ingest work required:

| Source | Target | Grain |
| --- | --- | --- |
| County deed recordings | `buyer_comp_raw_v2` | Grantee + sale price + date |
| MLS sold feed (OK metros) | `buyer_comp_raw_v2` | Arms-length sales |
| Existing `properties` OK portfolio | linkage | `property_id` join |

Target: **500+ Tulsa metro purchase events** for meaningful `zip`/`radius` tier matching.

## Entity deduplication rules (backfill)

Apply during ETL — do not merge on name alone:

| Signal | Action |
| --- | --- |
| `generate_buyer_key_etl(normalize_buyer_name_etl(name))` | Canonical `buyer_key` |
| Same key + different mailing address | Keep single entity; flag `contact_enrichment_status` |
| Same phone/email (future) | High-confidence person link |
| Similar names, different keys | **Flag ambiguous** — do not merge |

Corporate detection (existing): regex on `(llc|inc|corp|trust|holdings|group|capital|...)`.

## Hard exclusions (preserve in backfill)

Do not ingest as matchable buyers:

- Government grantees (`State Of ...`) unless institutional scan explicitly wants them
- Zero-price or missing `sale_date`
- Duplicate `source_dedup_key` collisions

## Job contract after backfill

Buyer Match auto-run should detect:

- `buyer_demand.data_state` transitions from `source_unavailable` → `market_only_fallback` or better
- `fallback_level` ≠ `none` when OK events exist
- Idempotency: re-running ETL must not duplicate events (`source_dedup_key`)

## Rollback plan

1. Delete OK rows from `buyer_purchase_events_v2` where `source = 'recently_sold_properties_etl'` and `property_state = 'OK'`
2. Delete OK `buyer_entities_v2` where `markets_active && ARRAY['Tulsa, OK','Oklahoma City, OK']`
3. Delete OK bridge rows from `recently_sold_properties` where `raw_payload->>'backfill_source' = 'buyer_comp_raw_v2'`
4. `SELECT rebuild_buyer_geo_rollups();`

## Acceptance criteria

| Check | Pass condition |
| --- | --- |
| OK events in v2 | `COUNT(*) > 0` where `property_state = 'OK'` |
| Tulsa rollup | Row exists for `geo_level=market, geo_key='Tulsa, OK'` |
| RPC Houston control | Still returns 10+ matches |
| RPC Tulsa subject | Returns JSON (not error); `fallback_level` ≠ `none` OR explainable empty with `data_state=buyers_exist_no_match` |
| No duplicate events | `source_dedup_key` unique per event |
| UI | Buyer Match shows non-zero purchase events for OK ZIP queries using `property_zip` column |

## Status

**READY TO EXECUTE** — pending explicit approval for `apply_migration` + ETL run. This document is read-only planning only.