# Offerr comp-intelligence — canonical database contract

**Schema contract version: `1.0.0`**
**Recovered: 2026-07-30 from Supabase project `lcppdrmrdfblstpcbgpf` (production), read-only.**

This directory is the source-controlled definition of the database surface the
Offerr evaluation spine needs in order to retrieve comparable sales. Before it
existed, four of the five objects the spine depends on were defined **nowhere in
this repository** — they had been created out of band directly against
production, so a newly created Supabase project could not run the Offerr comp
path at all, and no test could prove that staging behaved like production.

---

## 1. What is in here

| File | Object | Parity class |
|---|---|---|
| `canonical/010_properties.sql` | `public.properties` | Compatible reconstruction (read-surface subset) |
| `canonical/020_buyer_comp_raw_v2.sql` | `public.buyer_comp_raw_v2` | Exact production column contract (167/167) |
| `canonical/030_buyer_entities_v2.sql` | `public.buyer_entities_v2` | Exact production column contract (49/49) |
| `canonical/040_v_recent_sold_comps.sql` | `public.v_recent_sold_comps` | **Exact production definition (verbatim)** |
| `canonical/050_get_comp_candidates_for_subject.sql` | `public.get_comp_candidates_for_subject` | **Exact production definition (verbatim)** |
| `schema-contract.json` | machine-readable contract | drives drift detection + tests |

`schema-contract.json` is the single machine-readable source of truth. The
drift checker (`apps/api/scripts/offerr/offerr-schema-drift-check.mjs`) and the
contract tests both read it; nothing hard-codes the contract a second time.

### Parity classes used in this repository

| Class | Meaning |
|---|---|
| `EXACT_PRODUCTION_DEFINITION` | Recovered verbatim via `pg_get_functiondef` / `pg_get_viewdef`. Re-creating this file in a fresh PostgreSQL 17 database and reading the catalog back produces a **byte-identical** string. Proven by test, not asserted. |
| `EXACT_PRODUCTION_COLUMN_CONTRACT` | Every production column reproduced with exact type, nullability and default. Verified column-by-column against the recovered catalog. |
| `COMPATIBLE_RECONSTRUCTION_...` | A deliberate, enumerated subset or adaptation. Every deviation is listed in the file header. |
| `BEHAVIOURAL_STAND_IN` | Same signature, different implementation. **Nothing in this directory is in this class any more.** The previous stand-in has been deleted. |

---

## 2. The real comp-retrieval path

This is what actually executes when nothing is injected. It was traced through
live code, not read off comments.

```
offerr-evaluation-service.js
  └── loadV3CompCandidates(subject, deps)              compCandidateLoader.js
        ├── (1) db.rpc('get_comp_candidates_for_subject', {
        │            p_subject_property_id, p_radius_miles,
        │            p_months_back, p_limit: 100 })
        │      └── subject CTE  ← public.v_recent_sold_comps
        │                        UNION ALL fallback → public.properties
        │      └── candidates   ← public.v_recent_sold_comps
        │                          WHERE is_usable_comp
        │                            AND property_id IS DISTINCT FROM subject
        │                            AND sale_date >= current_date - p_months_back
        │                            AND latitude/longitude IS NOT NULL
        │                          HAVING distance_miles <= p_radius_miles
        │
        ├── (2) db.from('buyer_comp_raw_v2')
        │         .select(RAW_IDENTITY_SELECT).in('id', compIds)
        │      ← identity join: comp_id IS buyer_comp_raw_v2.id
        │
        ├── (3) db.from('buyer_entities_v2')
        │         .select(ENTITY_SELECT).in('normalized_buyer_name', names)
        │      ← OPTIONAL: an error here is swallowed, enrichment skipped
        │
        └── (4) normalizeCandidate(candidate, rawRow, entity)   compIdentityEnrichment.js
                  → asset lane, buyer identity, transaction channel,
                    v3_pricing_eligible
                        ↓
              qualifyComps()                       transactionQualification.js
                  ├── buildTransactions()          transactionClustering.js
                  ├── clusterTransactions()        → package / duplicate detection
                  ├── qualifyTransaction()         → ACCEPT/REVIEW/QUARANTINE/EXCLUDE
                  └── effectiveSampleSize()        → correlation-aware depth
                        ↓
              buildV3Decision()                    v3DecisionPipeline.js
                        ↓
              applyOfferrSafetyGates()             offerr-safety-gates.js
```

**Exactly three queries. No N+1. No write of any kind anywhere on this path.**

