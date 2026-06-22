# Buyer Match Market Coverage Audit

Audit date: 2026-06-22  
Project: `real-estate-automation` (`lcppdrmrdfblstpcbgpf`)  
Method: Supabase linked CLI (read-only)

## Executive summary

Buyer Match v2 is **production-ready for TX, MO, AZ, CA, GA, MN** markets where `buyer_purchase_events_v2` is populated. **Oklahoma (Tulsa, OKC) is a coverage gap**: 5,726 acquisition properties exist but **zero purchase events** reached v2 tables.

The gap is an **ETL pipeline issue**, not a matching-engine or UI bug.

## Table row counts

| Table | Rows |
| --- | ---: |
| `properties` | 124,046 |
| `buyer_entities_v2` | 26,390 |
| `buyer_purchase_events_v2` | 55,479 |
| `buyer_geo_rollups_v2` | 3,211 |
| `buyer_comp_raw_v2` | 47,985 |
| `recently_sold_properties` | 55,893 |
| `buyer_match_runs` | 12 |
| `buyer_match_candidates` | 225 |

## `buyer_purchase_events_v2` by state

| State | Events | Unique buyers |
| --- | ---: | ---: |
| TX | 34,825 | 15,641 |
| AZ | 6,510 | 3,023 |
| MO | 5,546 | 2,225 |
| CA | 5,186 | 4,113 |
| GA | 2,044 | 666 |
| MN | 1,368 | 871 |
| **OK** | **0** | **0** |

## `buyer_purchase_events_v2` by market label

| Market | Events | Unique buyers |
| --- | ---: | ---: |
| Other | 20,532 | 10,783 |
| Houston, TX | 18,046 | 8,477 |
| Dallas, TX | 14,607 | 6,071 |
| Austin/San Antonio, TX | 2,258 | 1,425 |

No `Tulsa, OK` or `Oklahoma City, OK` market labels exist in v2 events.

## `buyer_geo_rollups_v2` top keys

Rollups exist for: `TX`, `Houston, TX`, `Dallas, TX`, `MO`, `Saint Louis, MO`, `AZ`, `Phoenix, AZ`, `CA`, `Austin/San Antonio, TX`.

**No `OK`, `Tulsa, OK`, or `74127` rollup keys.**

## Properties vs buyer data (Oklahoma)

| Source | OK coverage |
| --- | --- |
| `properties` (OK state) | **5,726** (Tulsa 3,264 · OKC 2,459) |
| `buyer_comp_raw_v2` (OK state) | **104** events · **66** unique normalized buyers |
| `v_buyer_entity_purchases` (OK) | **104** (view over raw comps) |
| `recently_sold_properties` (OK) | **0** |
| `buyer_purchase_events_v2` (OK) | **0** |
| `buyer_entities_v2` with `markets_active @> ['Tulsa, OK']` | **0** |

## ETL pipeline (root cause)

Current v2 population function:

```
populate_buyer_entities_from_sold_data()
  └── reads ONLY recently_sold_properties (buyer_name required)
        └── upserts buyer_entities_v2 + buyer_purchase_events_v2
              └── rebuild_buyer_geo_rollups() refreshes rollups
```

Dry-run stats (2026-06-22):

```json
{
  "dry_run": true,
  "rows_scanned": 55893,
  "entities_would_create_or_update": 26390,
  "events_would_create_or_update": 55893,
  "markets_covered": 4,
  "repeat_buyers_found": 5656,
  "corporate_buyers_found": 26390
}
```

`markets_covered: 4` = TX/MO/AZ/CA pipeline only. OK raw comps never enter `recently_sold_properties`, so they never reach v2.

## Tulsa ZIP 74127 specifics

| Source | 74127 rows |
| --- | ---: |
| `properties` | Many (incl. subject `2109544499`) |
| `buyer_comp_raw_v2` | **1** (1407 W Admiral Blvd — Zella Mugg LLC, $84k, 2025-11-24) |
| `buyer_purchase_events_v2` | **0** |
| RPC matches for subject | **0** |

Subject **120 N 44th Ave W** has coordinates but no nearby purchase events in v2 — nearest raw comp in 74127 is a different address.

## Markets with repeat-buyer liquidity (working)

Top purchase ZIPs in v2: `63136`, `76179`, `76036`, `77091`, `63137` — STL + DFW + Houston corridors.

Houston `77091` RPC returns A-grade institutional/corporate buyers with explainable reasons.

## Missing markets (properties exist, buyer v2 empty)

| Market | Properties | Raw comps (OK only) | v2 events |
| --- | ---: | ---: | ---: |
| Tulsa, OK | 3,264 | ~15 ZIPs incl. 74110, 74104 | 0 |
| Oklahoma City, OK | 2,459 | ~20 ZIPs incl. 73110, 73127 | 0 |

## Recommended priority backfill order

1. **OK from `buyer_comp_raw_v2`** (104 rows — immediate unblock)
2. **Broader OK deed ingest** into `buyer_comp_raw_v2` / `recently_sold_properties`
3. **Incremental ETL** — extend `populate_buyer_entities_from_sold_data` or add OK-specific path
4. **`rebuild_buyer_geo_rollups()`** after events land
5. **Re-validate** Tulsa subject + Houston control property

See: [`buyer_ok_tulsa_backfill_plan.md`](./buyer_ok_tulsa_backfill_plan.md)