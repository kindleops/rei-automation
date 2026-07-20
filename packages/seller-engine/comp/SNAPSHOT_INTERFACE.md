# Comp/Market Snapshot Interface (P2-2)

Versioned immutable contract between the comp engine and the seller engine. The seller engine consumes **snapshot documents only** — never mutable live views — so historical scores reproduce exactly.

## Contract (all fields required; `snapshotAdapter.mjs` validates)

| Field | Type | Meaning |
|---|---|---|
| `id` | text | immutable snapshot id (`mfs_…`) |
| `subject_property_id` | text | canonical property id |
| `as_of` | timestamptz | computation time; usable only for scoring `as_of >= snapshot.as_of` |
| `asset_class` / `asset_subtype` | text | routing key |
| `cohort_rung` | 1–7 | ladder rung actually used (NORM §2) |
| `cohort_key` | text | e.g. `IL|17031|sfr` |
| `cohort_n` | int | observations behind the statistics (min 12; degradation self-reported in `warnings`) |
| `selected_comp_ids` | text[] | comps used |
| `comp_eligibility` | jsonb | per-comp inclusion reason (distance, recency, physical similarity, transaction reliability) |
| `comp_exclusions` | jsonb | per-comp exclusion reason (non-arms-length, stale, dissimilar, unreliable price) |
| `weighted_comp_score` | numeric | similarity-weighted composite |
| `valuation_low` / `valuation_high` | numeric | valuation range |
| `valuation_confidence` | 0–1 | |
| `sale_velocity` | numeric | local absorption/DOM composite |
| `inventory_absorption` | numeric | |
| `buyer_velocity` | numeric | investor transaction velocity |
| `buyer_demand_confidence` | 0–1 | coverage-gated (state gaps) |
| `warnings` | text[] | missing-data / degradation notices |
| `source_engine` | text | producer + version (`comp_intelligence_v4@<sha>`) |

Distance, recency, and physical-similarity live inside `comp_eligibility` per comp id.

## Rules

1. **Immutability:** snapshots are append-only; a new computation is a new id. The draft DDL (`market_feature_snapshots`) has no update path.
2. **Time safety:** `snapshotForAsOf()` selects the newest snapshot with `snapshot.as_of <= scoring as_of`; none ⇒ market/discount/EEV features emit `blocked` with reduced confidence (P2-2 locked). No synthesized values.
3. **Producer:** the existing comp infrastructure (audit: `apps/api/src/lib/acquisition/*` over `buyer_comp_raw_v2`; Comp Intelligence V4 rebuild) is the intended producer via a thin exporter — no from-zero rebuild. Live read-only Supabase inspection is authorized and scheduled with pilot ingestion (open decision P3-2).
4. **Fixture-proven:** `tests/comp-snapshot.test.mjs` proves validation, as-of selection, and engine consumption (F-055 known with snapshot, blocked without).
