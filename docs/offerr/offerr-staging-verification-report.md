# Offerr Evaluation Spine — Staging Verification Report

**Date:** 2026-07-30
**Branch:** `feat/offerr-ai-evaluation-spine`
**PR:** [#57](https://github.com/kindleops/rei-automation/pull/57) — **draft, not merged**
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
