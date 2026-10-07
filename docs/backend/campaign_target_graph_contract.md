# Campaign Target Graph — Build Contract

**Verified:** 2026-08-17, against production (`lcppdrmrdfblstpcbgpf`), read-only.
All figures below are measured, not inferred.

---

## 1. What the graph is

`campaign_target_graph` is the **projection campaigns target against**. It is one
row per property, denormalised with owner / prospect / phone / routing /
suppression facts. Campaign Reach, target building, and every eligibility count
read this table — not `properties` directly.

If a property is absent from the graph, it is invisible to campaigns, regardless
of its state in `properties`.

---

## 2. The two passes

A complete graph is produced by **two passes over `properties`**, staged into
`campaign_target_graph_stage` and then swapped into the live table.

### Pass 1 — owner-linked

`refresh_campaign_target_graph_stage_batch(run_id, limit, offset, state, market)`

```sql
FROM public.properties p
WHERE NULLIF(p.master_owner_id, '') IS NOT NULL
  AND (state/market filters)
ORDER BY COALESCE(NULLIF(p.property_id,''), NULLIF(p.property_export_id,'')) NULLS LAST,
         p.property_export_id NULLS LAST
LIMIT limit OFFSET offset
```

Contributes the **owner-linked** subset, enriched through `master_owner_id`.
Batch types: `property_offset`, `state_property_offset`, `market_property_offset`.

### Pass 2 — fallback sweep

`refresh_campaign_target_graph_fallback_batch(run_id, limit, offset, state, market)`

```sql
FROM public.properties p
WHERE (state/market filters)
  AND NOT EXISTS (SELECT 1 FROM campaign_target_graph_stage s WHERE s.property_id = p.property_id)
  AND NOT EXISTS (SELECT 1 FROM campaign_target_graph_stage s WHERE s.property_export_id = p.property_export_id)
```

**No owner requirement.** Sweeps every property pass 1 did not stage.
Batch type: `missing_owner_json_property_offset`.

### Both passes are required

| | |
|---|---|
| Historical batches, all runs | 1,219 |
| — `missing_owner_json_property_offset` (pass 2) | **809** |
| — `state_property_offset` (pass 1) | 335 |
| — `state_property_universe_offset` | 75 |

Pass 2 produced the **majority** of the graph. Arithmetic confirms the intent:

```
graph rows (Jun 13)          124,046
properties added since        45,751
                             --------
properties total today       169,797   ← exact
```

The graph is **every property**, with owner-linked ones enriched. It is not a
filtered subset.

---

## 3. The defect this contract exposes

`refresh_campaign_target_graph()` — the function behind
`/api/internal/campaigns/rebuild-target-graph` — is a 431-character wrapper:

```sql
SELECT * FROM public.refresh_campaign_target_graph_staged(10000, NULL);
```

and `_staged` loops **only pass 1**, then commits. It never calls
`fallback_batch`. **The canonical "full refresh" cannot reproduce the graph.**

Measured impact of running it today:

| | |
|---|---|
| Live graph | 124,046 rows (94,723 owner-linked, 76.4%) |
| Pass 1 alone would stage | **41,532** |
| Net | **−82,514 rows (−67%)** |

The database's `refused_partial_commit` guard does **not** catch this. That guard
asks whether the run completed all of *its* batches — which it does. The run's
definition of "all" is the bug.

---

## 4. Invariants a complete graph must satisfy

| # | Invariant | Live value (Jun 13 build) |
|---|---|---|
| I1 | One row per property — `count(*) = count(distinct property_id)` | 124,046 = 124,046 ✅ |
| I2 | Covers the full source universe at build time | 124,046 of 124,046 ✅ |
| I3 | Owner coverage tracks owner-side linkage | 94,723 (76.4%) |
| I4 | Never empty | ✅ |
| I5 | Never materially smaller than its predecessor without cause | — |
| I6 | Reachability is a subset: phone ⊆ prospect ⊆ rows | 81,306 = 81,306 ≤ 124,046 ✅ |

I5 and I3 are the ones the existing guards missed, and the ones
`campaign-target-graph-integrity.js` now enforces.

---

## 5. Owner-link truth: which side is authoritative

The `properties.master_owner_id` column is **not** the source of truth. It is a
degraded denormalisation. The authoritative linkage lives on the owner side,
`master_owners.joined_property_ids_json`:

| Measurement | Count |
|---|---|
| `master_owners` rows | 102,251 |
| Owner→property links | 124,203 |
| Distinct properties on the owner side | **124,140** |
| Linked on **both** sides | 33,387 |
| **Owner claims the property, `properties.master_owner_id` is NULL** | **82,469** |
| Property claims an owner the owner does not claim | 7,853 |

`124,140` owner-side properties ≈ `124,046` graph rows. **The graph was built
from the owner side.** `properties.master_owner_id` covers only 41,532.

### Root cause of the "75% unlink"

It is **not** source-truth loss, and it is **not** a graph-build defect in the
existing graph. It is a **denormalisation gap**: the owner→property links exist
and are intact, but the reverse pointer on `properties` was never populated for
82,469 of them.

Pass 1 reads that degraded reverse pointer. That is why a rebuild collapses.

**Consequence:** the live June graph is currently a *better* record of owner
linkage than `properties` is, for 53,193 properties whose owner still exists in
`master_owners`. A naive rebuild would discard it.

---

## 6. Is the graph safe to rebuild?

**No — not via the current pipeline.**

| Path | Verdict |
|---|---|
| `refresh_campaign_target_graph()` / the rebuild route | ❌ **Unsafe.** Single pass, −67%, now blocked by preflight |
| `refresh_campaign_target_graph_staged()` | ❌ Same defect — pass 1 only |
| Manual `stage_start → stage_batch → fallback_batch → stage_commit` | ⚠️ Correct semantics, but unproven since June and unbounded (~52 min) |
| Fixing `properties.master_owner_id` first, then rebuilding | ✅ Preferred — restores the reverse pointer so pass 1 covers its real population |

### Prerequisites before any rebuild

1. Repair `properties.master_owner_id` from `master_owners.joined_property_ids_json`
   (82,469 rows), **or** change pass 1 to read the owner side directly.
2. Prove the two-pass sequence end to end on a scoped run (`state`/`market`
   filters exist on both batch functions).
3. Keep the integrity gates in the commit path, not only in the route.

---

## 7. Guards now in place

`campaign-target-graph-integrity.js` — evaluated **before** commit, fails closed:

| Gate | Blocks |
|---|---|
| `empty_stage` | staged rows < 1 |
| `row_count_delta` | staged < 95% of live |
| `uniqueness` | duplicate `property_id` in stage |
| `source_coverage` | stage covers < 95% of source universe |
| `owner_coverage` | owner % drops > 5 points |
| `owner_absolute` | owner-linked rows drop below 95% of live |
| `measurement` | any count unreadable — unknown never passes |

`owner_absolute` exists because percentage alone is a trap: a 41,532-row graph
that is 100% owner-linked *improves* the ratio while losing 53,191 owner-linked
properties.

Thresholds are parameters, not constants, so cadence and tolerance can change
without editing the gate.
