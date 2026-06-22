# `get_buyer_match_candidates` RPC Reference

Audit date: 2026-06-22  
Project: `real-estate-automation` (`lcppdrmrdfblstpcbgpf`)  
Source: live `pg_get_functiondef` via Supabase linked CLI

## Signature

```sql
get_buyer_match_candidates(
  p_property_id text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_zip text DEFAULT NULL,
  p_market text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_county text DEFAULT NULL,
  p_asset_class text DEFAULT NULL,
  p_estimated_value numeric DEFAULT NULL,
  p_radius_miles numeric DEFAULT 25,
  p_limit integer DEFAULT 25
)
```

Returns one row per matched buyer with explainable score components, grade, `fallback_level`, and `reason_for_match`.

## Data sources

| Source | Role |
| --- | --- |
| `buyer_purchase_events_v2` | Geographic event pool (zip, lat/lng bbox, state) |
| `buyer_entities_v2` | Entity metadata joined on `buyer_key` |

Helper functions used: `intel_normalize_zip`, `intel_normalize_state`, `intel_normalize_market`, `intel_normalize_asset_class`, `intel_haversine_miles`, `intel_clean_price`.

## Matching tiers (geo)

Events are tiered per buyer:

| Tier | Condition | `fallback_level` label |
| ---: | --- | --- |
| 5 | Exact normalized ZIP match | `zip` |
| 4 | Within `p_radius_miles` of subject lat/lng (bbox prefilter ±0.6°) | `radius` |
| 3 | Normalized market match | `market` |
| 2 | County match | `county` |
| 1 | State match | `state` |
| 0 | Excluded | — |

Initial event filter requires **one of**:

- `property_zip = n_zip`
- lat/lng bounding box around subject
- `property_state = n_state`

Buyers with `tier > 0` proceed to scoring.

## Score components (weights)

| Component | Weight | Inputs |
| --- | ---: | --- |
| Geographic fit (`geo_score`) | 30% | Best tier + distance decay for tier 4 |
| Asset fit (`asset_val`) | 15% | Dominant purchase asset vs subject `p_asset_class` |
| Price fit (`price_val`) | 15% | `p_estimated_value` vs buyer avg matched price |
| Recency (`recency_val`) | 15% | Last matched purchase date buckets |
| Repeat buyer (`repeat_val`) | 10% | Entity `purchase_count` |
| Spread fit (`spread_val`) | 10% | `avg_potential_spread` |
| Institutional bonus | 5% | `buyer_type` (institutional/trust/corporate) |
| Volume bonus | 5% | Matched event count near subject |

`total_match_score = min(100, weighted sum)`.

## Grading rules

| Grade | Weighted component threshold |
| --- | --- |
| A+ | ≥ 88 |
| A | ≥ 76 |
| B | ≥ 62 |
| C | ≥ 48 |
| D | < 48 |

## Explainability output

`reason_for_match` concatenates:

- ZIP purchase count when `zip_cnt > 0`
- Nearest purchase distance in miles
- "active local buyer" when `matched_cnt >= 3`
- Institutional/trust label when applicable
- "bought in last 6mo" when `last_matched_date >= current_date - 180`

`fallback_level` is derived from the **best tier across all returned buyers** (global max), not per-row.

## Production validation

| Subject | property_id | Result |
| --- | --- | --- |
| 120 N 44th Ave W, Tulsa OK 74127 | `2109544499` | `[]` — no OK events in `buyer_purchase_events_v2` |
| 4940 Broom St, Houston TX 77091 | `2131309217` | 5+ A-grade buyers, scores 87–88, `fallback_level: zip` |

## Implications for Tulsa

RPC is **working correctly**. Tulsa returns empty because `buyer_purchase_events_v2` has **zero OK rows**. Subject coordinates (`36.156445, -96.042336`) are valid; the purchase graph for OK has not been ETL'd into v2 tables yet.