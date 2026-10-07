# Owner Reverse-Pointer Backfill — PREPARED, NOT EXECUTED

**Prepared:** 2026-08-17 · all figures measured read-only against production.
**Status:** awaiting explicit authorization. Nothing in this document has been run.

---

## 1. What this repairs

`properties.master_owner_id` is a denormalised reverse pointer to the
authoritative ownership held in `master_owners.joined_property_ids_json`. An
importer defect erased it on re-import (see the migration header for the
mechanism). This restores it where ownership is unambiguous.

**It does not create ownership.** Every candidate already has an owner that
claims it. This only re-materialises the pointer.

---

## 2. Candidate classification — all 124,140 owner-claimed properties

| Class | Count | Action |
|---|---:|---|
| **SAFE_UNAMBIGUOUS** — exactly one owner claims it, pointer is NULL | **82,343** | **repair** |
| ALREADY_CORRECT — pointer already matches the sole claiming owner | 33,387 | skip (no-op) |
| STALE_REFERENCE — owner JSON references a property that no longer exists | 8,055 | skip, investigate separately |
| EXISTING_DIFFERENT_OWNER — pointer set but disagrees with owner side | 292 | **skip — needs human adjudication** |
| CONFLICT — more than one master owner claims the property | 63 | **skip — needs dedupe** |
| **Total** | **124,140** | reconciles exactly |

`82,343 + 33,387 + 8,055 + 292 + 63 = 124,140` ✅

Only **SAFE_UNAMBIGUOUS** is in scope. The 292 disagreements and 63 conflicts are
deliberately excluded: overwriting a populated pointer, or picking one of several
claimants, is a data decision this repair has no basis to make.

---

## 3. Step 1 — freeze the candidate set (read + capture only)

```sql
CREATE TABLE owner_reverse_pointer_backfill_20260818 AS
WITH owner_links AS (
  SELECT m.master_owner_id,
         jsonb_array_elements_text(m.joined_property_ids_json) AS property_id
  FROM public.master_owners m
  WHERE jsonb_typeof(m.joined_property_ids_json) = 'array'
),
claims AS (
  SELECT property_id,
         count(DISTINCT master_owner_id) AS n_owners,
         min(master_owner_id)            AS sole_owner
  FROM owner_links
  GROUP BY property_id
)
SELECT p.property_id,
       p.master_owner_id AS prev_master_owner_id,   -- NULL by definition
       c.sole_owner      AS new_master_owner_id,
       p.updated_at      AS prev_updated_at,
       now()             AS captured_at
FROM claims c
JOIN public.properties p ON p.property_id = c.property_id
WHERE c.n_owners = 1
  AND NULLIF(p.master_owner_id, '') IS NULL;

-- Expect exactly 82,343
SELECT count(*) AS frozen, count(DISTINCT property_id) AS distinct_ids
FROM owner_reverse_pointer_backfill_20260818;
```

**Abort if `frozen <> distinct_ids`** — a duplicate would mean the classification
is wrong.

---

## 4. Step 2 — pre-flight guards (all must return 0)

```sql
SELECT
  (SELECT count(*) FROM owner_reverse_pointer_backfill_20260818 b
     LEFT JOIN properties p ON p.property_id = b.property_id
    WHERE p.property_id IS NULL)                                   AS v_property_vanished,
  (SELECT count(*) FROM owner_reverse_pointer_backfill_20260818 b
     JOIN properties p ON p.property_id = b.property_id
    WHERE NULLIF(p.master_owner_id,'') IS NOT NULL)                AS v_pointer_now_set,
  (SELECT count(*) FROM owner_reverse_pointer_backfill_20260818 b
     LEFT JOIN master_owners m ON m.master_owner_id = b.new_master_owner_id
    WHERE m.master_owner_id IS NULL)                               AS v_owner_vanished,
  (SELECT count(*) FROM owner_reverse_pointer_backfill_20260818 b
     JOIN properties p ON p.property_id = b.property_id
    WHERE p.updated_at IS DISTINCT FROM b.prev_updated_at)         AS v_row_changed_since_freeze,
  (SELECT count(*) FROM owner_reverse_pointer_backfill_20260818
    WHERE NULLIF(new_master_owner_id,'') IS NULL)                  AS v_no_target_owner;
```

**Any non-zero aborts the run.** `v_row_changed_since_freeze` is the important
one: it guarantees no relationship moved between freeze and write.

---

## 5. Step 3 — the update (joined only to frozen IDs)

```sql
WITH updated AS (
  UPDATE public.properties p
     SET master_owner_id = b.new_master_owner_id,
         updated_at      = now()
    FROM owner_reverse_pointer_backfill_20260818 b
   WHERE p.property_id = b.property_id
     AND NULLIF(p.master_owner_id, '') IS NULL      -- re-assert at write time
     AND p.updated_at IS NOT DISTINCT FROM b.prev_updated_at
  RETURNING p.property_id
)
SELECT count(*) AS rows_updated FROM updated;   -- expect 82,343
```

**Idempotent.** The `IS NULL` predicate means a second run updates 0 rows. Safe to
re-run after a partial failure.

**Note:** the preserve-trigger from migration
`20260818000000` does not interfere — it only guards NULL-over-non-NULL, and this
writes non-NULL over NULL.

---

## 6. Step 4 — post-validation

```sql
SELECT
  (SELECT count(*) FROM properties WHERE NULLIF(master_owner_id,'') IS NOT NULL) AS linked_after,   -- expect 41,532 + 82,343 = 123,875
  (SELECT count(*) FROM properties)                                              AS properties_total, -- expect 169,797 (unchanged)
  (SELECT count(*) FROM campaign_target_graph)                                   AS graph_rows,      -- expect 124,046 (untouched)
  (SELECT count(*) FROM owner_reverse_pointer_backfill_20260818 b
     JOIN properties p ON p.property_id = b.property_id
    WHERE p.master_owner_id = b.new_master_owner_id)                             AS verified_repaired; -- expect 82,343
```

Expected end state: **123,875 linked** (72.9% of all properties), up from 41,532
(24.5%). Property count unchanged. **Graph untouched** — this repair does not
rebuild it.

---

## 7. Rollback

```sql
UPDATE public.properties p
   SET master_owner_id = b.prev_master_owner_id,   -- NULL
       updated_at      = b.prev_updated_at
  FROM owner_reverse_pointer_backfill_20260818 b
 WHERE p.property_id = b.property_id
   AND p.master_owner_id = b.new_master_owner_id;  -- only undo what we set
```

The audit table retains `prev_master_owner_id` and `prev_updated_at` for every
row. Retain it through verification and the first graph rebuild.

---

## 8. What this does NOT fix

- **The 45,749 August properties.** Only 29 have owner-side links. They arrived
  with no ownership data on either side. This is an ingestion-completeness
  problem upstream, not a pointer problem, and no backfill can invent it.
- **The 8,055 stale references** — owner JSON pointing at absent properties.
- **The 292 disagreements and 63 multi-owner conflicts** — need adjudication.
- **The graph.** Repairing pointers makes a correct rebuild *possible*; it does
  not perform one.

---

## 9. Order of operations

1. Apply migration `20260818000000` (stops further erosion) — **first**, so the
   repair cannot be undone by the next import.
2. Deploy the corrected `rei-import` function.
3. Run this backfill.
4. Only then consider a graph rebuild.

Running the backfill before step 1 would repair 82,343 rows that the next import
could erase again.