`comp_id` is a `uuid`, and it is `buyer_comp_raw_v2.id` — the view passes `id`
straight through. That is *why* the loader's `.in('id', compIds)` identity join
is correct, and it is the single fact that the previous behavioural stand-in got
most wrong.

### Eligibility window (`compCandidateLoader.eligibilityWindow`)

| asset family | radius (mi) | months back |
|---|---|---|
| land | 20 | 48 |
| commercial | 15 | 48 |
| multifamily | 7 | 36 |
| *(default / residential)* | 4 | 30 |

The Offerr caller always passes these explicitly, so production's own defaults
(`1.0 mi`, `6 months`, `25 rows`) never apply on this path.

---

## 3. Where each guarantee actually lives

This matters: several protections people assume are in the RPC are **not**.
They are real, but they live one layer down. Verified against the recovered SQL.

| Guarantee | Enforced by | Layer |
|---|---|---|
| Subject excluded from its own candidates | `c.property_id IS DISTINCT FROM s.property_id` | RPC |
| Radius filter | `WHERE distance_miles <= p_radius_miles` | RPC |
| Recency window | `sale_date >= current_date - make_interval(months => p_months_back)` | RPC |
| Row cap | `LIMIT least(greatest(p_limit,1),100)` | RPC (hard cap 100) |
| Rejected imports excluded | `import_status IS DISTINCT FROM 'rejected'` | view |
| NULL sale price excluded | `is_usable_comp` requires `COALESCE(sale_price, saleprice, mls_sold_price) IS NOT NULL` | view |
| NULL sale date / lat / lon / address / zip excluded | `is_usable_comp` | view |
| **Zero or negative sale price** | ❌ **not filtered by RPC or view** — quarantined downstream as `nominal_consideration` (`NOMINAL_PRICE_MAX_USD`) | qualification |
| **Future sale date** | ❌ **not filtered by RPC or view** — only a lower bound is applied | *(unguarded, see §6)* |
| Extreme / contaminated price | `price_exceeds_lane_ceiling`, `implausible_ppsf_high`, `price_vs_anchor_high` | qualification |
| Package / portfolio broadcast | `clusterTransactions` → `is_package` → `package_consideration_unresolved` | clustering |
| Duplicate parcel rows | `clusterTransactions` → `is_duplicate` → `duplicate_parcel_row` | clustering |
| Identity-unresolved demotion | `normalizeCandidate` → `v3_pricing_eligible=false` | enrichment |

The comp RPC is **not** a safety boundary. It is a retrieval primitive. Treating
it as if it filtered bad prices would be a material misreading, which is why
this table is here rather than in a commit message.

---

## 4. Licensing and data-rights boundary (Phase 4)

Reviewed before committing anything.

**Committed:** SQL structure — column names, types, nullability, defaults,
constraints, index definitions, the view projection, and the RPC body
(distance/similarity arithmetic and filter predicates).

**Not committed, and never to be:** any production row, any comp record, any
owner/seller identity, any credential, any provider API key or endpoint.

Findings from the review:

1. **No embedded credentials.** No DDL recovered contains a secret, connection
   string, endpoint, or key.
2. **No provider name appears anywhere** in any recovered object, column, or
   function body. There is no vendor-identifying string to redact.
3. **Provider-shaped ingest columns exist** on `buyer_comp_raw_v2`
   (`raw_payload jsonb`, `batch_id`, `source_record_id`, `source_deal_id`,
   `source_row_number`, `import_status`, `row_hash`). These are *ingest
   plumbing*, not licensed content, and are preserved because the view's
   `import_status` filter is load-bearing.
4. **PII-bearing columns exist** on `buyer_comp_raw_v2` (`owner_name`,
   `owner_1_name`, `owner_address_full`, `contactability_*`,
   `phone_numbers_count`). The Offerr path reads owner name and mailing address
   **only** to resolve buyer identity, and `offerr-seller-projection.js` strips
   all of it before anything reaches a seller. The E2E harness asserts this on
   every case.
5. **The similarity formula is internal business logic**, not a licensed
   provider formula — it is arithmetic over columns this system already stores.
6. **`streetview_image` / `satellite_image` / `map_image`** hold third-party
   imagery URLs. They are part of the recovered contract (the RPC returns
   `streetview_image`) but the Offerr path never reads or forwards them.

**Conclusion: no adapter indirection is required.** There is no provider-specific
implementation to isolate, so the "sanitized interface + provider adapter"
fallback in the mission brief is not needed. The exact production SQL is
committed as-is. No unresolved licensing decision blocks this work.

