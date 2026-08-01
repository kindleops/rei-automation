# Offerr Evaluation Spine — Staging Verification Report

**Date:** 2026-07-30 (pass 1) · 2026-07-30 (pass 2 — see §11) · 2026-07-30 (pass 3 — see §12)
· 2026-07-31 (pass 4 — see §13) · 2026-07-31 (production landing — see §14)
· **2026-07-31 (activation-safety hardening — see §15)**
**Branch:** `feat/offerr-ai-evaluation-spine`
**PR:** [#57](https://github.com/kindleops/rei-automation/pull/57) — **MERGED**
2026-07-31T22:48:39Z, merge commit `6a0fd934`

> ### Activation-safety headline (current state — read this first)
>
> All **eleven** documented activation blockers are now closed or conclusively
> disproven (§15). The highest-severity one — the resolver's unordered,
> truncated candidate query, which could return `RESOLVED` for the **wrong
> subject property** — is eliminated: candidate queries are deterministically
> ordered with a unique tie-breaker, exactly counted, explicitly bounded, and
> fail closed to `AMBIGUOUS` whenever completeness cannot be proven.
>
> **This does not activate Offerr.** `offerr_evaluation_enabled` is still
> `false`, the production Offerr tables are still empty, no production data or
> schema was touched, and the public UI is still not connected. The launch
> prerequisites in §14.8 all remain open.

> ### Production-landing headline (§14 — still accurate)
>
> The Offerr schema is **installed in production** (`lcppdrmrdfblstpcbgpf`) and
> the merged API is **deployed**, with the feature **OFF**.
>
> 1. **Schema applied additively** in a single transaction: 3 tables, 1 trigger
>    function, 3 RLS policies, grants/revokes, and
>    `system_control['offerr_evaluation_enabled'] = 'false'`. Nothing else.
> 2. **Zero rows exist** in any Offerr table, and every execution table
>    (properties, comps, scores, campaigns, messages, LeadCommand) is
>    byte-for-byte unchanged against a pre-migration snapshot.
> 3. **Access is denied by construction**: `anon` and `authenticated` hold zero
>    privileges on all three tables (proven by catalog inspection, not
>    `information_schema`), evaluations/events are append-only for
>    `service_role`, and `offerr_touch_updated_at()` is owner-only.
> 4. **The production route fails closed**: 401 without auth, canonical 423
>    `system_control_disabled` with auth.
>
> **Production installation is not launch.** Offerr remains unavailable to
> sellers. See §14.5 for the activation prerequisites that remain.

> ### Pass-3 headline (historical — superseded by §14)
>
> The last remaining local fidelity gap is **closed**.
>
> 1. **The canonical comp-retrieval contract was recovered** read-only from
>    production `lcppdrmrdfblstpcbgpf` (write probe refused, SQLSTATE 25006) and
>    is now source-controlled. The comp RPC and `v_recent_sold_comps` are
>    **exact production definitions**, verified **byte-identical** on catalog
>    round-trip. The Pass-2 behavioural stand-in is deleted.
> 2. **The E2E harness no longer injects comps.** `loadV3CompCandidates`,
>    `loadComparableProperties`, `loadBuyerPurchases` and `loadSubjectProperty`
>    injections are gone; the real RPC → identity join → buy-box join →
>    qualification → clustering path executes against real PostgreSQL.
>    **291/291 assertions pass.**
> 3. **A newly created project can now be bootstrapped from repository files
>    alone** — demonstrated by dropping and rebuilding the verification database
>    from source control with no manual DDL. This was the Pass-2 blocker.
>
> Still blocked on the operator: `real-estate-automation-staging` does not
> exist, so nothing is *hosted*-staging-verified. Full detail in §12.

> ### Pass-2 headline (historical — superseded by §12)
>
> The hosted rollout was attempted again and is **still blocked**, now by *two*
> independent gaps rather than one:
>
> 1. **`real-estate-automation-staging` still does not exist.** Re-audited via
>    `supabase projects list` / `orgs list`; the same three projects are
>    returned. No substitute was used.
> 2. **NEW — the repository cannot rebuild a representative base schema.**
>    `properties`, `buyer_comp_raw_v2`, `buyer_entities_v2`, and the
>    `get_comp_candidates_for_subject` RPC have **no DDL anywhere in the repo**.
>    Creating the staging project alone would therefore *not* have unblocked
>    hosted verification. See §11.2.
>
> Pass 2 delivered the fix for (2) — a validated deterministic bootstrap — plus
> guard hardening and 16 new regression tests. Full detail in §11.
**Scope:** staging infrastructure + integration verification. No UI wiring, no
LeadCommand lifecycle, no messaging, contracts, title, e-signature, marketplace
publication, paid providers, contact enrichment, or seller auth.

> **Production safety result:** no hosted Supabase project was written to, no
> migration was applied to any hosted project, no production schema or data was
> read into or copied out of anywhere, and no production feature flag was
> changed. The only hosted-Supabase calls made were the read-only
> `supabase projects list` and `supabase orgs list`.

No secrets, tokens, connection strings, service-role keys, or seller PII appear
in this report. All addresses, property ids, and prices below are synthetic.

---

## 1. Environment identity proof

### 1.1 Repository and PR state

```
repo root : /Users/ryankindle/rei-automation
remote    : https://github.com/kindleops/rei-automation.git
branch    : feat/offerr-ai-evaluation-spine
HEAD      : bdae4326cb8b5760137692b6601f59df003776e6   (matches expected)
```

Working tree carried only the two pre-existing unrelated tooling modifications,
which were preserved and never committed:

```
 M .claude/scheduled_tasks.lock
 M supabase/.temp/cli-latest
```

Branch scope vs `main` — 15 files, +4517, all Offerr:

```
apps/api/src/app/api/internal/offerr/evaluations/route.js
apps/api/src/lib/domain/offerr/offerr-address-normalization.js
apps/api/src/lib/domain/offerr/offerr-contracts.js
apps/api/src/lib/domain/offerr/offerr-evaluation-service.js
apps/api/src/lib/domain/offerr/offerr-evaluation-store.js
apps/api/src/lib/domain/offerr/offerr-property-resolution.js
apps/api/src/lib/domain/offerr/offerr-safety-gates.js
apps/api/src/lib/domain/offerr/offerr-seller-projection.js
apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql
apps/api/tests/critical/offerr-evaluation-spine.test.mjs
apps/api/tests/critical/offerr-evaluations-route.test.mjs
apps/api/tests/critical/offerr-property-resolution.test.mjs
apps/api/tests/critical/offerr-seller-projection.test.mjs
apps/api/tests/critical/offerr-side-effect-proof.test.mjs
docs/offerr/offerr-evaluation-spine.md
```

PR #57: `OPEN`, `isDraft: true`, base `main`, head `bdae4326`.
`reviewDecision` empty, `reviews: []`. The only two comments are bots — the
Vercel deployment status comment and CodeRabbit reporting *"Review skipped —
Draft detected."* **There were no human review comments and no unresolved
review threads, so no PR feedback needed addressing.**

### 1.2 Supabase environment audit

`supabase projects list` (read-only) returned exactly three projects:

| Linked | Ref | Name | Org | Region | Created | Classification |
|---|---|---|---|---|---|---|
| ● | `lcppdrmrdfblstpcbgpf` | real-estate-automation | REI Automation (`gosflvntwnxegkrulmoz`) | West US (Oregon) | 2026-04-18 | **PRODUCTION** |
| | `wwqqwllstapdolkndzzx` | ReivestiExchange | Luxer International (`ssxbuobppduwwahkxila`) | East US (Ohio) | 2025-09-16 | Other product |
| | `lvocccmhnyfoyqnbmmci` | SignPro | Luxer International (`ssxbuobppduwwahkxila`) | East US (Ohio) | 2025-05-16 | Other product |

`supabase orgs list`: `ssxbuobppduwwahkxila` = Luxer International,
`gosflvntwnxegkrulmoz` = REI Automation.

**Production identity independently corroborated** from repository sources, not
assumed:

- `supabase/.temp/linked-project.json` → `{"ref":"lcppdrmrdfblstpcbgpf","name":"real-estate-automation","organization_id":"gosflvntwnxegkrulmoz"}`
- `docs/backend/acquisition_engine_v3_audit.md` — "**DB:** Supabase project `lcppdrmrdfblstpcbgpf` (`real-estate-automation`), Postgres 17"
- `apps/dashboard/PRODUCTION_SMS_LAUNCH_CHECKLIST.md` — "**Project:** real-estate-automation / lcppdrmrdfblstpcbgpf"
- `apps/dashboard/.env.example`, `docs/deployment-dashboard.md` → `VITE_SUPABASE_URL=https://lcppdrmrdfblstpcbgpf.supabase.co`

**Conclusion: no rei-automation staging project exists.** Neither
ReivestiExchange nor SignPro is a valid Offerr staging target — a different
product's project is not staging for this one.

### 1.3 Staging project was NOT created — operator decision required

Creating `real-estate-automation-staging` would add a project to the REI
Automation organization. That is a billing and ownership decision, and the
organization's plan and project entitlement could not be established from the
CLI (there is no `supabase orgs billing` command, and no access token is
present on disk at `~/.supabase/access-token` — the CLI credential lives in the
macOS keychain). Per the safety rules, **no project was created, and production
was not substituted.** The exact required action is in §9.

### 1.4 What was verified against instead

A **disposable local PostgreSQL 17.10 container** — chosen because production
runs PostgreSQL 17:

```
PostgreSQL 17.10 (Debian 17.10-1.pgdg13+1) on x86_64-pc-linux-gnu
container : offerr-verify-pg   (docker, 127.0.0.1:55432, destroyed after the run)
database  : offerr_verify
```

The guard classified this target as `local_container`. Identity block emitted
before any write:

```
── Offerr staging target identity ──────────────────────────────
  classification    : local_container
  project ref       : (not a Supabase project)
  target host       : postgresql://127.0.0.1:55432
  is production     : NO (guard refuses production refs)
  opt-in env        : ALLOW_OFFERR_STAGING_FIXTURES=true
  purpose           : Offerr E2E verification
────────────────────────────────────────────────────────────────
```

To make the migration's grant and RLS statements meaningful, a hosted Supabase
project's privilege environment was reproduced first
(`apps/api/scripts/offerr/offerr-supabase-prereqs.sql`): roles `anon`,
`authenticated`, `service_role` (BYPASSRLS), `authenticator`; Supabase's
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
authenticated, service_role`; and the prerequisite `public.system_control`
table. **Reproducing the default ACL is what exposed the grant defect in §3.2.**

**Fidelity limits.** This proves DDL, constraints, indexes, RLS, grants,
triggers, rollback, and real-database idempotency/concurrency. It does **not**
prove PostgREST behaviour, Supabase Auth, API-gateway-served grants, or a
deployed preview URL. Those remain unverified and are listed in §9.

---

## 2. Commands run

Read-only environment audit:

```bash
git rev-parse --show-toplevel && git remote -v && git branch --show-current && git rev-parse HEAD
git status --porcelain
git diff --stat main...HEAD
gh pr view 57 --json number,state,isDraft,mergeable,reviewDecision,comments,reviews
supabase projects list
supabase orgs list
vercel projects ls
```

Baseline test run (before any change):

```bash
cd apps/api
NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test PODIO_USERNAME=test \
PODIO_PASSWORD=test INTERNAL_API_SECRET=test BUYER_WEBHOOK_SECRET=test \
OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
node --import ./tests/register-aliases.mjs --test --test-concurrency=1 \
  tests/critical/offerr-*.test.mjs
```

Verification database, migration, schema checks, and E2E: see
`docs/offerr/offerr-evaluation-spine.md` § Commands. Teardown:
`docker rm -f offerr-verify-pg`.

---

## 3. Migration validation and schema verification

### 3.1 Application results

| Check | Result |
|---|---|
| SQL applies cleanly on PostgreSQL 17 | **PASS** |
| Applies a **second** time with no error (additive / re-runnable) | **PASS** — only `IF NOT EXISTS` notices |
| Creates exactly 3 tables, 1 function, 0 views, 0 sequences | **PASS** |
| Documented rollback restores prior state | **PASS** — 0 tables, 0 functions, 0 flag rows remaining |
| `offerr_evaluation_enabled = 'false'` immediately after apply | **PASS** |
| Modifies no pre-existing object | **PASS** |
| `PROPOSED_` prefix retained on the branch | **PASS** |

`apps/api/scripts/offerr/offerr-schema-verify.sql` — **47 checks, 47 PASS, 0 FAIL, 0 unexpected errors.**

Persisted column contract (37 columns across 3 tables) matches the documented
grain: one request row per intake, one immutable versioned snapshot per
evaluation, append-only event ledger. All 15 timestamp columns are
`timestamptz`; all three primary keys default to `gen_random_uuid()`.

Constraints verified behaviourally, not just structurally:

| Probe | Result |
|---|---|
| `resolution_status` CHECK rejects an out-of-vocabulary value | **PASS** |
| CHECK accepts all 5 of RESOLVED / AMBIGUOUS / NOT_FOUND / INVALID_INPUT / UNSUPPORTED | **PASS** |
| `UNIQUE(idempotency_key)` rejects a duplicate | **PASS** |
| `UNIQUE(request_id, evaluation_version)` rejects a duplicate version | **PASS** |
| `version+1` re-evaluation snapshot **is** accepted | **PASS** |
| `outcome` CHECK rejects an unknown outcome | **PASS** |
| Parent request delete **REFUSED** while snapshots reference it | **PASS** |
| Event `dedupe_key` unique rejects a duplicate | **PASS** |
| Multiple NULL `dedupe_key`s allowed (partial index scope correct) | **PASS** |
| `updated_at` trigger advances `updated_at` on UPDATE | **PASS** |
| Probe cleanup left zero probe rows | **PASS** |

All 7 documented indexes present, including the partial unique
`uq_offerr_eval_events_dedupe_key ... WHERE (dedupe_key IS NOT NULL)`.

Security: RLS enabled on all three tables; every policy scoped to
`service_role` only; `anon`, `authenticated`, and `PUBLIC` hold **zero**
privileges; no public function exposes Offerr internals to `anon`/`authenticated`.

### 3.2 Defect found and fixed — append-only was not DB-enforced

Supabase seeds
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres,
anon, authenticated, service_role`, so a newly created public table arrives with
`service_role` already holding `arwd`. The migration's narrower
`GRANT SELECT, INSERT` on `offerr_evaluations` and `offerr_evaluation_events`
is **additive and does not remove that surplus**.

Observed before the fix:

```
service_role | offerr_evaluation_events   | DELETE, INSERT, SELECT, UPDATE
service_role | offerr_evaluation_requests | DELETE, INSERT, SELECT, UPDATE
service_role | offerr_evaluations         | DELETE, INSERT, SELECT, UPDATE
```

Impact: the "immutable snapshot" and "append-only ledger" guarantees were
convention-only. The Offerr API connects with the service-role key, so a bug or
a future code path could have UPDATEd or DELETEd a persisted evaluation, and the
database would have permitted it. `anon`/`authenticated` were correctly locked
out — this was specifically a `service_role` over-grant.

Fix (minimal, in the migration): REVOKE before granting, and drop PUBLIC's
implicit EXECUTE on the trigger function. Verified after re-applying from
scratch:

```
service_role | offerr_evaluation_requests | DELETE, INSERT, SELECT, UPDATE
service_role | offerr_evaluations         | INSERT, SELECT
service_role | offerr_evaluation_events   | INSERT, SELECT
```

The compensating-delete path in `offerr-evaluation-store.js` deletes only from
`offerr_evaluation_requests`, which retains DELETE — so the revoke does not
break it, as the green E2E run confirms.

---

## 4. Synthetic fixtures

`apps/api/scripts/offerr/offerr-staging-fixtures.mjs` — 15 synthetic canonical
`properties` rows driving 12 evaluation cases. Deterministic (no randomness, no
`Date.now()`), rerunnable (seeding deletes fixture rows first), and removable
(`cleanupFixtures`). Every id is prefixed `OFFERR-STAGING-TEST-` and every
address uses the reserved synthetic street token `Sandbox`.

**No production seller, owner, phone, email, campaign, or conversation record
was copied.** Every value is invented.

### Guard — `offerr-staging-guard.mjs`

Refuses to run unless **all** hold:

1. `ALLOW_OFFERR_STAGING_FIXTURES=true` is explicitly set.
2. The target is not production ref `lcppdrmrdfblstpcbgpf` — checked both as a
   parsed project ref **and** as a raw substring anywhere in the target string,
   so an embedded pooler host cannot slip through.
3. The target is not `wwqqwllstapdolkndzzx` (ReivestiExchange) or
   `lvocccmhnyfoyqnbmmci` (SignPro).
4. The target is positively identified as either a local container or a Supabase
   project ref that **matches `OFFERR_STAGING_PROJECT_REF`**. An unrecognised
   Supabase project is refused — unknown is never treated as safe.

Safety does not rest on naming conventions; refs are matched explicitly and the
guard throws `OfferrStagingGuardError` rather than degrading.

---

## 5. End-to-end verification

`apps/api/scripts/offerr/offerr-e2e-verify.mjs` drives the **real** route
handler `handleOfferrEvaluationsRequest` and the **real**
`createSupabaseOfferrEvaluationStore` against the real database (via a
PostgREST-shaped adapter over `pg`, so the store's actual `23505` conflict
branch executes). The **real** address resolver and its **real** candidate
loader query the real `properties` table.

**Result: 207 assertions, 207 passed, 0 failed. Exit code 0.**

### 5.1 Feature-flag gating

| Assertion | Result |
|---|---|
| Flag false → HTTP **423** | **PASS** |
| `error: "system_control_disabled"` | **PASS** |
| Correct `flag_key: offerr_evaluation_enabled` echoed | **PASS** |
| **No** request row created | **PASS** |
| **No** evaluation row created | **PASS** |
| **No** event row created | **PASS** |
| Bad internal secret → 401 before any evaluation work | **PASS** |

### 5.2 Acquisition V3 disabled → fail closed

With `offerr_evaluation_enabled = true` and V3 **disabled**:

| Assertion | Result |
|---|---|
| Request accepted (200) | **PASS** |
| **No preliminary range** | **PASS** (`preliminary_range: null`) |
| Outcome `REVIEW_REQUIRED`, never `INSTANT_RANGE_ELIGIBLE` | **PASS** |
| `binding: false`, `preliminary: true` | **PASS** |

Reason code recorded: `engine_v3_disabled_or_unavailable`. V3 was then enabled
**in the verification database only** for the matrix below. No autonomous
acquisition, campaign, messaging, contract, or LeadCommand flag was enabled at
any point.

### 5.3 The 12-case matrix (V3 enabled)

| Case | HTTP | Resolution | Outcome | Range | ms |
|---|---|---|---|---|---|
| C01 Clean SFR, sufficient qualified comps | 200 | RESOLVED | INSTANT_RANGE_ELIGIBLE | YES | 279 |
| C02 Conditionally eligible SFR (thin comps) | 200 | RESOLVED | REVIEW_REQUIRED | null | 94 |
| C03 Small multifamily | 200 | RESOLVED | INSTANT_RANGE_ELIGIBLE | YES | 146 |
| C04 Unsupported asset class (commercial retail) | 200 | RESOLVED | **UNSUPPORTED** | null | 75 |
| C05 Ambiguous duplicate address | 200 | AMBIGUOUS | REVIEW_REQUIRED | null | 39 |
| C06 Multi-unit address, unit omitted | 200 | AMBIGUOUS | REVIEW_REQUIRED | null | 38 |
| C07 Conflicting ZIP | 200 | NOT_FOUND | REVIEW_REQUIRED | null | 34 |
| C08 No property match | 200 | NOT_FOUND | REVIEW_REQUIRED | null | 32 |
| C09 Extreme contaminated comp | 200 | RESOLVED | REVIEW_REQUIRED | null | 125 |
| C10 Package/broadcast comp cluster | 200 | RESOLVED | REVIEW_REQUIRED | null | 63 |
| C11 Seller condition claim conflict | 200 | RESOLVED | CONDITIONAL_RANGE | YES | 123 |
| C12 Asking price far above value | 200 | RESOLVED | CONDITIONAL_RANGE | YES | 98 |

Per-case assertions (all PASS): exactly one persisted request row, exactly one
immutable snapshot, at least one lifecycle event, outcome within the documented
vocabulary, `binding: false`, `preliminary: true`, disclaimer present, no
internal key leakage, no private property id in the seller payload, stored
`seller_projection` structurally identical to the HTTP response, and
`internal_result` present server-side but absent from the response.

Mapping to the required assertions:

1. Clean eligible property produced a range only with all gates passing — C01. ✅
2. V3-disabled produced review, never a range — §5.2. ✅
3. Unsupported asset returned UNSUPPORTED with no range — C04. ✅ *(only after the fix in §5.4)*
4. Ambiguous identity → confirmation required (`confirm_property_identity`) — C05. ✅
5. Missing unit never auto-resolved with multiple units present — C06. ✅
6. Conflicting ZIP never resolved — C07. ✅
7. No match returned confirmation/unavailable, not seller rejection — C08. ✅
8. Contaminated extreme comp produced no range — C09 (`ANOMALY_QUARANTINE`). ✅
9. Package comps collapsed to one economic transaction — C10 (effective sample size). ✅
10. Material seller-fact conflicts downgraded eligibility — C11, C12. ✅
11. Seller-safe response exposed none of the forbidden fields — all cases. ✅
12. Every result `binding: false`, `preliminary: true`, with the disclaimer. ✅
13. Persistence failure never returned success — covered by suite + §5.5. ✅
14. Idempotent replay created no second snapshot — §5.5. ✅
15. Same key, different address → 409 — §5.5. ✅
16. Concurrent same-key requests → exactly one completed evaluation — §5.6. ✅
17. Logs carried correlation ids; addresses appear only as a 12-char SHA-256 prefix plus ZIP. ✅
18. No network provider request occurred (`_operations` recorded DB calls only). ✅
19. No message, campaign, offer, contract, title, marketplace, or LeadCommand row created — §5.7. ✅
20. No `property_acquisition_scores` row written — §5.7. ✅

### 5.4 Second defect found and fixed — commercial property misclassified as SFR

C04 initially returned `REVIEW_REQUIRED` (reason
`execution_state_not_range_eligible:DATA_REQUIRED`) instead of `UNSUPPORTED`,
violating required assertion 3. Root cause, confirmed by probing the real
classifier directly:

```
Commercial Retail / class Commercial / 12000 sqft / 0 units  ->  SFR  conf=55  ["inferred_from_unit_count(0)"]
Retail (bare)                                               ->  UNKNOWN conf=25
Retail Strip Center                                         ->  RETAIL_STRIP_CENTER conf=75
```

`classifyAssetLane` falls back to `inferred_from_unit_count(n)` at confidence 55
and returns **SFR** for a unit count of 0 or 1 whenever it matches no type
keyword. So a commercial record whose `property_type` string it does not
recognise arrives as `lane=SFR` / `family=RESIDENTIAL_SINGLE` and **passes
Offerr's supported-family gate**. C04 only avoided emitting a range because it
happened to have no comps; with comps it would have produced a seller-facing
preliminary range for a 12,000 sqft retail building.

Genuine residential rows classify at 78–82 from a keyword or an explicit unit
count, so the weak fallback is cleanly separable.

Fix, contained to Offerr rather than the shared classifier the wider acquisition
engine depends on:

- `detectNonResidentialSignal(row)` reads the canonical use columns
  (`property_type`, `property_class`, `land_use`, `zoning`, …) directly, so a
  misfiring classifier cannot mask a commercial/land record.
- `OFFERR_MIN_ASSET_CONFIDENCE = 70` — a supported family resting only on a
  sub-floor guess is refused.
- The floor applies **only when a confidence value is supplied**, so callers
  that assert an asset family directly are unaffected.
- New `asset_classification_trusted` gate check, and
  `asset_lane` / `asset_family` / `asset_confidence` /
  `non_residential_signal` added to persisted provenance.

C04 now returns `UNSUPPORTED` with reason
`non_residential_signal_on_canonical_record` and `next_step:
not_serviceable_manual_follow_up`. Three regression tests were added.

### 5.5 Idempotency

| Assertion | Result |
|---|---|
| Replay returns 200 | **PASS** |
| Replay flagged `idempotent_replay: true` | **PASS** |
| Replay created **no** second snapshot (still exactly 1) | **PASS** |
| Replay returned the **same** `evaluation_id` | **PASS** |
| Same key + different address → **HTTP 409** | **PASS** |
| 409 `failure_code: idempotency_key_reused_with_different_payload` | **PASS** |

### 5.6 Concurrency — proven against real database constraints

Six simultaneous requests with one shared idempotency key:

```
statuses: 200, 503, 503, 503, 503, 503
```

| Assertion | Result |
|---|---|
| Exactly **one** request row | **PASS** |
| Exactly **one** completed evaluation snapshot | **PASS** |
| Every response was 200 or a retryable 503 | **PASS** |
| All successful responses agreed on one `evaluation_id` | **PASS** |

**Third defect found and fixed.** The losers initially returned **HTTP 500**
(`offerr_incomplete_snapshot`), because the pre-flight replay lookup finds the
winner's request row before its snapshot commits — a routine race. 500 tells
clients not to retry and reads as an unhandled fault in alerting, when retry is
exactly correct. The route now maps `offerr_incomplete_snapshot` to **503**,
consistent with the store's own `offerr_idempotency_conflict_retry`. The
`failure_code` is unchanged, so the existing behavioural test stays green; no
test pinned the 500. This is only observable against a real database — the
in-memory store resolves synchronously and never opens the window.

### 5.7 Side-effect reconciliation — measured, not inferred

18 execution/side-effect tables were created as empty stubs in the verification
database **before** the run, so "zero rows" is a measured fact about a real
table rather than an inference from the absence of a code reference.

```
requests     0 → 14
evaluations  0 → 14
events       0 → 14

resolution status          outcome
  AMBIGUOUS   2              CONDITIONAL_RANGE       2
  NOT_FOUND   2              INSTANT_RANGE_ELIGIBLE  3
  RESOLVED   10              REVIEW_REQUIRED         8
                             UNSUPPORTED             1
```

14 = 12 matrix cases + 1 V3-disabled case + 1 concurrency winner.
Idempotent replays: 1 (created no row). Orphaned/incomplete requests: **0**.
Requests with more than one snapshot: **0**. Failed evaluations: 0.

Before → after, all unchanged at **0 → 0**:

```
property_acquisition_scores      property_cash_offer_snapshots
send_queue                       message_events
email_send_queue                 follow_up_queue
campaigns                        campaign_targets
contracts                        offers
title_orders                     acquisition_opportunities
acquisition_events               deal_thread_state
universal_lead_command_cache     lead_command_state
exchange_listings                exchange_publications
```

Independently, every database operation was recorded at the adapter:

```
tables touched by the spine : offerr_evaluation_events, offerr_evaluation_requests,
                             offerr_evaluations, properties
tables WRITTEN by the spine : offerr_evaluation_events, offerr_evaluation_requests,
                             offerr_evaluations
```

`properties` was read-only (resolution + subject hydration). **No side-effect
table was touched even for a read.** No Reivesti Exchange publication row and no
LeadCommand lifecycle row was created.

### 5.8 Sample seller-safe response (persisted, verbatim)

Read back from `offerr_evaluations.seller_projection` for C01:

```json
{
    "binding": false,
    "outcome": "INSTANT_RANGE_ELIGIBLE",
    "property": {
        "zip": "77035",
        "city": "Houston",
        "state": "TX",
        "address_line": "4100 Sandbox Clean Ln, Houston, TX 77035",
        "property_type": "SFR"
    },
    "next_step": "schedule_walkthrough_verification",
    "disclaimer": "This is a preliminary, non-binding estimate based on public and internal data. It is not an offer to purchase. Any offer requires verification of the property.",
    "expires_at": "2026-08-13T08:31:37.001Z",
    "assumptions": [
        "Preliminary range is subject to an in-person or virtual walkthrough.",
        "Reflects the seller-reported condition, pending verification."
    ],
    "preliminary": true,
    "evaluation_id": "2a2b0a0d-6de3-451b-968f-5cb859f49940",
    "processing_ms": 71,
    "spine_version": "offerr-evaluation-spine-v1",
    "data_conflicts": [],
    "confidence_label": "HIGH",
    "preliminary_range": {
        "low": 89014,
        "high": 98117,
        "currency": "USD"
    }
}
```

No comp rows, buyer identities, MAO formula, assignment-fee target, owner or
contact enrichment, provider payload, candidate rows, private property id,
internal risk rules, ARV, spread, or engine/formula version. The address echoed
is the seller's own submitted address. Checked at every nesting depth against a
40-key deny list, for all 12 cases.

### 5.9 Latency

```
n=12  min=32ms  p50=94ms  p95=279ms  max=279ms   (route budget: 60s)
```

Representative stage breakdown (C01): `validate 5ms, idempotency 4ms,
resolution 4ms, subject 5ms, overlay 3ms, comp_load 0ms, engine 274ms,
gates 1ms, persistence 184ms`. The engine and persistence dominate, as expected.

---

## 6. Test results

| Run | tests | pass | fail | skip |
|---|---|---|---|---|
| Baseline at `bdae4326`, before any change | 59 | **59** | 0 | 0 |
| After the three fixes + 3 new regression tests | 62 | **62** | 0 | 0 |
| E2E staging verification assertions | 207 | **207** | 0 | 0 |
| Schema verification checks | 47 | **47** | 0 | 0 |

The wider critical suite has a known chronic baseline failure cluster on `main`
unrelated to Offerr; per the task scope those were not addressed and no Offerr
change touches them. All three code changes are confined to Offerr modules plus
the Offerr migration.

---

## 7. Feature-flag states

| Flag | Before | During verification | After |
|---|---|---|---|
| `offerr_evaluation_enabled` (verification DB) | `false` (seeded by migration) | `true` for §5.2–5.6 | **`false`** |
| `ACQUISITION_ENGINE_V3_ENABLED` | `false` (repo default) | injected `true` for §5.3 only, in-process | `false` (repo default unchanged) |
| Any autonomous acquisition / campaign / messaging / contract / LeadCommand flag | disabled | **never enabled** | disabled |

**No production flag was read or changed.** V3 was supplied as an in-process
dependency (`deps.v3Enabled`), never persisted anywhere.

---

## 8. Final state

- Verification container destroyed; nothing persists from the run.
- Synthetic fixtures removed: `{events: 14, evaluations: 14, requests: 14, properties: 15}`.
  `OFFERR_KEEP_FIXTURES=true` retains them when repeat QA is wanted.
- Zero incomplete request rows.
- `offerr_evaluation_enabled = false`.
- Migration remains `PROPOSED_`-prefixed and **applied to no hosted project**.
- PR #57 remains **draft and unmerged**.

---

## 9. Remaining blockers and launch prerequisites

### Operator action required (blocking)

**Create a staging Supabase project.** Everything else below depends on it.

- Name `real-estate-automation-staging`, org `REI Automation`
  (`gosflvntwnxegkrulmoz`), region West US (Oregon) to match production,
  smallest sufficient instance size, freshly generated password (never committed).
- Confirm the billing impact of an additional project in that organization
  first — this was the reason the project was not created here.
- Then follow `offerr-evaluation-spine.md` §10.4.

### Blocked on the above

1. Applying the migration to a hosted Supabase project.
2. Verifying grants/RLS **as PostgREST actually serves them** — the local run
   proves the SQL privilege state, not the API gateway's enforcement.
3. Deploying `apps/api` to a non-production preview with staging Supabase URL,
   staging service-role key, and a staging internal secret. The canonical Vercel
   project is `api` under team `real-estate-automation`; a preview deployment
   should reuse it, not create a duplicate project. No deployment was made
   because there is no staging database to point it at, and pointing a preview
   at production would violate the safety rules.
4. End-to-end verification over real HTTP against that preview URL. The current
   run invokes the route handler in-process — genuine route logic, auth, flag
   gating, and status codes, but not the network path, edge/runtime config, or
   cold-start behaviour.

### Business / credential decisions

- Billing approval for an additional Supabase project.
- Whether Offerr staging should mirror any production data (recommendation: no —
  synthetic fixtures are sufficient and avoid copying seller records).
- Enabling `ACQUISITION_ENGINE_V3_ENABLED` for Offerr traffic in any real
  environment.

### Known risks

- **The `classifyAssetLane` weakness remains at source.** Offerr now refuses
  misclassified non-residential records, but any other consumer of that
  classifier still receives `SFR` at confidence 55 for an unrecognised
  commercial `property_type`. Worth fixing in
  `apps/api/src/lib/acquisition/assetClassification.js` separately.
- **No canonical condition field.** Overlay-conflict detection cannot compare a
  seller's claimed condition against canonical condition data because the
  `properties` table has no such column; only seller-internal inconsistency and
  asking-price-vs-estimate are detectable.
- The E2E PostgREST adapter is verification tooling implementing only the query
  surface the Offerr store uses; it is not a general Supabase client and must
  not be used in product code.
- `properties` in the verification database is a synthetic 14-column subset. The
  real table is far wider, so comp-loader behaviour against the true schema is
  only covered by the existing suite's fakes, not by this run.

---

## 10. Files added and modified

**Added**

```
apps/api/scripts/offerr/offerr-staging-guard.mjs        production guard (hard refusal)
apps/api/scripts/offerr/offerr-staging-fixtures.mjs     15 properties, 12-case matrix
apps/api/scripts/offerr/offerr-pg-rest-adapter.mjs      PostgREST-shaped adapter over pg
apps/api/scripts/offerr/offerr-e2e-verify.mjs           E2E harness (207 assertions)
apps/api/scripts/offerr/offerr-schema-verify.sql        schema suite (47 checks)
apps/api/scripts/offerr/offerr-supabase-prereqs.sql     Supabase role/ACL environment
docs/offerr/offerr-staging-verification-report.md       this report
```

**Modified**

```
apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql
    REVOKE before GRANT so append-only is DB-enforced; revoke PUBLIC EXECUTE
apps/api/src/lib/domain/offerr/offerr-safety-gates.js
    detectNonResidentialSignal, OFFERR_MIN_ASSET_CONFIDENCE,
    asset_classification_trusted gate
apps/api/src/lib/domain/offerr/offerr-evaluation-service.js
    pass asset confidence + non-residential signal; record both in provenance
apps/api/src/app/api/internal/offerr/evaluations/route.js
    offerr_incomplete_snapshot 500 → 503 (retryable)
apps/api/tests/critical/offerr-evaluation-spine.test.mjs
    3 regression tests for the asset-classification defense
docs/offerr/offerr-evaluation-spine.md
    staging state, migration verification, limitations, commands
```

---

## 11. Pass 2 — hosted rollout re-attempt (2026-07-30)

Starting HEAD `8a6bae4b`, PR #57 `OPEN` / `isDraft: true` / base `main` /
`mergedAt: null` / `MERGEABLE`. Working tree carried only the two expected
unrelated modifications (`.claude/scheduled_tasks.lock`,
`supabase/.temp/cli-latest`). PR checks green (CodeRabbit `SUCCESS`, Vercel
`SUCCESS`); still no human reviews and no unresolved threads.

### 11.1 Staging project — re-audited, still absent

`supabase projects list` and `supabase orgs list` returned exactly the same two
organizations and three projects as pass 1. **No project named
`real-estate-automation-staging` exists.** Per the fail-closed rule, no
substitute was adopted and nothing hosted was written. Phases 4, 6, 8–16 remain
blocked.

### 11.2 NEW BLOCKER — the repo cannot rebuild the base schema

The Offerr runtime touches exactly five database objects. Their provenance was
established by searching every `*.sql` in the repository:

| Object | Used by | Defined in repo? |
|---|---|---|
| `public.system_control` | flag gate (`getSystemFlag`) | **yes** — `20260428_create_system_control.sql` |
| `public.properties` | `offerr-property-resolution.js` | **no** |
| `public.buyer_comp_raw_v2` | `compCandidateLoader.js` identity join | **no** |
| `public.buyer_entities_v2` | `compCandidateLoader.js` buy-box | **no** |
| `get_comp_candidates_for_subject(...)` | `compCandidateLoader.js` RPC | **no** |

Four of five are **production-only objects created out of band**. Replaying the
120-migration tree against an empty project would not create them.

This matters because it invalidates the pass-1 assumption that creating the
Supabase project was the *only* blocker. It was not. Discovering this after
provisioning would have produced a staging project that could not run an
evaluation.

Also confirmed: V3 feature flags are read by `readFeatureFlag` from **env vars**,
not from `system_control`. Phase-12-style enablement is a deployment env change,
not a database flag change.

### 11.3 Deliverable — `offerr-staging-bootstrap.sql`

A deterministic bootstrap for the four missing objects, preferred over cloning
production. Contents: `system_control` (canonical shape, **outbound seed values
inverted to `false`** — the production migration seeds
`outbound_sms_enabled`/`feeder_enabled`/`queue_runner_enabled` to `true`, which
staging must never inherit); `properties`; `buyer_comp_raw_v2`;
`buyer_entities_v2`; and a `get_comp_candidates_for_subject` stand-in.

Safety: section 0 aborts if `public.properties` holds any row not prefixed
`OFFERR-STAGING-TEST-`, so pointing it at a populated database fails before any
DDL runs. Idempotent throughout.

**Validated against disposable PostgreSQL 17.10, not merely authored:**

| Check | Result |
|---|---|
| Bootstrap applies to an empty database | pass |
| Re-run is idempotent | pass (all objects skipped, no error) |
| Aborts on a single non-synthetic `properties` row | pass — refused before DDL |
| Offerr migration applies on top | pass |
| `offerr-schema-verify.sql` | **47/47 PASS, 0 FAIL** |
| Comp RPC honours the radius window | pass — 4.0 mi comp excluded |
| Comp RPC honours the recency window | pass — 1200-day-old comp excluded |
| Comp RPC determinism across repeated calls | pass — byte-identical |
| Full `offerr-e2e-verify.mjs` against the bootstrapped DB | **207/207 pass** |

> **Fidelity limit that must survive into the rollout decision.** The RPC here
> is a *behavioural stand-in*: same signature, same return contract,
> deterministic implementation — **not** production's SQL, which this repository
> does not contain. Hosted staging on this bootstrap proves how *Offerr handles*
> comp data; it does not validate production's comp retrieval. Treat
> production comp-SQL parity as a separate, still-open item.
>
> **⚠️ SUPERSEDED BY PASS 3 (§12).** This limit no longer applies. The exact
> production RPC and view were recovered read-only on 2026-07-30, are now
> source-controlled, and the E2E harness executes them for real with no injected
> comps. Everything in §11 is retained as the historical record of Pass 2, not
> as a description of current state.

### 11.4 Guard hardening — two refusal classes were missing

The Phase-3 requirement lists six refusal conditions. `offerr-staging-guard.mjs`
implemented four. The two gaps are now closed:

- **Production runtime designation.** `NODE_ENV`, `VERCEL_ENV`, `APP_ENV`,
  `APP_ENVIRONMENT`, `ENVIRONMENT`, `DEPLOY_ENV`, `OFFERR_ENVIRONMENT` set to
  `production`/`prod`/`live` now refuse the run **regardless of target**. A
  correct staging ref reached from a production runtime is still a production
  execution.
- **Missing required secrets.** New `requiredSecrets` option; a run with
  partial configuration is refused before it can half-apply anything.
  `offerr-e2e-verify.mjs` now requires `OFFERR_VERIFY_DATABASE_URL` always, plus
  `INTERNAL_API_SECRET` whenever the target is not local.

New `apps/api/tests/critical/offerr-staging-guard.test.mjs` — **16 tests**
covering every refusal branch and both accept paths, including the
credentials-never-logged assertion. Offerr suites: **62 → 78, all passing.**

### 11.5 Known fidelity gap — the E2E harness stubs the comp loader

`offerr-e2e-verify.mjs` injects `loadV3CompCandidates: async () => ({ candidates: c.comps })`.
The 207 assertions therefore exercise the real route, auth, flag gate, resolver,
safety gates, store, and a real PostgreSQL — but **not** the real comp retrieval
path. The bootstrap now makes a real-RPC run possible; rewiring the harness to
seed `buyer_comp_raw_v2` and drop the stub was deliberately not attempted here,
because it is a redesign of a passing 207-assertion suite and belongs with the
hosted run it enables. This is the **top prerequisite** for the next pass.

### 11.6 Vercel — identified, nothing deployed

Team `real-estate-automation`. The canonical project for `apps/api` is **`api`**
(latest production URL `https://api-steel-three-96.vercel.app`). The repo root
`.vercel/project.json` links to `rei-automation-dashboard`, a *different*
project — a preview deploy from the repo root would target the dashboard, not
the API. **No deployment was created**, because a preview must use staging
Supabase env vars and there is no staging database to point at; pointing a
preview at production would violate the safety rules.

Environment variables a staging preview will need (names only, no values):
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_API_SECRET`,
`APP_BASE_URL`, `OFFERR_STAGING_PROJECT_REF`, and — because V3 flags are
env-read — `ACQUISITION_ENGINE_V3_ENABLED` plus the `ACQUISITION_ENGINE_V3_ALLOW_*`
family left at their safe `false` defaults.

### 11.7 Pass-2 state

- Nothing hosted was written, migrated, deployed, flagged, or read beyond the
  read-only `supabase projects list` / `orgs list`.
- Verification container destroyed; no artifacts persist.
- `offerr_evaluation_enabled` remains `false`; migration remains `PROPOSED_`-prefixed
  and applied to no hosted project.
- Offerr tests **78/78**, schema checks **47/47**, E2E **207/207**, lint pass.
- PR #57 remains **draft and unmerged**.

### 11.8 Operator action required (updated, ordered)

1. **Approve billing** for an additional Supabase project in org
   `gosflvntwnxegkrulmoz`.
2. **Create** `real-estate-automation-staging`, West US (Oregon), fresh password
   (never committed).
3. **Bootstrap** it: `offerr-supabase-prereqs.sql` is *not* needed (hosted
   Supabase already has the roles) — run `offerr-staging-bootstrap.sql`, then
   `PROPOSED_20260729120000_offerr_evaluation_spine.sql`, then
   `offerr-schema-verify.sql`.
4. **Rewire** the E2E harness onto the real comp RPC (§11.5) before trusting any
   V3-enabled matrix result.
5. **Deploy** the `api` Vercel project to preview with staging env vars.
6. Only then are Phases 10–16 executable.

---

## 12. Pass 3 — canonical comp contract recovered, real comp path verified (2026-07-30)

Pass 2 closed with one blocker above all others (§11.5): **the E2E harness stubbed
the comp loader**, so 207/207 assertions proved routing, gating, persistence and
projection — but proved nothing about comp retrieval. Pass 3 removes that gap.

### 12.1 Production schema inspection — read-only, verified read-only

Production Supabase project `lcppdrmrdfblstpcbgpf` was inspected **read-only** to
recover the canonical definitions the repository was missing.

The connection was opened with `options='-c default_transaction_read_only=on'`
and every statement ran inside an explicit `BEGIN TRANSACTION READ ONLY`. Before
any inspection query, a deliberate write probe was issued to prove the session
could not write:

```
READONLY PROOF: {"transaction_read_only":{"transaction_read_only":"on"},
                 "write_probe":"write refused: 25006"}
server: PostgreSQL 17.6 on aarch64-unknown-linux-gnu
```

SQLSTATE `25006` is `read_only_sql_transaction`. The script aborts if the probe
ever succeeds.

**Objects inspected** (catalog metadata only — no row data was selected or
exported):

| Object | What was read |
|---|---|
| `public.get_comp_candidates_for_subject` | `pg_get_functiondef`, arguments, result, language, volatility, security, config, grants |
| `public.v_recent_sold_comps` | `pg_get_viewdef(oid, true)`, columns, relkind |
| `public.buyer_comp_raw_v2` | columns, constraints, indexes, grants, RLS policies |
| `public.buyer_entities_v2` | columns, constraints, indexes, grants, RLS policies |
| `public.properties` | columns, constraints, indexes, grants, RLS policies |
| `recently_sold_properties`, `buyer_comp_properties_v2`, `buyer_purchase_events_v2` | existence + columns |
| `pg_extension`, `pg_policies`, `pg_stat_user_tables` | extensions, policies, approximate row counts |

**No production data was written, altered, deleted, or exported. No seller,
owner, phone, email, campaign, message, contract, comp or property row was
selected.**

### 12.2 What the recovery found — the previous stand-in was wrong in six ways

The Pass-2 bootstrap contained a *behavioural stand-in* for the comp RPC. The
recovered production definition differs from it materially:

| | Pass-2 stand-in | Recovered production |
|---|---|---|
| Candidate source | `buyer_comp_raw_v2` directly | **`v_recent_sold_comps`** (a view over it) |
| `comp_id` type | `text` | **`uuid`** |
| Output columns | 24, including a separate `id` | **32, no `id`** |
| Subject exclusion | `c.id IS DISTINCT FROM p_subject_property_id` | `c.property_id IS DISTINCT FROM s.property_id` |
| Recency column | `recording_date` | **`sale_date`** |
| Validity gating | inline lat/lon/date predicates | delegated to `v_recent_sold_comps.is_usable_comp` |
| Distance | haversine, R=3958.7566, 4dp | **spherical law of cosines, R=3958.8, clamped, 2dp** |
| Similarity | distance decay × size parity | **100 − capped sqft/beds/baths/year penalties − 20 asset-class mismatch** |
| Ordering | `dist ASC, recording_date DESC, id ASC` | `similarity DESC, sale_date DESC, distance ASC` (**no unique tiebreaker**) |
| Row cap | `greatest(1, coalesce(p_limit,100))` | `least(greatest(p_limit,1),100)` |
| Defaults | `4, 30, 100` | `1.0, 6, 25` |

The missing link was `v_recent_sold_comps`: it is a view over `buyer_comp_raw_v2`
that passes `id` straight through. That is **why** `compCandidateLoader`'s
identity join `.in('id', compIds)` is correct — `comp_id` *is*
`buyer_comp_raw_v2.id`. No stand-in could have been trusted without that fact.

### 12.3 Parity achieved — proven byte-identical, not asserted

The canonical definitions are now source-controlled at
`apps/api/supabase/contracts/offerr-comp-intelligence/`.

Re-creating them in a fresh PostgreSQL 17 database and reading the catalog back
produces output **byte-identical** to the production catalog:

```
FUNCTION byte-identical to production: True
VIEW     byte-identical to production: True
```

Column contracts compared row-by-row against the recovered catalog:

```
local columns: 333
columns not present in production: []
type/nullability/default mismatches: 0
  properties           local=117  prod=343
  buyer_comp_raw_v2    local=167  prod=167
  buyer_entities_v2    local=49   prod=49
```

| Object | Parity class |
|---|---|
| `get_comp_candidates_for_subject` | **EXACT_PRODUCTION_DEFINITION** (verbatim) |
| `v_recent_sold_comps` | **EXACT_PRODUCTION_DEFINITION** (verbatim) |
| `buyer_comp_raw_v2` | **EXACT_PRODUCTION_COLUMN_CONTRACT** (167/167) |
| `buyer_entities_v2` | **EXACT_PRODUCTION_COLUMN_CONTRACT** (49/49) |
| `properties` | **COMPATIBLE_RECONSTRUCTION** — 117-of-343 columns, exactly the Offerr read surface |
| `system_control` | canonical shape, staging-safe flag state |

**No definition required by the Offerr comp path remains unavailable.**

### 12.4 Licensing and data-rights boundary

Reviewed before committing (full analysis in the contract README §4):

- No credentials in any recovered DDL.
- **No provider name appears anywhere** in any object, column or function body —
  there is no vendor string to redact.
- Provider-shaped *ingest* columns exist (`raw_payload`, `batch_id`,
  `source_record_id`, `import_status`, `row_hash`) — plumbing, not licensed
  content. `import_status` is load-bearing (the view filters on it) and is kept.
- PII-bearing columns exist on `buyer_comp_raw_v2`; the Offerr path reads owner
  name and mailing address only for buyer-identity resolution, and the seller
  projection strips all of it (asserted per-case in the E2E).
- The similarity formula is internal arithmetic, not a licensed provider formula.

**Conclusion: no adapter indirection is needed.** There is no provider-specific
implementation to isolate, so the "sanitized interface + provider adapter"
fallback was not required. Exact production SQL is committed as-is. **No
unresolved licensing decision blocks this work.**

### 12.5 Production posture findings (observed, NOT changed)

Recorded for separate triage. Nothing in production was altered.

1. `get_comp_candidates_for_subject` is `GRANT EXECUTE ... TO PUBLIC` (so `anon`
   and `authenticated` can execute it).
2. `properties`, `buyer_comp_raw_v2`, `buyer_entities_v2` and
   `v_recent_sold_comps` grant full `SELECT, INSERT, UPDATE, DELETE, TRUNCATE`
   to `anon` and `authenticated`. RLS is enabled with SELECT-only policies, so
   **RLS is currently the only thing preventing anonymous writes to the comp
   corpus.**
3. The RPC has no pinned `SET search_path` (mitigated by `SECURITY INVOKER`).

The staging bootstrap deliberately does **not** reproduce finding 2 — a staging
database where `anon` can write comps would make the side-effect proof
meaningless. That deviation is commented in the bootstrap.

### 12.6 The comp injection is gone

`apps/api/scripts/offerr/offerr-e2e-verify.mjs` previously injected:

```js
loadV3CompCandidates: async () => ({ candidates: c.comps })
loadComparableProperties: async () => c.comps ?? []
loadBuyerPurchases: async () => []
loadSubjectProperty: async (id) => (direct pool query)
```

**All four are removed.** The harness now injects exactly two dependencies:

```js
const baseDeps = { db: adapter, supabase: adapter, getSystemFlag: dbFlagReader };
```

`db` serves the Offerr store, the property resolver and `compCandidateLoader`;
`supabase` serves `acquisitionDecisionEngine`'s `db(deps)`. Everything else
resolves to its production default. The only way to change what the engine sees
is to change database rows.

Three independent guards keep it that way:

- a runtime assertion in the harness (`harness injects no comp candidates…`);
- a runtime assertion that the RPC was actually invoked through the adapter;
- a source-level test (`offerr-comp-schema-contract.test.mjs`) that fails if any
  of the six banned injection keys reappears.

### 12.7 The adapter now covers the real query surface

`offerr-pg-rest-adapter.mjs` gained `.rpc()` (named arguments), `.in()`,
`.gte/.lte/.gt/.lt`, and — most importantly — **real column projection**:
`.select('a,b,c')` emits `SELECT "a","b","c"`, not `SELECT *`.

That last one is not cosmetic. `acquisitionDecisionEngine.optionalEnrichmentQuery`
narrows its column list in response to SQLSTATE `42703`. Under `SELECT *` that
retry loop could never execute and a missing column would silently be
`undefined` instead of detected. 17 focused tests pin every operation.

### 12.8 Fixtures are database rows now

The 12-case matrix is expressed purely as rows in the canonical tables:
**15 properties, 40 comps in `buyer_comp_raw_v2`, 8 buyers in
`buyer_entities_v2`**. No case carries a `comps` array any more.

One design change was forced by the real RPC. The residential comp radius is
4 miles, and the original fixtures placed every Houston subject within ~1 mile
of every other — harmless while comps were injected per-case, fatal once
retrieval is real, because C09's $332.5M contaminated comp would have
contaminated C01, C11 and C12. Each case now owns a **coordinate island 0.25°
(~17 mi) apart**, with its comps within ~1.5 mi of their own subject. Comp sets
are provably disjoint; a test asserts every comp-bearing subject pair is ≥ 8 mi
apart. Street/city/ZIP strings are unchanged, because cases 5–8 depend on them
and coordinates never reach a seller.

### 12.9 The real-path 12-case matrix

Database rebuilt **from source-controlled files only** (prereqs → bootstrap →
Offerr migration), then the full harness run with no injected comps:

| Case | HTTP | Resolution | RPC rows | Candidates | Clusters | ESS | Pkg | Dup | Quar | Excl | Execution state | Conf | Outcome | Range |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C01 Clean SFR | 200 | RESOLVED | 7 | 7 | 6 | 6 | 0 | 1 | 0 | 1 | SHADOW_MODE_READY | 84 | INSTANT_RANGE_ELIGIBLE | YES |
| C02 Thin comps | 200 | RESOLVED | 2 | 2 | 2 | 2 | 0 | 0 | 0 | 0 | DATA_REQUIRED | 58 | REVIEW_REQUIRED | null |
| C03 Small multi | 200 | RESOLVED | 3 | 3 | 3 | 3 | 0 | 0 | 0 | 0 | SHADOW_MODE_READY | 72 | INSTANT_RANGE_ELIGIBLE | YES |
| C04 Commercial | 200 | RESOLVED | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | DATA_REQUIRED | 22 | **UNSUPPORTED** | null |
| C05 Ambiguous dup | 200 | AMBIGUOUS | — | 0 | — | — | — | — | — | — | — | — | REVIEW_REQUIRED | null |
| C06 Missing unit | 200 | AMBIGUOUS | — | 0 | — | — | — | — | — | — | — | — | REVIEW_REQUIRED | null |
| C07 ZIP conflict | 200 | NOT_FOUND | — | 0 | — | — | — | — | — | — | — | — | REVIEW_REQUIRED | null |
| C08 No match | 200 | NOT_FOUND | — | 0 | — | — | — | — | — | — | — | — | REVIEW_REQUIRED | null |
| C09 Contaminated | 200 | RESOLVED | 4 | 4 | 4 | 3 | 0 | 0 | **1** | 0 | REVIEW_REQUIRED | 72 | REVIEW_REQUIRED | null |
| C10 Package | 200 | RESOLVED | 12 | 12 | **1** | **0** | **1** | 0 | 12 | 0 | ANOMALY_QUARANTINE | 24 | REVIEW_REQUIRED | null |
| C11 Condition conflict | 200 | RESOLVED | 6 | 6 | 6 | 6 | 0 | 0 | 0 | 0 | SHADOW_MODE_READY | 84 | CONDITIONAL_RANGE | YES |
| C12 Asking > value | 200 | RESOLVED | 6 | 6 | 6 | 6 | 0 | 0 | 0 | 0 | SHADOW_MODE_READY | 84 | CONDITIONAL_RANGE | YES |

Retrieval tier is `rpc_radius_4mi_30mo` for residential cases and
`rpc_radius_7mi_36mo` for C03 (small multifamily) — the real
`eligibilityWindow` ladder, executed, not simulated.

The load-bearing results:

- **Package collapse (C10):** 12 physical rows → **1 economic transaction** →
  **effective sample size 0**. Correlated evidence added no depth, and the
  engine landed in `ANOMALY_QUARANTINE`.
- **Extreme quarantine (C09):** the $332.5M comp was quarantined by the real
  qualification layer (lane ceiling + implausible PPSF + anchor ratio) while the
  3 clean comps survived (ESS 3). No valuation figure came near the contaminated
  price.
- **Duplicate collapse (C01):** 7 rows → 6 clusters, 1 excluded as
  `duplicate_parcel_row`, `DUPLICATE_PARCEL_ROWS` raised. Rows are not
  transactions, proven end-to-end.
- **Buyer/entity loading (all comp-bearing cases):** identity resolved for
  **every** comp (`identity_enriched == rpc_rows`) and the `buyer_entities_v2`
  buy-box matched every comp. The optional enrichment branch executed for real.
- **Empty comps (C04):** `rpc_empty`, `NO_INDEPENDENT_COMPS`, fail-closed,
  `UNSUPPORTED`, no range.

### 12.10 Stubbed vs real — what changed

| Case | Stubbed outcome | Real outcome | Changed? |
|---|---|---|---|
| C01 | INSTANT_RANGE_ELIGIBLE / range | INSTANT_RANGE_ELIGIBLE / range | no |
| C02 | REVIEW_REQUIRED / null | REVIEW_REQUIRED / null | no |
| C03 | INSTANT_RANGE_ELIGIBLE / range | INSTANT_RANGE_ELIGIBLE / range | no |
| C04 | UNSUPPORTED / null | UNSUPPORTED / null | no |
| C05–C08 | REVIEW_REQUIRED / null | REVIEW_REQUIRED / null | no |
| C09 | REVIEW_REQUIRED / null | REVIEW_REQUIRED / null | no (seller outcome) |
| C10 | REVIEW_REQUIRED / null | REVIEW_REQUIRED / null | no |
| C11 | CONDITIONAL_RANGE / range | CONDITIONAL_RANGE / range | no |
| C12 | CONDITIONAL_RANGE / range | CONDITIONAL_RANGE / range | no |

**Every seller-facing outcome, range presence and reason-code set is unchanged.
No assertion had to be rewritten to accommodate the real path, and the old
fixtures were not masking an outcome bug.**

One internal figure did move, and it is an improvement:

- **C09 execution state: `ANOMALY_QUARANTINE` → `REVIEW_REQUIRED`.** Under the
  stub, the raw fixture objects carried no buyer identity, so
  `normalizeCandidate` never ran and `v3_pricing_eligible` was `undefined`.
  Under the real path identity resolves, the 3 clean comps qualify as genuine
  independent evidence (ESS 3), and the engine correctly distinguishes "one
  contaminated comp among good ones" from "nothing usable". The seller-facing
  result is identical; the internal state is now more accurate.

What the stub *was* hiding was not a wrong answer but an **unverified claim**:
whether the RPC, the identity join and the buy-box join worked at all. Those are
now proven.

### 12.11 Idempotency, concurrency and determinism (real comp loader)

| Check | Result |
|---|---|
| Replay same key | 200, `idempotent_replay: true`, **no second snapshot** |
| Replay evaluation_id | identical |
| Same key, different address | **409** `idempotency_key_reused_with_different_payload` |
| 6 simultaneous same-key requests | statuses `200 ×6`; **exactly 1 request row, exactly 1 evaluation** |
| Concurrent evaluation_id agreement | all successful responses agree |
| Orphaned/incomplete request rows | 0 |
| Requests with >1 snapshot | 0 |
| **Comp determinism** | same subject under a **new** key produced an **identical `comp_set_hash`** |

That last row is new and only meaningful now: it proves the canonical RPC
returns a stable evidence set across independent evaluations.

**Persistence failure and compensating cleanup**, forced against the real
database (a temporary always-false `CHECK` constraint on `offerr_evaluations`
makes the snapshot insert fail while the request insert has already committed —
the two are not transactional):

| Check | Result |
|---|---|
| Response | **503**, never a success |
| `failure_code` | `offerr_persistence_failed` |
| Evaluation returned to caller | none |
| Orphaned request row | **0** — the compensating delete ran |
| Request table row count | returned to its pre-failure value |
| Idempotency key after cleanup | **reusable** — a transient DB error does not permanently burn the key |

The constraint is dropped in a `finally` block, so the probe cannot leave the
verification database altered.

### 12.12 Side-effect reconciliation — before → after

All 18 execution/side-effect tables `0 → 0`:

```
property_acquisition_scores 0→0   property_cash_offer_snapshots 0→0
send_queue 0→0                    message_events 0→0
email_send_queue 0→0              follow_up_queue 0→0
campaigns 0→0                     campaign_targets 0→0
contracts 0→0                     offers 0→0
title_orders 0→0                  acquisition_opportunities 0→0
acquisition_events 0→0            deal_thread_state 0→0
universal_lead_command_cache 0→0  lead_command_state 0→0
exchange_listings 0→0             exchange_publications 0→0
```

**Comp corpus (new in Pass 3) — read, never written:**

```
properties          15 → 15
buyer_comp_raw_v2   40 → 40
buyer_entities_v2    8 →  8
```

Tables touched by the spine (reads included):
`rpc:get_comp_candidates_for_subject`, `v_recent_sold_comps`,
`buyer_comp_raw_v2`, `buyer_entities_v2`, `properties`, `acquisition_contacts`,
`buyer_comp_properties_v2`, `buyer_purchase_events_v2`,
`recently_sold_properties`, `offerr_evaluation_requests`, `offerr_evaluations`,
`offerr_evaluation_events`.

Tables **written**: `offerr_evaluation_requests`, `offerr_evaluations`,
`offerr_evaluation_events` — and nothing else. 31 RPC invocations recorded.

Offerr tables `0 → 15 / 0 → 15 / 0 → 15` (12 matrix + V3-disabled + determinism
probe + concurrency winner).

### 12.13 Latency — real comp path, 30 repeated evaluations

Local disposable PostgreSQL 17.10 in Docker. **These are local numbers and do
not predict hosted Supabase latency.**

Wall clock over 30 evaluations: `min 164ms, p50 249ms, p95 600ms, max 629ms`.

| Stage | p50 | p95 | max |
|---|---|---|---|
| validate | 0 | 0 | 1 |
| idempotency | 3 | 29 | 85 |
| resolution | 5 | 24 | 34 |
| subject hydration | 9 | 22 | 233 |
| overlay | 0 | 1 | 1 |
| **comp load (RPC + 2 joins)** | **92** | **210** | **433** |
| engine | 5 | 11 | 14 |
| gates | 0 | 1 | 1 |
| persistence + overhead (derived) | 135 | — | — |

12-case matrix: `min 31ms, p50 234ms, p95 589ms, max 589ms`.

`persistence_ms` and `total_ms` are absent from the lifecycle event's payload
because the service assigns them *after* handing the payload to the store, so
they cannot appear in the event that same call writes. Persistence is therefore
reported as a derived residual. This is an observability gap, not a correctness
one.

A second 30-sample run taken while three PostgreSQL containers and the full
critical suite were competing for the same CPU measured `p50 838ms, p95 1822ms,
max 1851ms` — still an order of magnitude inside the deadline, but a useful
reminder that these figures track host load and say nothing about hosted
Supabase.

**Is the 15-second deadline still realistic?** Yes, with margin. Comp load is now
the dominant stage (p50 92ms, max 433ms locally) and it is the stage most
exposed to hosted network latency and real comp density — the local corpus is 40
rows against production's ~48k. A 10× hosted degradation would still leave
roughly an order of magnitude of headroom. The deadline should be re-measured
against hosted staging before launch, not assumed.

### 12.14 Schema drift detection

New: `apps/api/scripts/offerr/offerr-schema-drift-check.mjs`. Strictly read-only
(`default_transaction_read_only=on` + explicit `BEGIN TRANSACTION READ ONLY`);
a test asserts the file contains no mutating statement. The contract is read
from `schema-contract.json`, not hard-coded.

It verifies required tables/views, every required column **and its type**,
required indexes, the RPC's existence + exact signature + 32-column result
contract + `STABLE` volatility, the schema-contract version, the Offerr tables,
the feature flag, and the comp-corpus grant posture.

Stable machine-readable failure codes: `missing_properties_table`,
`missing_comp_table`, `missing_comp_view`, `missing_buyer_entity_table`,
`missing_comp_rpc`, `comp_rpc_signature_mismatch`,
`comp_rpc_result_contract_mismatch`, `schema_contract_version_mismatch`,
`missing_required_column`, `missing_required_index`, `missing_offerr_table`,
`missing_offerr_feature_flag`, `grant_posture_mismatch`.

Result against the rebuilt verification database: **22 checks, COMPATIBLE, exit 0.**

Negative-tested, not just asserted: dropping the RPC yields `missing_comp_rpc`;
replacing it with a 2-argument, 2-column stub yields both
`comp_rpc_signature_mismatch` and `comp_rpc_result_contract_mismatch`.

**A regression this work introduced, caught by the existing gate.** The
contract-version marker was first created as `public.offerr_schema_contract`.
`offerr-schema-verify.sql` immediately failed three of its 47 checks: the
migration is supposed to create *exactly three* `offerr%` tables, and `anon` /
`authenticated` are supposed to hold *zero* privileges on them — a
bootstrap-owned fourth table in that namespace broke both, and it had silently
inherited `anon`/`authenticated` DML from the prereqs' `ALTER DEFAULT
PRIVILEGES`. Fixed by renaming it to
`public.comp_intelligence_schema_contract` (it describes the comp contract, not
the Offerr spine) and revoking those grants explicitly. Schema verification is
back to **47/47**. Worth recording because it is evidence the gate does its job
on new work, not only on old.

### 12.15 Test results

| Suite | Pass 2 | Pass 3 |
|---|---|---|
| Offerr critical tests (with database) | 78 | **139 pass, 0 fail, 0 skip** |
| Offerr critical tests (no database) | 78 | **115 pass, 0 fail, 2 skip** |
| Real-path E2E assertions | 207 (stubbed comps) | **291 pass, 0 fail** |
| RPC contract cases vs real PostgreSQL 17 | — | **20 + 2 loader = 22** |
| Schema drift check | — | **22 checks, COMPATIBLE** |
| Acquisition + comp-intelligence regressions | — | **334 pass, 0 fail** |
| Schema verification (`offerr-schema-verify.sql`) | 47 | **47 / 47** |
| Lint | pass | **pass (1479 files)** |

The 2 skips are the database-backed RPC contract suites when
`OFFERR_VERIFY_DATABASE_URL` is unset — they skip rather than fail so the default
`npm test` stays green without a container.

### 12.16 Hosted staging readiness — the five questions

1. **Can a newly created Supabase project be bootstrapped from repository files
   alone?** **Yes — demonstrated.** The verification database was dropped and
   rebuilt from `offerr-supabase-prereqs.sql` (local only) →
   `offerr-staging-bootstrap.sql` → the Offerr migration, with no manual DDL, and
   the full 291-assertion suite passed against it. This was the Pass-2 blocker
   (§11.2) and it is closed.
2. **Does the E2E suite exercise the actual default comp-loader path?** **Yes.**
   No comp candidate, comp, buyer entity, buyer purchase, subject row, engine
   decision or seller outcome is injected. Proven at runtime (the RPC-invocation
   assertion) and at source level (the banned-injection test).
3. **Is the staging RPC exact production SQL or a compatible stand-in?**
   **Exact production SQL**, verbatim, verified byte-identical on catalog
   round-trip. Same for `v_recent_sold_comps`.
4. **Are production comp-retrieval semantics verified?** **The SQL semantics are
   verified; production data behaviour is not.** 20 contract cases pin filter,
   distance, similarity, ordering, limit, identity and read-only semantics
   against real PostgreSQL 17. What remains unverified is how that SQL behaves
   over the *real corpus* — 40 synthetic rows here versus ~48k production rows,
   with unknown real duplicate and package rates.
5. **What remains before a hosted V3-enabled result can be trusted?** See §12.17.

**Verdict: the repository-side comp-parity gap is closed. The system is not yet
"hosted-staging-verified", because no hosted staging project exists.** Every
remaining blocker is an operator/infrastructure action, not a code gap.

### 12.17 Remaining production-parity risks

1. **The canonical `ORDER BY` has no unique tiebreaker.** Rows equal on
   (similarity, sale_date, distance) have implementation-defined order; with
   `p_limit` truncating, *which* comps survive can vary. Reproduced faithfully
   rather than silently patched. **Recommended production fix: append
   `, comp_id ASC`.**
2. **Future-dated sales are not excluded** by the RPC or the view (lower bound
   only). Contract case 4 documents this.
3. **Zero and negative prices reach the loader** — `is_usable_comp` only tests
   `NOT NULL`. They are quarantined at qualification as `nominal_consideration`,
   but they consume rows against the 100-row cap. Contract case 6 documents this.
4. **`properties` in staging is a 117-of-343 column subset.** It covers the whole
   current read surface; a future engine change reading a 344th column would pass
   staging and fail production. The drift checker exists to catch that.
5. **Real corpus behaviour is uncharacterised.** Comp density, duplicate rates
   and package frequency in production are unknown from this work.
6. **Production grant posture** (§12.5) — comp tables are `anon`-writable at the
   grant level, with RLS as the only guard.
7. **Hosted latency is unmeasured.** All figures here are local Docker.

### 12.18 Operator action required (updated, ordered)

1. **Approve billing** for an additional Supabase project in org
   `gosflvntwnxegkrulmoz`.
2. **Create** `real-estate-automation-staging`, West US (Oregon), fresh password
   (never committed).
3. **Bootstrap** it — `offerr-supabase-prereqs.sql` is *not* needed (hosted
   Supabase already has the roles): run `offerr-staging-bootstrap.sql`, then
   `PROPOSED_20260729120000_offerr_evaluation_spine.sql`, then
   `offerr-schema-verify.sql`.
4. **Run the drift check** against it (`offerr-schema-drift-check.mjs`) and
   require `COMPATIBLE` before proceeding.
5. **Run the real-path E2E** against it and compare the 12-case matrix to §12.9.
6. **Deploy** the `api` Vercel project to preview with staging env vars.
7. Consider the production follow-ups in §12.17 items 1–3 and §12.5.

~~4. Rewire the E2E harness onto the real comp RPC (§11.5) before trusting any
V3-enabled matrix result.~~ **Done in Pass 3.**

### 12.19 Pass-3 state

- **No production write occurred.** Production was inspected read-only with
  server-enforced `default_transaction_read_only=on`; the write probe was
  refused with SQLSTATE 25006.
- No hosted project was created; nothing was deployed to Vercel.
- All verification ran against a disposable PostgreSQL 17.10 Docker container,
  destroyed afterwards.
- `offerr_evaluation_enabled` remains `false`; the migration remains
  `PROPOSED_`-prefixed and applied to no hosted project.
- Offerr tests **139/139**, E2E **291/291**, RPC contract **22/22**, drift check
  **COMPATIBLE**, lint **pass**.
- PR #57 remains **draft and unmerged**.

---

## 13. Pass 4 — hosted verification on a Supabase preview branch (2026-07-31)

Pass 3 ended blocked on "there is no staging Supabase project". Pass 4 removed
that blocker **without creating a second permanent project**, by using a
temporary **preview branch inside the canonical project**. Every result in this
section was produced against hosted Supabase and a real Vercel deployment over
HTTPS — none of it is Docker or in-process.

### 13.1 Canonical one-project architecture

There is exactly **one** permanent Supabase project:

| | |
|---|---|
| Project | `real-estate-automation` |
| Project ref | `lcppdrmrdfblstpcbgpf` |
| Organization | REI Automation (`gosflvntwnxegkrulmoz`) |
| Region | West US (Oregon) / `us-west-2` |

It is the canonical data platform for LeadCommand, OfferrAI, Reivesti
Intelligence, Reivesti Exchange and shared property/buyer intelligence. Product
boundaries are enforced by schemas, grants, RLS, APIs, feature flags and domain
contracts — **not** by separate permanent databases. A Supabase preview branch
is a temporary verification environment *inside* that project, not a second
product database.

### 13.2 Branching audit (Phase 2–3)

Branching was already **enabled** on the parent project — it did not need to be
turned on, and no plan change was required:

| Branch | Ref | Default | Git branch | Status |
|---|---|---|---|---|
| `main` | `lcppdrmrdfblstpcbgpf` | **yes (production)** | `main` | MIGRATIONS_FAILED |
| `acquisition-engine-validation` | `skpmxvjwhpwkwutlowls` | no | — | MIGRATIONS_FAILED |

- **GitHub integration:** the parent's `main` branch is git-linked, but the
  Vercel `api` project has **no connected Git repository**, and no preview
  branch had been auto-created for PR #57. Automatic PR branching was therefore
  not in play; the branch was created explicitly via the CLI.
- **Cost:** Supabase bills branching at **$0.01344 per branch per hour**
  (≈ $0.32/day, ≈ $9.81/month). No new project or subscription was required.
- Both pre-existing branches sit in `MIGRATIONS_FAILED`, which is the parent
  repo's chronic migration state, not a branch fault. The branch database is
  still fully usable — that status describes the integration's migration run.

### 13.3 Preview branch identity (Phase 4)

| | |
|---|---|
| Branch name | `offerr-evaluation-spine-pr-57` |
| Branch id | `8e2b7bd7-bc5a-42f5-8fcb-7098eabf9612` |
| **Preview project ref** | **`ktvjkokwcqcgapzztkwu`** |
| Parent project ref | `lcppdrmrdfblstpcbgpf` |
| Persistent | **no — ephemeral** |
| Cloned production data | **no** (`--with-data` omitted) |
| Region | `us-west-2` (same as parent) |
| Created | 2026-07-31 01:41:53 UTC |
| Creation method | `supabase branches create offerr-evaluation-spine-pr-57 --project-ref lcppdrmrdfblstpcbgpf --region us-west-2` |

### 13.4 Branch-safe targeting — a new guard (Phase 5)

`offerr-staging-guard.mjs` proves a target is *not* production. It cannot prove
a target *is* a preview branch — it can only be *told* so via
`OFFERR_STAGING_PROJECT_REF`. Under a one-project architecture that gap matters,
because the parent's **default branch is production** and "is a branch" is not
by itself a safety property.

**New:** `apps/api/scripts/offerr/offerr-preview-branch-guard.mjs` closes it by
asking the Supabase control plane. The target ref must appear in the parent's
branch list **and** must not be the default branch. Proven refusal classes:

| # | Scenario | Result |
|---|---|---|
| 1 | production ref `lcppdrmrdfblstpcbgpf` | refused — `production` |
| 2 | ReivestiExchange `wwqqwllstapdolkndzzx` | refused — `foreign_product` |
| 3 | SignPro `lvocccmhnyfoyqnbmmci` | refused — `foreign_product` |
| 4 | `ALLOW_OFFERR_STAGING_FIXTURES` absent | refused — no opt-in |
| 5 | `VERCEL_ENV=production` runtime | refused — `production_environment` |
| 6 | real-looking ref that is not a branch of the parent | refused — `not_a_branch_of_parent` |
| 7 | the parent's **default** branch | refused — `default_branch` |
| 8 | control plane unreachable | refused — `identity_unresolvable` (fail closed) |

The identity block it prints precedes **every** hosted write in this section.

### 13.5 Pre-bootstrap branch audit (Phase 6)

The branch was **not** initialised from the parent's schema. It was created
empty and the GitHub integration replayed the repo's root `supabase/migrations`,
which failed after two files:

| Property | Observed |
|---|---|
| PostgreSQL | 17.6 |
| `public` tables | 2 — `inbox_thread_state`, `message_events` |
| `public` views / Offerr objects | none |
| Migration history | 2 rows (`20260428_create_inbox_thread_state`, `20260429_create_message_events_table`) |
| Extensions | `pgcrypto`, `uuid-ossp`, `plpgsql`, `supabase_vault`, `pg_stat_statements` |
| Roles | `anon`, `authenticated`, `authenticator`, `service_role`, `postgres` |

Critically, `pg_default_acl` for schema `public` already carried, from **both**
`postgres` and `supabase_admin`:

```
r (tables)    -> postgres, anon, authenticated, service_role = arwdDxtm
f (functions) -> postgres, anon, authenticated, service_role = X
S (sequences) -> postgres, anon, authenticated, service_role = rwU
```

This is what `offerr-supabase-prereqs.sql` reproduces locally. **It was therefore
skipped entirely on the branch** — hosted Supabase already supplies the roles,
schema `USAGE`, and default privileges, and the bootstrap creates
`public.system_control` itself. Applying the local-only file would have added
duplicate default-ACL entries for no benefit.

### 13.6 Bootstrap and migration (Phase 7)

Applied with `psql -v ON_ERROR_STOP=1 --single-transaction`, in order:

1. `apps/api/scripts/offerr/offerr-staging-bootstrap.sql` — which `\ir`-includes
   the canonical contract verbatim from
   `apps/api/supabase/contracts/offerr-comp-intelligence/canonical/`.
2. `apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql`.

Objects created: `system_control` (+ trigger, RLS, 3 policies), `properties`,
`buyer_comp_raw_v2`, `buyer_entities_v2`, `v_recent_sold_comps`,
`get_comp_candidates_for_subject`, `comp_intelligence_schema_contract`, the three
`offerr_*` tables, `offerr_touch_updated_at()`, all documented indexes,
constraints, RLS policies, grants and revokes.

The bootstrap's own completeness assertion passed:
`contract offerr-comp-intelligence 1.0.0 applied · 4 tables + 1 view + 1 RPC
(32-column contract) · offerr_evaluation_enabled pinned false`.

Re-applying the migration a second time succeeded unchanged — **idempotent on
hosted Supabase**.

### 13.7 HOSTED-ONLY DEFECT FOUND AND FIXED — function EXECUTE leaked to `anon`

The first `offerr-schema-verify.sql` run on the branch returned **46 PASS / 1
FAIL**:

```
FAIL  no public function exposes offerr internals to anon/authenticated
```

**Cause.** The migration contained only:

```sql
REVOKE ALL ON FUNCTION public.offerr_touch_updated_at() FROM PUBLIC;
```

That is sufficient on stock PostgreSQL, where the only EXECUTE grant on a new
function is the implicit one to `PUBLIC`. Hosted Supabase *additionally* seeds
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,
authenticated, service_role`, which materialises as **explicit per-role grants**.
`REVOKE ... FROM PUBLIC` cannot remove an explicit role grant. Observed ACL:

```
{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
```

**Why every prior pass missed it.** `offerr-supabase-prereqs.sql` reproduced
Supabase's `ALTER DEFAULT PRIVILEGES ... ON TABLES` but **not** `ON FUNCTIONS`.
The local Docker verification could not express the defect, so it passed.

**Fix (three parts).**

1. `PROPOSED_20260729120000_offerr_evaluation_spine.sql` now also runs
   `REVOKE ALL ON FUNCTION public.offerr_touch_updated_at() FROM anon,
   authenticated, service_role;`. Revoking from `service_role` is safe:
   PostgreSQL checks EXECUTE on a trigger function at `CREATE TRIGGER` time, not
   per firing.
2. `offerr-supabase-prereqs.sql` now reproduces the hosted `ON FUNCTIONS` and
   `ON SEQUENCES` defaults, so this class of defect is reproducible off-host.
3. New regression suite
   `apps/api/tests/critical/offerr-hosted-privilege-contract.test.mjs`.

**Post-fix ACL:** `{postgres=X/postgres}` — owner only.

The regression test was verified to actually fail: re-granting EXECUTE to
`anon, authenticated` turned it red (3 failing assertions), and restoring the
revoke turned it green (5/5).

### 13.8 Schema verification and drift (Phase 8)

| Gate | Result |
|---|---|
| `offerr-schema-verify.sql` | **47 PASS / 0 FAIL** |
| `offerr-schema-drift-check.mjs` | **COMPATIBLE** (22 checks) |
| RPC signature | matches canonical contract |
| RPC result contract | 32 columns |
| Contract marker | `offerr-comp-intelligence` `1.0.0` |
| `offerr_*` tables | exactly 3 |
| `offerr_evaluation_enabled` | present, `false` |

### 13.9 Hosted RLS and privilege proof over real PostgREST (Phase 9)

New: `apps/api/scripts/offerr/offerr-preview-rls-proof.mjs`. This is behavioural,
not catalog-based — it drives the branch's real PostgREST endpoint.
**40 checks / 40 pass.**

| Role | Surface | Result |
|---|---|---|
| `anon` | SELECT/INSERT/UPDATE/DELETE × 3 `offerr_*` tables | **401**, SQLSTATE `42501` (12/12) |
| `anon` | `rpc/offerr_touch_updated_at` | **404** `PGRST202` (not exposed) |
| `authenticated` (minted HS256 JWT) | same 12 operations | **403**, `42501` (12/12) |
| `authenticated` | `rpc/offerr_touch_updated_at` | **404** `PGRST202` |
| `service_role` | request SELECT/INSERT/UPDATE/DELETE | allowed |
| `service_role` | evaluation INSERT/SELECT | allowed |
| `service_role` | evaluation **UPDATE / DELETE** | **403 `42501`** — immutable |
| `service_role` | event INSERT/SELECT | allowed |
| `service_role` | event **UPDATE / DELETE** | **403 `42501`** — append-only |
| `service_role` | delete childless request (compensation) | allowed (204) |
| `service_role` | delete request **with** children | **409 `23503`** — FK-protected |

Neither FK from `offerr_evaluations` / `offerr_evaluation_events` is
`ON DELETE CASCADE`. Compensating deletion therefore only succeeds on a request
with no snapshot — which is exactly the failure path it exists for (proven in
§13.14).

### 13.10 Vercel preview (Phases 10–11)

| | |
|---|---|
| Project | `api` (`prj_A9B8eQB3NKN9lm4KQFN4KAreitgN`) |
| Team | Real-Estate-Automation (`team_Qa2ICFdTuZpqNjsAThz90rHV`) |
| Root directory | `.` (deployed from `apps/api`) |
| Git integration | **none** — every deployment is CLI-driven |
| Supabase→Vercel var sync | **not configured** (requires the Git integration) |
| Pre-existing PR-57 preview | **none** |

Because the project has no connected Git repository, Vercel **rejects
branch-scoped Preview environment variables** (`git_branch_required`). Rather
than write project-wide Preview variables that would leak the preview database
into any future preview deployment, configuration was passed as
**deployment-scoped** `vercel deploy -e KEY=VALUE`. Nothing was persisted in
project settings, so there is nothing to clean up and zero blast radius.

Variable **names** configured (values never recorded):
`SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `INTERNAL_API_SECRET`,
`OFFERR_ENVIRONMENT`, `OFFERR_STAGING_PROJECT_REF`,
`ALLOW_OFFERR_STAGING_FIXTURES`, `ACQUISITION_ENGINE_V3_ENABLED`,
`ACQUISITION_ENGINE_V3_ALLOW_PERSIST`, `ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER`,
`ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE`,
`ACQUISITION_ENGINE_V3_SHADOW_MODE`, `OUTBOUND_SMS_ENABLED`, `EMAIL_ENABLED`.

`INTERNAL_API_SECRET` is a **freshly generated preview-only secret**, not the
production value. No SMS, email, campaign, provider, title, contract or
Exchange credential was configured.

| Deployment | Id | URL | V3 |
|---|---|---|---|
| 1 | `dpl_7bbhdWUjK44NnD2yaDJro5JVNi8T` | `https://api-awaw59yew-real-estate-automation.vercel.app` | disabled |
| 2 | `dpl_4hg1Ese6Jat8Psg4XqUCwprxbGSP` | `https://api-2dwi9ed5e-real-estate-automation.vercel.app` | enabled |

Both report `target: null` — **preview, not production**. No alias, no domain,
no promotion, no production environment variable was touched.

**Proof the preview is bound to the preview branch, not production.** The route
returned `423 system_control_disabled` until `offerr_evaluation_enabled` was set
to `true` **in `ktvjkokwcqcgapzztkwu`**, after which the same URL returned `200`
— and the resulting request/evaluation/event rows were then read back out of
that branch by ref-verified `psql`. Production has never had the `offerr_*`
tables at all.

Deployment Protection (`ssoProtection: all_except_custom_domains`) is enabled.
Requests used the project's **pre-existing** automation bypass secret via
`x-vercel-protection-bypass`; it was not created, rotated, or modified here, and
its value is not recorded in this repository.

### 13.11 Fixtures (Phase 12)

Seeded through the guarded loader after the preview-branch identity block:

| Table | Rows |
|---|---|
| `properties` | 15 |
| `buyer_comp_raw_v2` | 40 |
| `buyer_entities_v2` | 8 |

Every identifier is `OFFERR-STAGING-TEST-` prefixed. Non-fixture rows in
`properties`, `buyer_comp_raw_v2` and `buyer_entities_v2`: **0**. No production
seller, owner, phone, email, campaign, conversation, offer, contract or title
record was copied.

### 13.12 Real HTTPS — feature flag disabled (Phase 13) — 13/13

| Check | Result |
|---|---|
| missing secret | **401** `missing_internal_api_secret_token` |
| wrong secret | **401** |
| auth precedes flag lookup | confirmed (unauthenticated sees 401, never 423) |
| valid request while disabled | **423** `system_control_disabled` |
| request / evaluation / event rows written | **0 / 0 / 0** |

**Ordering finding.** The deployed route evaluates
`auth (401) → flag (423) → size (413) → parse (400) → intake (400)`. While the
flag is OFF, malformed JSON, invalid intake and oversized bodies all return
**423**, not 400/413, because the flag gate precedes body handling. This is
fail-closed and correct — a disabled feature should not parse attacker-controlled
input or disclose its validation behaviour. The 400/400/413 contract is
therefore asserted with the flag ON (§13.13), where those codes are reachable.

### 13.13 Real HTTPS — V3 disabled (Phase 14) — 9/9

`ACQUISITION_ENGINE_V3_ENABLED=false`, flag ON, C01 clean SFR:

- HTTP **200** in 3028 ms (cold start)
- outcome **`REVIEW_REQUIRED`**, `preliminary_range` **null**
- request row persisted, immutable evaluation persisted, persisted range null
- no V2 fallback offer exposed; seller-safe scan clean
- no side effect outside `offerr_*`

Request-validation contract with the flag ON: malformed JSON → **400**
`invalid_offerr_intake`; invalid intake → **400**; oversized → **413**; rejected
requests persisted **0** rows.

### 13.14 Real HTTPS — the 12-case matrix, V3 enabled (Phases 15–17, 19–21) — 139/139

Every row below is a real HTTPS call to the deployed preview.

| case | http | ms | resolution | outcome | confidence | range | events |
|---|---|---|---|---|---|---|---|
| C01_CLEAN_SFR | 200 | 1672 | RESOLVED | INSTANT_RANGE_ELIGIBLE | HIGH | 84 579–93 229 | 1 |
| C02_CONDITIONAL_SFR | 200 | 1524 | RESOLVED | REVIEW_REQUIRED | MEDIUM | null | 1 |
| C03_SMALL_MULTI | 200 | 1645 | RESOLVED | INSTANT_RANGE_ELIGIBLE | MEDIUM | 197 000–217 148 | 1 |
| C04_UNSUPPORTED_ASSET | 200 | 1523 | RESOLVED | **UNSUPPORTED** | LOW | null | 1 |
| C05_AMBIGUOUS_DUPLICATE | 200 | 783 | **AMBIGUOUS** | REVIEW_REQUIRED | LOW | null | 1 |
| C06_MISSING_UNIT | 200 | 623 | **AMBIGUOUS** | REVIEW_REQUIRED | LOW | null | 1 |
| C07_CONFLICTING_ZIP | 200 | 625 | **NOT_FOUND** | REVIEW_REQUIRED | LOW | null | 1 |
| C08_NO_MATCH | 200 | 579 | **NOT_FOUND** | REVIEW_REQUIRED | LOW | null | 1 |
| C09_CONTAMINATED_COMP | 200 | 1493 | RESOLVED | REVIEW_REQUIRED | MEDIUM | null | 1 |
| C10_PACKAGE_COMPS | 200 | 1536 | RESOLVED | REVIEW_REQUIRED | LOW | null | 1 |
| C11_SELLER_CONDITION_CONFLICT | 200 | 1452 | RESOLVED | **CONDITIONAL_RANGE** | MEDIUM | 84 579–93 229 | 1 |
| C12_ASKING_ABOVE_VALUE | 200 | 1550 | RESOLVED | **CONDITIONAL_RANGE** | MEDIUM | 84 579–93 229 | 1 |

Required matrix outcomes, all met: C04 commercial is `UNSUPPORTED` with no range
— canonical non-residential evidence is not overridden by weak SFR inference;
C05–C08 all fail closed with no range and no candidate/private identifier leak;
C09's $332.5 M contaminated comp is quarantined and anchors nothing; C10's
12 broadcast rows collapse to one economic transaction and cannot produce a
range; C11 and C12 are both downgraded away from `INSTANT_RANGE_ELIGIBLE`.
C01/C11/C12 share a range because the fixture generator gives them identical
six-comp sets — the difference under test is the conflict downgrade, not price.

**Idempotency (Phase 17).** Replay → **200** with `idempotent_replay: true` and
**1** snapshot (no second row). Same key + different property → **409** with
stable `failure_code: idempotency_key_reused_with_different_payload`, no extra
snapshot, and no disclosure of the stored payload.

**Concurrency (Phase 17).** Six simultaneous requests on one key →
**exactly 1 request row, exactly 1 evaluation snapshot, zero HTTP 500**. Two runs
were observed: `200×6` (all deterministic replays) and `200×5 + 503×1` (one
retryable loser). Both satisfy the contract.

**New key, same property** → separate evaluation, and the comp-set hash was
byte-identical across evaluations
(`ebcfb06b…d924f794`), confirming determinism over unchanged data.

**Persistence-failure recovery (Phase 18) — 11/11.** A temporary
`BEFORE INSERT` trigger on `offerr_evaluations` was installed inside a
`try/finally`, so it could not survive a crash:

- response **503** `offerr_persistence_failed` — never a success, never a 500
- the induced-failure string never reached the caller
- **0** evaluation snapshots persisted
- request count returned to its pre-failure baseline (**45 → 45**) — the
  compensating deletion removed the orphan
- the same idempotency key was then reusable: retry → **200**,
  `idempotent_replay: false`, exactly 1 request + 1 evaluation
- trigger and function dropped; **0** temporary hooks left behind

**Seller-safe privacy (Phase 19).** Every response was recursively scanned for
forbidden keys (`internal_result`, `provenance`, MAO/assignment-fee, buy-box,
buyer/owner identifiers, campaign/contract/title state, suppression, candidate
lists) and forbidden value patterns (bare UUIDs outside allow-listed id fields,
SQL text, stack frames, `pg_*`/`information_schema`/SQLSTATE strings). **Zero
findings across every case, every error envelope and the 409/423/503 bodies.**
Each range carries `binding: false`, `preliminary: true`, an approved disclaimer
naming it non-binding and *not an offer*, an `expires_at`, and a seller-
appropriate `next_step`.

**Side-effect reconciliation (Phase 20).** Only `offerr_*` tables changed.
`properties` 15→15, `buyer_comp_raw_v2` 40→40, `buyer_entities_v2` 8→8 — the
property/comp/buyer surface is strictly read-only during evaluation. These
execution and marketplace tables **do not exist on the preview branch at all**,
so they cannot be written by construction: `property_acquisition_scores`,
`send_queue`, `email_queue`, `followup_queue`, `campaigns`, `campaign_targets`,
`offers`, `contracts`, `title_orders`, `acquisition_opportunities`,
`contact_outreach_state`, `ops_notifications`. Requests without an evaluation
snapshot: **0**. No external provider request was made.

**Hosted latency (Phase 21).** 30 repeated clean-property evaluations over real
HTTPS:

| metric | value |
|---|---|
| HTTP wall-clock p50 | **1 709.9 ms** |
| HTTP wall-clock p95 | **2 303.6 ms** |
| HTTP wall-clock max | **2 336.4 ms** |
| first sample (cold) | 1 909 ms |
| non-200 responses | 0 |

Comfortably inside the 15 s deadline. Function region and database region are
both `us-west-2`. This supersedes the Pass-3 Docker latency, which measured a
different system.

### 13.15 Final flag state and cleanup (Phase 24)

Verified directly against the preview branch after every phase completed:

| Item | Final value |
|---|---|
| `offerr_evaluation_enabled` (preview branch) | **`false`** |
| any `system_control` key not equal to `false` | **none** |
| `offerr_evaluation_requests` / `offerr_evaluations` / `offerr_evaluation_events` | **0 / 0 / 0** |
| incomplete Offerr requests (request without snapshot) | **0** |
| synthetic fixtures (properties / comps / buyers) | **0 / 0 / 0** — removed by the E2E harness's own cleanup; both harnesses re-seed automatically on the next run |
| temporary failure constraints or hooks | **0** |
| `offerr_touch_updated_at()` ACL | `{postgres=X/postgres}` — owner only |
| `ACQUISITION_ENGINE_V3_ENABLED` (preview deployment) | deployment-scoped only; **nothing persisted in Vercel project settings** |
| Production `system_control` | **untouched — the migration has never been applied to production** |

Nothing needs undoing in Vercel: because configuration was passed with
`vercel deploy -e`, no Preview environment variable was ever written to the
`api` project — `vercel env ls preview` remains empty.

### 13.16 Preview branch retention (Phase 25)

- **Status:** retained.
- **Reason:** PR #57 is under review; the preview URL and branch are the
  evidence behind this section and let a reviewer re-run any check.
- **Deletion trigger:** when PR #57 is merged or closed, or when review
  concludes — whichever comes first.
- **Owner:** Ryan (operator). One command:
  `supabase branches delete 8e2b7bd7-bc5a-42f5-8fcb-7098eabf9612 --project-ref lcppdrmrdfblstpcbgpf`
- **Cost while retained:** ≈ $0.32/day. The branch is ephemeral, so it will not
  outlive the PR.

### 13.17 Pass-4 state

- **The production database was not modified.** No schema write, fixture load,
  feature-flag change or synthetic evaluation targeted `lcppdrmrdfblstpcbgpf`.
  Every hosted write was preceded by a printed identity block proving the target
  was preview branch `ktvjkokwcqcgapzztkwu`.
- **No second permanent Supabase project was created** — one ephemeral preview
  branch inside the canonical project.
- Nothing was promoted to production on Vercel; no alias or domain was attached.
- The migration remains `PROPOSED_`-prefixed and applied to **no** production
  database.
- PR #57 remains **draft and unmerged**.

---

## 14. Production landing (2026-07-31)

Controlled installation of the Offerr Evaluation Spine into production with the
feature flag **OFF**. No seller traffic, no public UI, no activation.

### 14.1 Identity and target

| Field | Value |
|---|---|
| Project name | `real-estate-automation` |
| Project reference | `lcppdrmrdfblstpcbgpf` |
| Organization | REI Automation (`gosflvntwnxegkrulmoz`) |
| Region | West US (Oregon) |
| PostgreSQL version | **17.6** |
| Environment | production |
| Migration applied | `apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql` |
| Migration timestamp | 2026-07-31 22:43:43 UTC (flag row `updated_at`) |
| Merge commit | `6a0fd9340bf9259c8e198b32643c063ed4f903d1` |
| Pre-merge branch HEAD | `e12ac1b1f3030e8b0bd091990567c0edc62eeac8` |

Every production write was preceded by a printed identity block. The psql
wrapper used for this rollout **refuses to connect** unless the connection
string contains `lcppdrmrdfblstpcbgpf`, so a preview reference could not be
targeted by accident.

### 14.2 Read-only audit proof

Before inspection, `default_transaction_read_only=on` was forced and two
deliberate write probes were issued inside an explicit `BEGIN READ ONLY`:

| Probe | Result |
|---|---|
| `UPDATE public.system_control ... WHERE key='__readonly_probe_never_matches__'` | `ERROR: cannot execute UPDATE in a read-only transaction` |
| `CREATE TEMP TABLE __readonly_probe(x int)` | `ERROR: cannot execute CREATE TABLE in a read-only transaction` |

The server — not the client — refused both. Pre-migration state was clean: zero
`offerr%` relations, zero `offerr%` functions, no `offerr_evaluation_enabled`
row, and no migration-history collision on `20260729120000`.

Production reproduces the same Supabase default-ACL posture that produced the
hosted-only `EXECUTE` leak fixed on this branch:

```
default ACL, TABLES:    {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
                         authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
default ACL, FUNCTIONS: {postgres=X/postgres,anon=X/postgres,
                         authenticated=X/postgres,service_role=X/postgres}
```

The migration's explicit per-role `REVOKE`s are therefore load-bearing in
production. **They must not be weakened or removed.**

### 14.3 Exact production write set

Applied in a **single transaction**, exit code 0:

- `public.offerr_evaluation_requests`, `public.offerr_evaluations`,
  `public.offerr_evaluation_events`
- `public.offerr_touch_updated_at()` + trigger
  `trg_offerr_eval_requests_touch` on requests only
- constraints, indexes, RLS enable, 3 `service_role`-scoped policies
- grants/revokes as documented in §14.4
- `system_control['offerr_evaluation_enabled'] = 'false'` (`INSERT 0 1`)
- `NOTIFY pgrst, 'reload schema'`

The payload contains **no** seller data, property data, record copies, score or
comp mutations, offers, campaigns, messages, contracts, LeadCommand lifecycle
records, marketplace publications, or enablement of any flag. Its only DML is
the disabled flag seed.

**Migration history was intentionally not written.** `PROPOSED_`-prefixed files
sit outside the `supabase db push` path by repository convention and are
operator-applied; production confirms no `PROPOSED_` migration has ever been
recorded (`20260626000000` closing-desk is likewise absent). `migration_history_rows`
is unchanged at 195.

### 14.4 Verification results

| Gate | Result |
|---|---|
| Schema verification | **36/36 PASS, 0 FAIL** |
| Post-migration drift | 20 PASS / 2 FAIL — see below |
| `anon` privileges on all 3 tables | **zero** (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES all false) |
| `authenticated` privileges on all 3 tables | **zero** |
| `PUBLIC` in table ACLs | **absent** |
| `service_role` on requests | SELECT, INSERT, UPDATE, DELETE |
| `service_role` on evaluations | SELECT, INSERT only — **no UPDATE, no DELETE** |
| `service_role` on events | SELECT, INSERT only — **no UPDATE, no DELETE** |
| `offerr_touch_updated_at()` ACL | `{postgres=X/postgres}` — **owner-only** |
| RLS | enabled on all 3, `service_role`-scoped `ALL` policies |
| `offerr_evaluation_enabled` | **`false`** |
| Offerr row counts | **0 / 0 / 0** |

The verifier was run as **sections 1–8 and 10 only**. Section 9
("behavioural probes") is deliberately skipped in production: it `COMMIT`s real
rows into the Offerr tables before deleting them, which would violate the
zero-synthetic-record requirement. Those 11 probes remain verified on the
preview branch (47/47 there). 36 + 11 = 47.

Privilege checks deliberately use `has_table_privilege()` /
`has_function_privilege()` / `aclexplode()` rather than
`information_schema.role_table_grants`. That view only reports grants involving
*currently enabled* roles, so an "is empty" assertion can pass vacuously for a
session that is not a member of `anon`/`authenticated`. The catalog functions
are membership-independent.

#### Residual drift — pre-existing, out of scope

The drift checker returns **2 failures both before and after** this rollout —
byte-identical, confirming the rollout neither caused nor changed them:

1. `schema_contract_version_mismatch` — `public.comp_intelligence_schema_contract`
   is absent. That marker table is created only by
   `offerr-staging-bootstrap.sql`, which **must not** be applied to production
   (production already holds the canonical comp infrastructure).
2. `grant_posture_mismatch` — `anon` holds INSERT/UPDATE/DELETE/TRUNCATE on
   `buyer_comp_raw_v2` and `buyer_entities_v2` (and `properties`).

**Assessment of (2):** RLS is enabled on all three tables with **SELECT-only**
permissive policies, so `anon` INSERT/UPDATE/DELETE are denied at the row-security
layer today. `TRUNCATE` is *not* subject to RLS, but `anon` is `NOLOGIN` and
PostgREST exposes no TRUNCATE verb, so there is no known reachable path. This is
a **defense-in-depth gap, not an active exposure** — and it is pre-existing and
unrelated to Offerr.

Because repairing (2) and bootstrapping (1) are both explicitly out of scope for
this task, a literal `COMPATIBLE` verdict was **not achievable**. The gate that
*was* met: **all four Offerr-owned drift failures resolved to zero** and no new
failure was introduced. Item (2) should be scheduled as a separate authorized
task.

### 14.5 Deployment and disabled-route smoke test

| Field | Value |
|---|---|
| Vercel project | `real-estate-automation/api` (`prj_A9B8eQB3NKN9lm4KQFN4KAreitgN`) |
| Deployment ID | `dpl_Fo1GnQTQRxKXFHbwt8VW8itZY15t` |
| Production URL | `https://api-nnje8l3hz-real-estate-automation.vercel.app` |
| Canonical aliases | `api-real-estate-automation.vercel.app`, `api-steel-three-96.vercel.app` |
| Target / status | production / **Ready** |
| Deployed source | working tree byte-identical to `6a0fd934` (CLI deploy carries no git metadata) |

No new Vercel project was created, no preview Supabase credentials were used, no
production secret was modified, and no new public route or seller-facing domain
was attached.

| Request | Expected | Actual |
|---|---|---|
| No auth header | 401 | **401** `missing_internal_api_secret_token` |
| Wrong secret | 401 | **401** `invalid_internal_api_secret_token` |
| Valid auth + valid intake | 423 | **423** `system_control_disabled`, `flag_key: offerr_evaluation_enabled` |
| Valid auth + malformed body | 423 | **423** (see note) |
| Valid auth + `{}` | 423 | **423** |

**Note — intentional fail-closed ordering.** The flag gate precedes both the
`content-length` check and body parsing, so an authenticated malformed or
oversized body returns 423 rather than 400/413 while the feature is disabled.
This ordering is deliberate and was **not** changed. The flag was **not** enabled
to observe 400/413 in production.

This smoke test also proves database wiring without exposing any credential: the
`offerr_evaluation_enabled` row exists **only** in production and was created
minutes earlier by this migration, so a canonical 423 naming that flag key can
only be produced by an API reading production Supabase `lcppdrmrdfblstpcbgpf`.

### 14.6 Side-effect reconciliation (measured)

Identical aggregate snapshot script run before and after.

| Metric | Before | After |
|---|---|---|
| `offerr_evaluation_requests` | ABSENT | **0** |
| `offerr_evaluations` | ABSENT | **0** |
| `offerr_evaluation_events` | ABSENT | **0** |
| `offerr_touch_updated_at` ACL | ABSENT | `{postgres=X/postgres}` |
| `public_tables` | 157 | 160 (+3 Offerr) |
| `public_functions` | 875 | 876 (+1 trigger fn) |
| `public_policies` | 112 | 115 (+3 Offerr) |
| `system_control_rows` | 73 | 74 (+1 flag) |
| `offerr_evaluation_enabled` | NO_ROW | **`false`** |
| `properties` | 124048 | **124048** |
| `property_acquisition_scores` | 140 | **140** |
| `property_cash_offer_snapshots` | 0 | **0** |
| `buyer_comp_raw_v2` | 47985 | **47985** |
| `buyer_entities_v2` | 26390 | **26390** |
| `acquisition_opportunities` | 746 | **746** |
| `acquisition_opportunity_history` | 239 | **239** |
| `campaigns` / `campaign_targets` / `campaign_runs` | 31 / 2119 / 23709 | **31 / 2119 / 23709** |
| `message_events` | 12676 | **12676** |
| `sms_campaigns` | 0 | **0** |
| `universal_lead_command_cache` | 0 | **0** |
| `universal_lead_state_events` | 4570 | **4570** |
| `seller_heat_scores` | 0 | **0** |
| `public_views` | 80 | **80** |
| `migration_history_rows` | 195 | **195** |

No seller evaluation, range, message, campaign, offer, contract, title record,
LeadCommand lifecycle record, or Exchange publication was created. No synthetic
fixture row was inserted.

### 14.7 Preview infrastructure cleanup

- Preview branch `offerr-evaluation-spine-pr-57` (`ktvjkokwcqcgapzztkwu`)
  **deleted** 2026-07-31, immediately after the merge and production
  verification. Confirmed absent from `supabase branches list`. Hourly cost
  ended.
- The production project `lcppdrmrdfblstpcbgpf` was not touched by the deletion.
- Supersedes §13.16, which cited a stale branch identifier.
- **Observation (unrelated, not actioned):** an older preview branch
  `acquisition-engine-validation` (`skpmxvjwhpwkwutlowls`, created 2026-06-13)
  still exists and is still accruing cost. Out of scope here.

### 14.8 Remaining activation prerequisites

**Production installation is not launch.** Offerr must remain unavailable to
sellers until a separate activation phase completes:

- public intake UI wiring
- seller abuse protection
- seller authentication / session model
- rate limiting
- production address and evaluation observability
- approved disclaimers
- production acquisition V3 rollout decision for Offerr traffic
- internal-review workflow
- LeadCommand handoff
- operational monitoring
- controlled canary
- rollback plan

### 14.9 Known correctness risks that block activation

> **STATUS: all resolved on `fix/offerr-activation-safety-hardening` — see
> §15.** §15.1 also corrects the count: the true number of open, actionable
> findings was **eleven**, not five. The five below are the ones that land in
> runtime domain code; §14.9 did not enumerate the verification-tooling and
> test-setup findings from the same review. The list below is retained as the
> historical record.

Five review findings land in code that is **unreachable while the flag is
false**, so none blocks this installation — but each must be resolved before
`offerr_evaluation_enabled` is flipped:

1. **`offerr-property-resolution.js`** — the candidate query applies
   `LIMIT 25` with **no `ORDER BY`**. Truncation is nondeterministic, so the
   `AMBIGUOUS` guard can miss a second match and the resolver can return
   `RESOLVED` for the **wrong subject property**. Highest-severity item.
2. **`offerr-address-normalization.js`** — for comma-less input, a five-digit
   **house number** is consumed as a ZIP, so `"12345 Main St"` fails with
   `missing_street_number`.
3. **`offerr-evaluation-service.js`** — the deadline is advisory; no
   `AbortSignal`/per-call timeout reaches the loaders, so a hung dependency runs
   to the 60 s route limit instead of returning `evaluation_timeout`.
4. **`offerr-evaluation-service.js`** — subject hydration and the engine call
   lack the failure-code boundary the other stages have, so transient errors
   surface as HTTP 500 rather than a structured retryable code.
5. **`offerr-evaluation-store.js`** — the compensating `delete()` result is
   unchecked; a failed delete permanently poisons the idempotency key and makes
   the documented retry advice wrong.

Additionally, `offerr-hosted-privilege-contract.test.mjs` asserts grant absence
via `information_schema.role_table_grants`, which can pass vacuously. The
production proof in §14.4 does not rely on it, but the test should be moved to
`has_table_privilege()`/`aclexplode()`.

### 14.10 Final production state

| Item | Value |
|---|---|
| `offerr_evaluation_enabled` | **`false`** (unchanged since seed) |
| Other autonomous/execution flags | **not modified** |
| Offerr tables | present, **empty** |
| Production route | reachable, **fails closed** (401 / 423) |
| Offerr availability to sellers | **none** |

---

## 15. Activation-safety hardening (2026-07-31)

**Branch:** `fix/offerr-activation-safety-hardening` (from `origin/main`)
**Scope:** close every documented activation blocker. **Offerr was not
enabled, the public UI was not connected, and no production data or schema was
touched.**

### 15.1 Authoritative activation-blocker list

The authoritative sources are §14.9 of this report, the Offerr spine document,
and the **11 open review threads on PR [#57]**. PR [#59] carries **zero** review
threads — CodeRabbit's run on it reports *"Review failed — the pull request is
closed"*, so it contributes no findings.

§14.9 stated "**five** review findings". The true count of open, actionable
findings is **eleven**: §14.9 enumerated only the five that land in *runtime
domain code*, plus a sixth noted in prose (the `information_schema` privilege
assertion). It did not enumerate the five that land in *verification tooling*
and *test setup*. The table below is the complete list; the discrepancy is one
of scope, not of contradiction.

| # | Blocker | Code path | Seller / operational consequence | Reachable with flag false? | Fix | Regression proof |
|---|---|---|---|---|---|---|
| 1 | Candidate query truncates at 25 with **no `ORDER BY`** | `offerr-property-resolution.js` | **Seller-facing property-identity defect.** A duplicate parcel, second unit or conflicting ZIP outside the window is invisible; the resolver returns `RESOLVED` for the **wrong subject** and the whole evaluation proceeds on it | No | Deterministic ordering + exact count + bounded pagination + fail-closed incompleteness | `offerr-candidate-completeness.test.mjs` (24 cases) |
| 2 | Five-digit **house number** consumed as a ZIP in comma-less input | `offerr-address-normalization.js` | `"12345 Main St"` → `missing_street_number` → `INVALID_INPUT` for a valid address; canonical rows parse through the same function, so those rows fail too | No | ZIP scan floor `minIndex` protects the leading street number | `offerr-property-resolution.test.mjs` (2 new cases) |
| 3 | Deadline is **advisory** — no awaited stage is bounded | `offerr-evaluation-service.js` | A hung dependency runs to the route's 60 s `maxDuration` instead of returning `evaluation_timeout` at 15 s; the caller waits 4× the budget | No | `withDeadline()` races every read-only stage against the remaining budget | `offerr-activation-hardening.test.mjs` (5 cases) |
| 4 | Subject hydration and the engine call lack a failure-code boundary | `offerr-evaluation-service.js` | Transient Supabase faults and engine throws surface as HTTP 500 + Sentry noise instead of structured, correctly-classified codes | No | `subject_hydration_error` (503) and `decision_engine_error` (500) | `offerr-activation-hardening.test.mjs` (4 cases) |
| 5 | Compensating `delete()` result unchecked | `offerr-evaluation-store.js` | A failed delete leaves an orphan request row; every retry then reads `offerr_incomplete_snapshot` → 503, which the route documents as **transient**. The state is permanent, so the retry advice is wrong and the key is consumed forever | No | `offerr_evaluation_write_orphaned` → `offerr_persistence_orphaned` (500), logged with the orphan row id | `offerr-activation-hardening.test.mjs` (3 cases) |
| 6 | Table-grant assertions read `information_schema.role_table_grants` | `offerr-hosted-privilege-contract.test.mjs` | The view reports only grants involving **currently enabled** roles, so an "is empty" assertion **passes vacuously** for a session that is not a member of `anon`/`authenticated` — a privilege leak could ship unnoticed | n/a (test) | Rewritten on `has_table_privilege()` / `aclexplode()`; positive `service_role` grant assertion added | 4 DB-backed cases, all green |
| 7 | Preview-branch guard accepts unproven `is_default` | `offerr-preview-branch-guard.mjs` | `is_default === true` fails **open**: a missing, renamed or string-serialised field lets verification write to the parent project's **default (production) branch** | n/a (tooling) | Require explicit boolean `false`; new `unproven_branch_identity` refusal | `offerr-staging-guard.test.mjs` (6 variants) |
| 8 | TLS verification disabled on the Supabase pool | `offerr-preview-https-verify.mjs` | `rejectUnauthorized: false` accepts any certificate while database credentials cross the public internet | n/a (tooling) | Verified TLS by default, optional CA path, loud explicit opt-out only | Reviewed; no automated case (script has no harness) |
| 9 | `public.properties` keeps inherited `anon`/`authenticated` DML in staging | `offerr-staging-bootstrap.sql` | The **subject** table is anon-writable in staging, weakening the side-effect proof for the very record under evaluation | n/a (staging) | `REVOKE ALL ON public.properties`; `properties` added to the drift checker | Drift check **COMPATIBLE** on a bootstrapped database |
| 10 | Route tests assumed `INTERNAL_API_SECRET` was unset | `offerr-evaluations-route.test.mjs` | Claimed the 401 assertions could not run | n/a (test) | **FALSE POSITIVE** — see §15.5 | Precondition now asserted directly |
| 11 | Both documents needed Pass-4 synchronisation | `docs/offerr/*` | Documentation drift | n/a (docs) | Closed by §14 (previous PR) and this §15 | — |

### 15.2 Root cause and the executed proof

The resolver's `RESOLVED` is a **uniqueness claim**. Every identity-relevant
discriminator — suffix, directionals, unit, duplicate parcels, geography — is
applied in JavaScript **after** the rows arrive, so the DB-side filter is a
deliberate superset. Truncating that superset without an order, and without
knowing it was truncated, removes the evidence the uniqueness claim rests on.
The `AMBIGUOUS` guard counts only rows it received, so it cannot fire on a
conflict it never saw.

Differential proof, identical fixture (26 candidates, the conflicting duplicate
parcel at row 26) and identical database model:

| Implementation | Rows seen | Ordered | Queries | Result |
|---|---|---|---|---|
| Pre-fix (`6a0fd934`) | 25 of 26 | **no** | 1 | `RESOLVED` → `true-match` — **wrong subject** |
| Hardened (this branch) | 26 of 26 | **yes** | 1 | `AMBIGUOUS` / `multiple_structured_matches` |

Determinism: 100 consecutive resolutions over rotated hostile natural orders
produced a byte-identical result; 12 randomized orders over a 50-row candidate
set collapsed to exactly one distinct outcome.

Query strategy, ordering keys, bounds, incompleteness reason codes and the new
internal diagnostics are documented in
`docs/offerr/offerr-evaluation-spine.md` §3 ("Candidate-set completeness").

### 15.3 Regression matrix

| Area | Cases | File |
|---|---|---|
| Truncation, ordering, pagination, bounds, privacy | 24 | `offerr-candidate-completeness.test.mjs` (new) |
| Timeouts, failure boundaries, orphan compensation, route-gate ordering | 15 | `offerr-activation-hardening.test.mjs` (new) |
| Five-digit house number, end-to-end resolution | +2 | `offerr-property-resolution.test.mjs` |
| Unproven preview-branch identity | +1 (6 variants) | `offerr-staging-guard.test.mjs` |
| Catalog-based privilege contract | 4 | `offerr-hosted-privilege-contract.test.mjs` |

The completeness suite drives a **behavioural PostgREST model**, not a stub of
the resolver's expectations: real ILIKE wildcard semantics, multi-key ORDER BY
with explicit NULLS placement, inclusive `.range()`, exact counts that ignore
the range, and a deliberately hostile natural order whenever no ORDER BY is
supplied. The same code path was then re-run against **real PostgreSQL 17.10**
through `offerr-pg-rest-adapter.mjs`, which now emits genuine
`ORDER BY … NULLS …`, `LIMIT/OFFSET` and `COUNT(*)` SQL.

### 15.4 Route disabled-ordering decision — **keep the current order**

Reviewed as required; **deliberately not changed**. With Offerr disabled the
order is auth → flag → size → parse, so an authenticated malformed or oversized
body receives the canonical **423**, not 400/413.

- **Repository convention.** `buildDisabledResponse` + a 423 flag gate ahead of
  body handling is the shared `system_control` pattern; Offerr matches it.
- **Exposure and cost.** Parsing before the flag gate would make a disabled
  feature deserialize untrusted input — strictly more attack surface and CPU
  for zero benefit. The current order is the fail-closed one.
- **Size enforcement before the flag.** Rejected. It would leak a probing
  signal (413 vs 423 discriminates payload size while the feature is off) and
  the flag gate already short-circuits before the body is read at all.
- **Abuse / observability risk.** Low: the route is internal-secret protected,
  so an unauthenticated caller never reaches the flag gate.

Now pinned by test rather than left implicit: with the flag **false** the body
is never read (`bodyReads === 0`) and both malformed and oversized requests
return 423; with the flag **true** the 413 and 400 paths do run, in order.

### 15.5 Finding proven a false positive

**#10 — "Set `INTERNAL_API_SECRET=train` before running internal-secret route
tests."** Disproven by authoritative code tracing plus an executable assertion:

1. `apps/api/package.json` → `test:critical` already exports
   `INTERNAL_API_SECRET=test`, which is what the route tests send.
2. `getSharedSecretAuthResult` fails **open** outside production when the
   secret is unset (`{ ok: true, reason: 'internal_api_secret_not_configured' }`).
   An unset secret would therefore make the existing 401 assertions **fail
   loudly**, not pass vacuously — the opposite of the claim.

No production code was added to satisfy this finding. The precondition is now
asserted directly in `offerr-activation-hardening.test.mjs`.

### 15.6 Verification results

Isolated ephemeral **PostgreSQL 17.10** container (production is 17.6); no
production connection was opened at any point.

| Gate | Result |
|---|---|
| Offerr critical suites (no DB) | **166 tests — 163 pass, 0 fail, 3 skip** (DB-backed suites skip) |
| Offerr critical suites (with DB) | **194 tests — 194 pass, 0 fail, 0 skip** |
| Property-resolution suite | **26 tests, all pass** |
| Candidate-completeness suite (new) | **24 tests, all pass** |
| Activation-hardening suite (new) | **15 tests, all pass** |
| Hosted privilege contract | **4 sub-tests, all pass** (catalog-based) |
| Real-path E2E, isolated DB | **291 assertions passed, 0 failed** |
| Schema verification | **47/47 PASS** |
| Schema drift check | **COMPATIBLE** |
| Acquisition + comp regressions | **790 tests — 788 pass, 2 fail** (both pre-existing, see below) |
| **Full critical suite** | **4611 tests — 4518 pass, 88 fail, 0 cancelled, 5 skip** (34m31s) |
| Lint (`lint-critical.mjs`) | **PASS — 1495 files** |

**Full critical suite — completed, not a partial result.** 88 failures against
the repository's documented chronic main baseline of ~86. **Zero of them are in
any Offerr file, and zero are in any of the 18 files this branch touches.** The
88 land in 31 unrelated suites (queue, inbox, campaigns, Podio sync, messaging,
classifier). Re-running those same 31 files on an `origin/main` worktree
reproduces the same failures, confirming they are pre-existing rather than
introduced here.

Caveat recorded honestly: a scheduled agent was active in this repository
during the run (it committed `63410210` to the checked-out branch mid-task), so
the machine was **not** contention-free. That inflates load-sensitive
assertions such as `p95 pure compute under 15ms`, which passes in isolation.
The Offerr-specific gates above were all run separately and are unaffected.

Baseline comparison for the two acquisition failures, run on an `origin/main`
worktree with the identical command:

- `v3 collection spec present and empty of predictions` — **fails identically
  on `origin/main`**. Pre-existing, unrelated to this branch.
- `p95 pure compute under 15ms on fixture loop` — **passes on both** when run
  in isolation; it only failed while the E2E container and other suites were
  competing for the machine. Load-sensitive perf assertion, not a regression.

The 12-case real-path matrix is unchanged from §12.9/§13.14, including
`C05_AMBIGUOUS_DUPLICATE`, `C06_MISSING_UNIT` and `C07_CONFLICTING_ZIP`, all
still failing closed. Fixtures were cleaned up and
`offerr_evaluation_enabled` was returned to `false` in the throwaway database.

### 15.7 Production safety

| Assertion | Status |
|---|---|
| `offerr_evaluation_enabled` in production | **`false`** — never read, never written by this task |
| Production schema | **unchanged** — no migration applied, no DDL issued |
| Production data | **unchanged** — no production connection opened |
| Production Offerr tables | **empty** (0 / 0 / 0), unchanged |
| Shared production comp grants | **not modified** |
| `queue_execution_mode` / operator controls | **not touched** |
| Acquisition V3 production flags | **not modified** |
| Supabase preview branch | **none created** — an ephemeral local container was used, and removed afterwards |
| Vercel deployment | **none** |

The drift checker's grant-posture query now also covers `public.properties`.
This is a **reporting** change only: production is known to grant `anon` DML on
that table (§14.4 item 2), so the pre-existing production drift count moves
from 2 to 3 failures. No grant was changed. Repairing that posture remains a
separate authorized task.

### 15.8 Remaining activation risks

- The candidate filter is still a broad superset. An address whose first
  street-name token is also a common city name can exceed `max_candidates` and
  fail closed to `AMBIGUOUS`. Correct, but a review outcome rather than a
  resolution; narrowing the filter without risking false exclusion is future
  work.
- `withDeadline` bounds Offerr's **wait**, not the underlying request: the
  canonical acquisition loaders accept no `AbortSignal`, and threading one
  through them would mean changing shared acquisition infrastructure. A timed-out
  loader may still complete in the background.
- Canonical address components remain parser-derived from free text (§3).
- Hosted PostgREST behaviour for `count=exact` + `range` on the **production**
  `properties` table is verified against a faithful adapter and a real
  PostgreSQL 17.10, **not** against hosted Supabase. Worth re-confirming on a
  preview branch before activation.
- The candidate query uses `ILIKE`, which cannot use the plain btree index on
  `property_address_full`. This is unchanged from the merged implementation,
  but the added exact count means one extra aggregate per resolution. Index
  strategy should be reviewed before seller traffic.
- Item 2 of §14.4 (`anon` DML on the comp corpus and `properties`) is still
  open and now reported by the drift checker.

### 15.9 Remaining public-launch prerequisites

Unchanged from §14.8 and **not addressed by this task**: public intake UI
wiring, seller abuse protection, seller authentication / session model, rate
limiting, production address and evaluation observability, approved
disclaimers, the production acquisition V3 rollout decision for Offerr traffic,
internal-review workflow, LeadCommand handoff, operational monitoring, a
controlled canary, and a rollback plan.

**Closing the activation blockers does not activate Offerr.** The feature flag
remains `false`, the production Offerr tables remain empty, and Offerr remains
unavailable to sellers.