---

## 5. Production posture findings (observed read-only, NOT changed)

Recorded because they were observed while recovering the contract. **Nothing was
altered in production.** These are pre-existing and outside this task's scope.

1. **`get_comp_candidates_for_subject` is `GRANT EXECUTE ... TO PUBLIC`** — and
   therefore executable by `anon` and `authenticated`.
2. **`properties`, `buyer_comp_raw_v2`, `buyer_entities_v2` and
   `v_recent_sold_comps` grant full `SELECT, INSERT, UPDATE, DELETE, TRUNCATE`
   to `anon` and `authenticated`.** Row-level security is enabled on the three
   tables and only `SELECT` policies exist, so RLS is currently the *only* thing
   preventing anonymous writes to the comp corpus. `v_recent_sold_comps` is a
   view and has `relrowsecurity = false`; it inherits the base table's RLS.
3. **The RPC has no `SET search_path`.** It is `SECURITY INVOKER`, which
   substantially limits the risk, but a pinned `search_path` would be stronger.

These are reported for the owner to triage separately. The canonical files
reproduce production's grants for parity, not as an endorsement.

---

## 6. Open production-parity risks

1. **The canonical `ORDER BY` has no unique tiebreaker.**
   `ORDER BY similarity_score DESC NULLS LAST, sale_date DESC NULLS LAST,
   distance_miles ASC` — two candidates equal on all three keys have an
   implementation-defined relative order. With `p_limit` truncating the set,
   *which* comps survive can differ between runs on identical data. This is
   reproduced faithfully rather than silently patched; a contract test
   (`offerr-comp-rpc-contract`) pins the deterministic case and documents the
   tie case. **Recommended production follow-up:** append `, comp_id ASC`.
2. **Future-dated sales are not excluded.** Only a lower bound is applied.
   A mis-keyed future `sale_date` would pass the RPC and the view. Downstream
   qualification does not reject it on recency either.
3. **Zero and negative sale prices reach the loader.** `is_usable_comp` only
   checks for `NOT NULL`. They are quarantined at qualification as
   `nominal_consideration`, so they cannot price a seller-facing range — but
   they *do* consume rows against the 100-row cap.
4. **`properties` in staging is a 117-of-343 column subset.** It covers the
   entire Offerr read surface, but a future engine change that reads a 344th
   column would pass staging and fail production. The drift checker exists to
   catch exactly this.
5. **Production row-count reality is unverified.** All verification here uses
   synthetic fixtures. Comp density, duplicate rates and package frequency in the
   real corpus are not characterised by this work.

---

## 7. How to apply

The staging bootstrap is the only entry point; it `\ir`-includes every file in
`canonical/`, so there is exactly one copy of each definition.

```sh
psql "$OFFERR_STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f apps/api/scripts/offerr/offerr-supabase-prereqs.sql
psql "$OFFERR_STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f apps/api/scripts/offerr/offerr-staging-bootstrap.sql
```

Then verify before trusting anything:

```sh
node apps/api/scripts/offerr/offerr-schema-drift-check.mjs   # read-only
```

**These files are deliberately NOT in `supabase/migrations/`.** Every object here
already exists in production. Putting them in the migration chain would risk
`CREATE OR REPLACE`-ing live production objects from a stale copy. They are
applied only to a disposable or staging database, never to
`lcppdrmrdfblstpcbgpf`.

---

## 8. Provenance of every definition

| Object | Source | Classification |
|---|---|---|
| `get_comp_candidates_for_subject` | `pg_get_functiondef(880417)` | Exact production definition |
| `v_recent_sold_comps` | `pg_get_viewdef(oid, true)` | Exact production definition |
| `buyer_comp_raw_v2` | `information_schema.columns` + `pg_constraint` + `pg_indexes` | Exact column contract; batch FK omitted |
| `buyer_entities_v2` | `information_schema.columns` + `pg_constraint` + `pg_indexes` | Exact column contract |
| `properties` | `information_schema.columns` ∩ (`SUBJECT_SELECT` ∪ `PROPERTY_RESOLUTION_SELECT`) | Compatible reconstruction, enumerated subset |
| grants / RLS policies | `information_schema.role_table_grants`, `pg_policies` | Observed, reproduced for parity |

Nothing in this directory was reconstructed from guesswork, and nothing remains
unavailable. No definition required for the Offerr comp path is missing.
