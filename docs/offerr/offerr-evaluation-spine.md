# Offerr Evaluation Spine — Internal Vertical Slice

**Date:** 2026-07-29 (hardening pass same day); staging-verification pass 2026-07-30; **production landing 2026-07-31**
**Status:** Merged (`6a0fd934`) and **installed in production** (`lcppdrmrdfblstpcbgpf`) with the feature flag **OFF**. Schema applied additively; all three Offerr tables empty; merged API deployed and failing closed. **Installed ≠ launched** — Offerr is not reachable by sellers.
**Scope:** Internal-only evaluation spine — no seller communication, no contracts, no marketplace behavior
**Repository:** `kindleops/rei-automation`
**Safety posture:** The only production mutation is additive schema plus a
default-disabled `system_control` flag row. **No production seller or property
data was read into, written from, or created by this rollout**; every execution
table (properties, comps, acquisition scores, campaigns, messages, LeadCommand,
Exchange) is unchanged, verified by before/after aggregate snapshot. No seller
evaluation or range has ever been generated in production.
**Verification report:** [`offerr-staging-verification-report.md`](./offerr-staging-verification-report.md)

---

## 1. Boundary

Offerr is the private direct-to-seller acquisition channel:

> Offerr receives inbound seller intent
> → evaluates the property
> → generates the appropriate next step
> → routes the seller and property into the internal acquisition system
> → LeadCommand manages continuing execution.

**Reivesti Intelligence powers the analysis** (the canonical comp-intelligence
and acquisition decision engine in this repository). **Offerr remains a
private direct-acquisition channel.** No Offerr submission is automatically
published to Reivesti Exchange or any member-facing marketplace, and the
spine has no code path that references Reivesti Exchange infrastructure
(executable proof: `offerr-side-effect-proof.test.mjs`).

This slice never produces a binding offer, never contacts a seller, never
creates a contract, and never routes title. Every result is preliminary and
non-binding by construction.

## 2. Request lifecycle

`POST /api/internal/offerr/evaluations` → `evaluateOfferrProperty(input, deps)`:

| Stage | Module | Fail-closed behavior |
|---|---|---|
| 1. Validate + normalize intake | `offerr-contracts.js` | 400 `invalid_offerr_intake` |
| 2. Idempotent replay lookup | `offerr-evaluation-store.js` | 503 store unreachable; 503 `offerr_incomplete_snapshot` when a request row's snapshot is not yet committed (retryable); 409 key reuse with different payload |
| 3. Deterministic address resolution | `offerr-property-resolution.js` | AMBIGUOUS / NOT_FOUND / INVALID_INPUT → review, no range |
| 4. Canonical subject hydration | `loadSubjectProperty` (engine) | hydration miss → AMBIGUOUS |
| 5. Asset classification + seller-fact overlay | `classifyAssetLane` + `detectNonResidentialSignal` + `detectOverlayConflicts` | unsupported family, non-residential signal, or sub-floor classification confidence → UNSUPPORTED |
| 6. Comp + buyer + decision paths | engine loaders + `calculateAcquisitionDecision` | loader error → structured failure |
| 7. Offerr safety gates | `offerr-safety-gates.js` | any uncertainty → review, no range |
| 8. Immutable snapshot persistence | `offerr-evaluation-store.js` | persistence failure → compensating delete + no range returned |
| 9. Seller-safe projection | `offerr-seller-projection.js` | malformed range → null range |

Every stage is timed independently; timings land in structured logs and the
persisted provenance. The orchestrator enforces a 15 s internal deadline
(`evaluation_timeout`, fail closed).

## 3. Property-resolution strategy

The repo is `property_id`-first; the only pre-existing address path is fuzzy
ranked search. Offerr owns a deterministic resolver built from two modules:

- **`offerr-address-normalization.js`** — pure, deterministic parser that
  turns one address string into structured components: street number,
  pre/post directional, street name, suffix, unit, city, state, ZIP5/ZIP+4.
- **`offerr-property-resolution.js`** — parses both the seller input and the
  canonical `properties` candidates with the SAME parser (structured
  `property_address_city/state/zip` columns override parsed values) and
  applies strict rules. There is no fuzzy similarity score anywhere.

### Normalization rules (deterministic token maps)

- case, punctuation (`.` `,` `#`), and whitespace variation
- street suffixes: Street/St, Avenue/Ave, Road/Rd, Drive/Dr, Boulevard/Blvd,
  Lane/Ln, Court/Ct, Circle/Cir, Highway/Hwy, Parkway/Pkwy (+ Pl, Ter, Trl,
  Way, Loop, Cv, Sq)
- directionals: North/N … Southwest/SW, including glued forms (`123N Main`)
- full state names ↔ USPS abbreviations (50 states + DC)
- ZIP+4 ↔ five-digit ZIP (ZIP4 preserved on the parse)
- unit notation: Apt / Apartment / Unit / Ste / Suite / Lot / `#`
- commas optional; when present they are authoritative segment separators
- homograph guard: in comma-less input, trailing `Ct`/`NE`-style tokens are
  never claimed as states (court/quadrant vs Connecticut/Nebraska)
- "10 North St" parses as a street named North, not a directional

The original seller input is preserved verbatim on the intake record
(`raw_submitted_address`) for audit; logs carry only a sha256 prefix + ZIP.

### Resolution outcomes

| Status | Meaning |
|---|---|
| `RESOLVED` | Exactly one structured match (unit-exact when a unit was stated) |
| `AMBIGUOUS` | Multiple structured matches; missing unit where any unit-bearing candidate exists; stated unit not matched |
| `NOT_FOUND` | No trustworthy candidate: nothing matched, only partial street similarity, or every base match conflicted on stated city/state/ZIP |
| `INVALID_INPUT` | Unparseable input (no street number / street name) |

`UNSUPPORTED` is a request-level status derived later from the canonical
asset lane, not a resolver output.

Fail-closed guarantees (all executable-tested in
`offerr-property-resolution.test.mjs`): partial street similarity alone never
resolves; duplicate parcels never resolve; conflicting geography never
resolves; a missing unit with unit-bearing candidates never resolves; weak
similarity is never promoted to identity. Candidate metadata is retained on
the internal result only — the seller-safe projection never exposes candidate
rows, identifiers, or unresolved addresses.

**Known limitation:** canonical rows store addresses as strings, so canonical
components come from parsing `property_address_full` (structured city/state/
ZIP columns override *where they agree* — see "Canonical field conflicts"
below). A future provider adapter can supply pre-structured components through
the same parsed-component shape without touching the resolver rules.

### Candidate-set completeness (activation hardening, 2026-07-31)

`RESOLVED` asserts that **exactly one** canonical property matches the
submitted identity. That assertion is only defensible if the resolver has seen
**every** candidate the filter can produce.

The candidate query is a deliberate **superset** filter (street-number prefix
`ILIKE '<number> %'` AND street-name-token containment `ILIKE '%<token>%'`).
All identity-relevant discrimination — suffix, directionals, unit, duplicate
parcels, geography — happens in JavaScript **after** the rows arrive.

**The defect this replaces.** The original loader issued `.limit(25)` with
**no `ORDER BY`**. Postgres was free to return any 25 matching rows, in any
order, and to change that choice between two identical calls. A conflicting
candidate outside the window was invisible, and the `AMBIGUOUS` guard — which
counts only the rows it received — could not fire. The resolver returned a
confident `RESOLVED` for a property that was **not uniquely identified**.
Executed differential proof, identical fixture and identical database model:

| Implementation | Rows seen | Ordered | Result |
|---|---|---|---|
| Pre-fix (`6a0fd934`) | 25 of 26 | **no** | `RESOLVED` → `true-match` (**wrong subject**) |
| Hardened (this branch) | 26 of 26 | yes | `AMBIGUOUS` / `multiple_structured_matches` |

#### Deterministic ordering

Every candidate query orders by, in sequence:

`property_address_full` → `property_address_city` → `property_address_state` →
`property_address_zip` → `property_id` → **`property_export_id`**

`property_id` carries a UNIQUE index (`uq_properties_property_id`) and
`property_export_id` is the canonical **PRIMARY KEY**, so the final key
guarantees a *total* order and the page boundary is reproducible. Natural
database order is never relied upon. Ordering version:
`offerr_candidate_order_v1`.

#### Single-statement, exactly-counted retrieval

The bounded candidate set is read in **one** request asking for
`max_candidates + 1` rows with `{ count: 'exact' }`. PostgREST reports the total
matching rows ignoring the range, so the resolver knows how many rows **exist**,
not merely how many it received.

One request is one SQL statement, and `count=exact` is computed inside that same
statement, so rows and count are read from **one MVCC snapshot**.

This replaced multi-request pagination, which could not prove membership
stability. Comparing the exact count on every page detects *some* interference,
but count equality is not set equality: a writer that deletes one row before the
cursor and inserts another after it leaves the count untouched while shifting
every unread row one position left, so the row on the page boundary is silently
skipped — no count change, no duplicate, no guard fires. When that row was the
duplicate parcel, the resolver answered `RESOLVED` for a property it had not
uniquely identified. With a single statement there is no second read for a
writer to interleave with, so the interference is *unrepresentable* rather than
merely detectable.

#### Bounds (explicit and documented)

| Bound | Value | Purpose |
|---|---|---|
| `page_size` | 100 | retained row-budget unit |
| `max_pages` | 5 | retained row-budget multiplier |
| `max_candidates` | 500 | `page_size × max_pages`, asserted at module load |
| `deadline_ms` | 5 000 | wall-clock ceiling on candidate loading |
| `max_address_length` | 240 | refused **before** any database work |

`page_size` and `max_pages` no longer describe round trips — they describe the
same total row budget they always did, and their product **is** the bound
enforced. The identity is asserted at module load so the documented budget and
the enforced budget cannot silently diverge.

A total count above `max_candidates` fails closed from that same single
response. Street-name tokens are **truncated at the first character outside
`[a-z0-9-]`** before interpolation, so a `%`, `_` or `*` in seller input cannot
widen the `ILIKE` into a table-wide scan (PostgREST exposes no `ESCAPE` clause).
Truncating rather than deleting matters for correctness: the fragment is matched
against the raw canonical address, so deleting an apostrophe or an accent
produced a fragment that was not a substring of the canonical text at all and
the row could never be retrieved — `O'Connor`, `Cañada` and `Peña` all resolved
to `NOT_FOUND` for perfectly legitimate addresses.

#### Incompleteness always fails closed to `AMBIGUOUS`

Completeness is checked **before** any matching runs, so a single apparent
winner inside an unprovable set is never even evaluated.

| Reason code | Trigger |
|---|---|
| `candidate_count_unavailable` | no exact count returned |
| `candidate_set_exceeds_safe_bound` | total count above `max_candidates` |
| `candidate_set_truncated` | the payload disagrees with its own exact count (server row cap or truncating client) |
| `candidate_pagination_inconsistent` | a row appeared twice in one payload |
| `candidate_pagination_failed` | *retained, unreachable from the default loader* — described a page after the first erroring |
| `candidate_set_changed_during_pagination` | *retained, unreachable from the default loader* — described the count moving between reads |
| `candidate_load_deadline_exceeded` | candidate loading outran its deadline |

`candidate_pagination_failed` and `candidate_set_changed_during_pagination`
describe interference *between* two reads. A single-statement read has no
"between", so the default loader can no longer produce them; they are retained
because the envelope is a public contract that
injected loaders and stored diagnostics may still carry, and because removing a
fail-closed reason code is not a safe way to signal that a failure mode was
eliminated.

A candidate query error is different in kind: the canonical source is
unreachable, which is a dependency fault rather than an identity ambiguity. It
throws `offerr_property_lookup_failed` → `property_resolution_error` so it is
retried and alerted on, instead of telling a seller to confirm their address.

#### Canonical field conflicts

Structured columns take precedence over the parsed free-text address only where
they **agree**. When both sides state a value and disagree (e.g.
`property_address_full` says ZIP 77035 while `property_address_zip` says
77099) the row is self-inconsistent: it can never win, and its presence among
the base matches returns `AMBIGUOUS` / `canonical_field_conflict:<part>`.
Conflicting canonical fields are never silently reconciled.

#### Internal diagnostics

`resolution.diagnostics` records `candidate_count`, `total_count`,
`total_count_known`, `truncated`, `complete`, `pages_loaded`, `page_size`,
`matching_candidate_count`, `conflicting_candidate_count`,
`resolution_method`, `ordering_version`, `ordering_keys`, `reason_code`, and
the active `bounds`. It lives on the internal result only. The seller-safe
projection allowlists its fields one by one, so none of this can reach a
seller — asserted directly in `offerr-candidate-completeness.test.mjs`.

Resolution method identifier: `properties_structured_match_v3`.

## 4. Canonical components reused (no duplication)

| Capability | Canonical component |
|---|---|
| Pure decision | `calculateAcquisitionDecision` — same read-only invocation pattern as `comp-intelligence-v3-projection.js`; the persisting score path is never invoked |
| Subject hydration | `loadSubjectProperty` (canonical `properties` read + enrichments) |
| Comp evidence | `loadComparableProperties`, `loadBuyerPurchases`, `loadV3CompCandidates` (RPC `get_comp_candidates_for_subject`) |
| Contamination defense | `qualifyComps` / `transactionClustering` (packages collapse to one economic transaction) |
| Numeric invariants | `assertAcquisitionInvariants` |
| Vocabulary | `EXECUTION_STATES`, `VALUE_CLASSIFICATION`, `LANE_FAMILY`, `ENGINE_VERSION`/`FORMULA_VERSION` |
| Route conventions | `requireSharedSecretAuth`, `child()` logger, `captureRouteException`, `system_control` flag + canonical 423 envelope |
| Fact-claim conventions | claim envelopes modeled on `extract-seller-facts.js` |

## 5. Internal vs seller-safe contracts

Seller-safe projection (explicit allowlist, leak-tripwire tested):
`evaluation_id`, `spine_version`, `outcome`, `property` (address/city/state/
zip/type of the RESOLVED match only), `preliminary_range` (`{low, high, USD}`
or null), `confidence_label`, `next_step`, `assumptions`, `data_conflicts`,
`binding: false`, `preliminary: true`, `disclaimer`, `expires_at`,
`processing_ms`.

Never exposed: provider payloads, owner/contact enrichment, MAO formulas,
assignment-fee targets, buyer identities, raw comp data, candidate rows,
internal risk rules, private identifiers, execution states, service/debug
information. No preliminary range is ever described as guaranteed, final,
binding, approved, or contract-ready — the disclaimer states the opposite and
`binding`/`preliminary` are machine-readable.

Required seller distinctions and how they map:

| Seller situation | Contract surface |
|---|---|
| Eligible for a preliminary range | `outcome: INSTANT_RANGE_ELIGIBLE` + range |
| Conditionally eligible | `outcome: CONDITIONAL_RANGE` + range |
| Manual review required | `outcome: REVIEW_REQUIRED`, `next_step: internal_review` |
| Unsupported property/asset type | `outcome: UNSUPPORTED`, `next_step: not_serviceable_manual_follow_up` |
| Property identity confirmation required | `outcome: REVIEW_REQUIRED`, `next_step: confirm_property_address` / `confirm_property_identity` |
| Insufficient data | `outcome: REVIEW_REQUIRED` with depth/confidence reason codes (internal) |
| Evaluation unavailable | HTTP failure envelope (`offerr_evaluation_failed` + stable `failure_code`), never a seller rejection |

The internal result (`offerr_evaluations.internal_result` + `provenance`)
retains the full engine decision, gate checks, reason codes, comp-set hash,
and stage timings — service-role only.

## 6. Schema rationale and migration

`apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql`
(PROPOSED prefix = outside the `supabase db push` path; same convention as the
closing-desk foundation).

No existing table can hold Offerr records without semantic distortion:
`property_acquisition_scores` is `UNIQUE(property_id)` engine output with no
history; `property_cash_offer_snapshots` is a Podio-owned single-number offer
mirror that explicitly forbids ranges; `acquisition_opportunities` has
pipeline grain with no intake payload or idempotency;
`acquisition_events`-style ledgers cannot serve as queryable evaluation
records.

| Table | Grain | Notes |
|---|---|---|
| `offerr_evaluation_requests` | one intake | `UNIQUE(idempotency_key)`; unverified seller-fact overlay; future-handoff columns (`acquisition_opportunity_id`, `thread_key`, `master_owner_id`) |
| `offerr_evaluations` | one immutable snapshot per version | `UNIQUE(request_id, evaluation_version)`; FK to requests (no cascade — deletion of a request with snapshots is refused); INSERT/SELECT grants only |
| `offerr_evaluation_events` | append-only ledger | unique partial index on `dedupe_key` |

Service-role-only RLS (pattern of `acquisition_contacts`), `REVOKE` from
`anon`/`authenticated`, `system_control` seed `offerr_evaluation_enabled =
'false'`, `NOTIFY pgrst` at the end. Additive only; empty-deployment safe;
UI-independent; no destructive statements.

**Rollback** (documented in the migration header; repo has no down-migration
convention): set the flag false → drop `offerr_evaluation_events` →
`offerr_evaluations` → `offerr_evaluation_requests` → drop
`offerr_touch_updated_at()` → optionally delete the flag row. Nothing else in
the migration touches pre-existing schema.

There are no generated Supabase types in this repo (no `supabase gen types`
workflow exists), so no type regeneration applies.

## 7. Authentication, flag, idempotency

- **Auth:** `x-internal-api-secret` (or `Authorization: Bearer`) vs
  `INTERNAL_API_SECRET` via `requireSharedSecretAuth`, checked before the
  flag read and before any evaluation work (executable-tested ordering).
- **Flag:** `system_control['offerr_evaluation_enabled']`, read with
  `failClosedOnError: true`; absent/false → canonical
  `423 { ok:false, error:"system_control_disabled", flag_key, context }`.
- **Idempotency:** the `UNIQUE(idempotency_key)` constraint is the authority.
  One key is bound to one logical request: replay returns the stored
  evaluation deterministically; reuse with a different normalized address is
  a stable `409 idempotency_key_reused_with_different_payload`; concurrent
  same-key races settle on exactly one snapshot. The request+snapshot writes
  are not transactional, so a failed snapshot insert triggers a compensating
  delete of the request row, and a request row without its snapshot is
  answered with `503 offerr_incomplete_snapshot` — a partial snapshot is never
  presented as a completed evaluation. 503 rather than 500 because under
  concurrent same-key traffic the pre-flight replay lookup routinely observes
  the winner's request row before its snapshot commits, so retry is the correct
  client action and a routine race should not read as an unhandled fault.
  Proven against a real PostgreSQL 17 race: of six simultaneous same-key
  requests one returned 200 and five returned retryable 503s, with exactly one
  request row and exactly one snapshot persisted.

## 8. Observability and latency budget

Structured logs (`domain.offerr.evaluation`, `api.internal.offerr.evaluations`):
`offerr_evaluation.requested / .completed / .failed / .timeout` and
`offerr_evaluations.rejected / .failed` with stage durations (`validate_ms`,
`idempotency_ms`, `resolution_ms`, `subject_ms`, `overlay_ms`,
`comp_load_ms`, `engine_ms`, `gates_ms`, `persistence_ms`, `total_ms`),
outcome, reason codes, and model versions. Every route-level error envelope
and log line carries a `correlation_id` generated before validation;
evaluation logs carry `request_id`/`evaluation_id`. Addresses are logged only
as a sha256 prefix + ZIP; no seller contact PII exists anywhere in the spine.
Route exceptions go to Sentry via `captureRouteException`
(`route: internal/offerr/evaluations`, `subsystem: offerr`).

Measured fixture runs complete in well under one second; the future <15 s
product target is enforced by the internal deadline. No live-provider latency
claim is made — provider integration is deferred.

## 9. Safety invariants (all executable-tested)

- Unresolved / ambiguous / invalid-input / unsupported → no range.
- Insufficient qualified comps → conditional or review, never instant.
- Package/broadcast contamination (Caldwell regression) → review, no range.
- Single extreme comp (Austin duplex regression) → review, no range, never
  HIGH confidence.
- NaN / Infinity / negative / reversed engine output → hard failure; nothing
  persisted, nothing presented.
- Preliminary range ≤ canonical conservative acquisition ceiling and ≤ the
  independent qualified valuation anchor; floor ≤ ceiling.
- Source conflicts (asking price vs independent value, condition vs repair
  disclosure) downgrade eligibility.
- Seller facts remain unverified claims and never mutate canonical data.
- Side-effect proof through the REAL loaders against a recording client:
  writes touch only `offerr_*` tables; `send_queue`, `message_events`,
  `email_send_queue`, `follow_up_queue`, `contracts`, `offers`, `campaigns`,
  `property_acquisition_scores`, `property_cash_offer_snapshots`,
  `acquisition_opportunities`, LeadCommand tables are never touched, read or
  write; zero network requests.

## 10. Staging state and migration verification

### 10.1 No hosted staging project exists

**There is still no staging Supabase project for this repository** (re-audited
2026-07-30). The authenticated CLI lists exactly three projects:

| Ref | Name | Org | Region | Created | Verdict |
|---|---|---|---|---|---|
| `lcppdrmrdfblstpcbgpf` | real-estate-automation | REI Automation (`gosflvntwnxegkrulmoz`) | West US (Oregon) | 2026-04-18 | **PRODUCTION** — CLI-linked; named as prod in the V3 audit and the SMS launch checklist |
| `wwqqwllstapdolkndzzx` | ReivestiExchange | Luxer International (`ssxbuobppduwwahkxila`) | East US (Ohio) | 2025-09-16 | Different product — not valid staging |
| `lvocccmhnyfoyqnbmmci` | SignPro | Luxer International (`ssxbuobppduwwahkxila`) | East US (Ohio) | 2025-05-16 | Different product — not valid staging |

Creating `real-estate-automation-staging` is a billing/ownership decision and
was **not** performed. **Nothing was applied to any hosted project, and no
hosted project was read from or written to** beyond `projects list` /
`orgs list` metadata.

### 10.1b The base schema — recovered and source-controlled (2026-07-30)

Creating the Supabase project is **necessary but not sufficient**. Offerr's
runtime touches six database objects. Until 2026-07-30 five of them had no DDL
anywhere in this repository, so replaying the 120-migration tree against an
empty project would not have produced a schema the spine could run against.

All of them are now source-controlled under
`apps/api/supabase/contracts/offerr-comp-intelligence/`, recovered **read-only**
from production (`lcppdrmrdfblstpcbgpf`) via `pg_get_functiondef`,
`pg_get_viewdef` and `information_schema`:

| Object | Defined in repo? | Parity class |
|---|---|---|
| `public.system_control` | yes — `20260428_create_system_control.sql` | canonical shape |
| `public.properties` | **yes** — `canonical/010_properties.sql` | compatible reconstruction (117-of-343 columns = the full Offerr read surface) |
| `public.buyer_comp_raw_v2` | **yes** — `canonical/020_…sql` | exact column contract (167/167) |
| `public.buyer_entities_v2` | **yes** — `canonical/030_…sql` | exact column contract (49/49) |
| `public.v_recent_sold_comps` | **yes** — `canonical/040_…sql` | **exact production definition (verbatim)** |
| `get_comp_candidates_for_subject(...)` | **yes** — `canonical/050_…sql` | **exact production definition (verbatim)** |

`v_recent_sold_comps` was the missing link. The comp RPC does **not** read
`buyer_comp_raw_v2` directly — it reads this view, which is a projection over
that table filtered to `import_status IS DISTINCT FROM 'rejected'`. Because the
view passes `id` straight through, the RPC's `comp_id` *is*
`buyer_comp_raw_v2.id`, which is what makes `compCandidateLoader`'s
`.in('id', compIds)` identity join correct.

Parity is proven, not asserted: re-creating the function and the view in a fresh
PostgreSQL 17 database and reading the catalog back yields output
**byte-identical** to production, and all 333 reproduced columns match
production's type, nullability and default with zero mismatches.

`apps/api/scripts/offerr/offerr-staging-bootstrap.sql` is now a thin staging
wrapper that `\ir`-includes those canonical files — it contributes no comp DDL of
its own, so there is exactly one copy of each definition and staging cannot drift
from the recovered contract. On top of the canonical objects it adds only staging
concerns: a refuse-to-run guard (aborts if `properties`, `buyer_comp_raw_v2` or
`buyer_entities_v2` holds any non-`OFFERR-STAGING-TEST-` row), `system_control`
with every automation flag pinned `false` (the canonical migration seeds
`outbound_sms_enabled`/`feeder_enabled`/`queue_runner_enabled` to `true`, which
staging must never inherit), the service-role grant posture, a recorded
schema-contract version, and a post-bootstrap assertion that fails loudly on
signature or result-contract drift.

Validated end-to-end against disposable PostgreSQL 17.10: the database was
dropped and rebuilt **from source-controlled files alone**, bootstrap applies and
re-applies cleanly, refuses a populated database, the Offerr migration applies on
top, schema verification is **47/47**, the drift check reports **COMPATIBLE**,
20 RPC contract cases pass against real PostgreSQL, and the full E2E harness
scores **291/291 with no injected comps**.

> **The behavioural stand-in is gone.** Staging now executes the same comp SQL
> production executes. What remains unverified is not the SQL but the *data*:
> production comp density, duplicate rates and package frequency are not
> characterised by synthetic fixtures. See the contract README "Open
> production-parity risks".

Related: V3 feature flags are read from **env vars** by `readFeatureFlag`, not
from `system_control`, so V3 enablement in staging is a deployment env change
rather than a database flag change.

### 10.1c The real comp-retrieval path

Nothing about comps is injected anywhere in the verification harness. This is
what executes by default:

```
loadV3CompCandidates(subject, deps)                    compCandidateLoader.js
  ├─ (1) rpc get_comp_candidates_for_subject(          ← exact production SQL
  │        p_subject_property_id, p_radius_miles,
  │        p_months_back, p_limit: 100)
  │        └─ public.v_recent_sold_comps → public.buyer_comp_raw_v2
  ├─ (2) buyer_comp_raw_v2 .select(RAW_IDENTITY_SELECT).in('id', compIds)
  ├─ (3) buyer_entities_v2 .select(ENTITY_SELECT).in('normalized_buyer_name', …)
  └─ (4) normalizeCandidate → qualifyComps → clusterTransactions
           → buildV3Decision → applyOfferrSafetyGates
```

Exactly three queries, no N+1, and **no write on any of it** — the RPC is
declared `STABLE` and the whole path runs unchanged inside a `READ ONLY`
transaction.

Eligibility windows come from `compCandidateLoader.eligibilityWindow`: land
20mi/48mo, commercial 15mi/48mo, multifamily 7mi/36mo, residential 4mi/30mo.

**The comp RPC is a retrieval primitive, not a safety boundary.** Several
protections one might assume live in it do not: it does **not** reject zero or
negative prices (only `NULL` ones, via `is_usable_comp`) and does **not** reject
future-dated sales. Those are handled one layer down by
`transactionQualification` (`nominal_consideration`, lane ceiling, PPSF bounds,
anchor ratio) and `transactionClustering` (package/duplicate detection). The
full guarantee-to-layer map is in the contract README §3.

### 10.2 What was verified instead — ephemeral PostgreSQL 17

Because a hosted staging project was unavailable, the migration and the full
evaluation path were verified against a **disposable local PostgreSQL 17.10
container** (production runs PostgreSQL 17), with the Supabase role and
default-ACL environment reproduced so grants and RLS are meaningful:

- roles `anon`, `authenticated`, `service_role` (BYPASSRLS), `authenticator`
- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
  authenticated, service_role` — Supabase's own default, and the reason the
  migration's `REVOKE`s are load-bearing
- the prerequisite `public.system_control` table

This proves the DDL, constraints, indexes, RLS, grants, trigger, rollback, and
real-database idempotency/concurrency. It does **not** substitute for a hosted
staging project for PostgREST/API-gateway behaviour, Supabase Auth, or a
deployed preview URL — those remain open (§11).

### 10.3 Migration verification results

`apps/api/scripts/offerr/offerr-schema-verify.sql` — **47 checks, 47 PASS, 0 FAIL**:

- three `offerr_*` tables and exactly one `offerr_*` function; no extra views,
  sequences, or publication membership
- all timestamp columns `timestamptz`; all three PKs default `gen_random_uuid()`
- `UNIQUE(idempotency_key)`; `UNIQUE(request_id, evaluation_version)`
- `resolution_status` CHECK contains all five of RESOLVED / AMBIGUOUS /
  NOT_FOUND / INVALID_INPUT / UNSUPPORTED
- no FK cascades; **parent request delete is refused** while snapshots reference it
- all seven documented indexes, including the partial
  `uq_offerr_eval_events_dedupe_key ... WHERE dedupe_key IS NOT NULL`
  (duplicates rejected, multiple NULLs allowed)
- RLS enabled on all three tables, every policy scoped to `service_role` only
- `anon`, `authenticated`, and `PUBLIC` hold **zero** privileges
- the migration applies cleanly **twice** (fully additive / re-runnable)
- the documented rollback leaves **0 tables, 0 functions, 0 flag rows**
- `offerr_evaluation_enabled = 'false'` immediately after apply

**Defect found and fixed during verification.** Supabase seeds
`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO ... service_role`, so a
new public table arrives with `service_role` already holding `arwd`. The
migration's narrower `GRANT SELECT, INSERT` on `offerr_evaluations` and
`offerr_evaluation_events` is **additive and does not remove that surplus** —
so the "immutable snapshot" and "append-only ledger" guarantees were
convention-only, and the service-role key the Offerr API uses could have
UPDATEd or DELETEd a persisted evaluation. The migration now REVOKEs before
granting, and also drops PUBLIC's implicit EXECUTE on
`offerr_touch_updated_at()`. Verified post-fix grants:

```
service_role | offerr_evaluation_requests | DELETE, INSERT, SELECT, UPDATE
service_role | offerr_evaluations         | INSERT, SELECT
service_role | offerr_evaluation_events   | INSERT, SELECT
```

### 10.4 Exact operator instructions to stage the migration

> **Historical — superseded 2026-07-31.** The separate-staging-project route was
> never taken. Hosted verification used an **ephemeral Supabase preview branch**
> of the canonical project (`offerr-evaluation-spine-pr-57` /
> `ktvjkokwcqcgapzztkwu`, since deleted), and the migration has since been
> applied to **production** under operator authorization — see
> [report §14](./offerr-staging-verification-report.md#14-production-landing-2026-07-31).
> Step 4 below is also superseded in production: the verifier's section 9
> commits probe rows, so production runs sections 1–8 and 10 only.
> Retained for provenance.

1. **Create the staging project** (the outstanding operator action):
   name `real-estate-automation-staging`, org `REI Automation`
   (`gosflvntwnxegkrulmoz`), region West US (Oregon) to match production,
   smallest sufficient instance size, freshly generated DB password.
   `supabase projects create real-estate-automation-staging --org-id gosflvntwnxegkrulmoz --region us-west-1 --db-password <generated>`
   — confirm the cost of an additional project first.
2. **Verify identity before any write:** `supabase projects list`. The target
   ref must NOT be `lcppdrmrdfblstpcbgpf` and must be positively identifiable
   as staging.
3. **Apply** `PROPOSED_20260729120000_offerr_evaluation_spine.sql` in that
   project's SQL editor, or rename without the `PROPOSED_` prefix in a
   staging-only checkout and `supabase db push --project-ref <staging-ref>`.
   **Do not rename the file on this branch** — the local CLI link points at
   production.
4. **Verify** with `apps/api/scripts/offerr/offerr-schema-verify.sql`
   (run as the schema owner, not `service_role`).
5. **Exercise** with `apps/api/scripts/offerr/offerr-e2e-verify.mjs`, which
   refuses to run without `ALLOW_OFFERR_STAGING_FIXTURES=true` and refuses the
   production ref outright.
6. **Leave `offerr_evaluation_enabled = 'false'`.** Rollback per §6 if needed.

## 11. Launch state

> **Installed in production 2026-07-31 with the feature OFF.** PR #57 is merged
> (`6a0fd934`), the schema is applied to `lcppdrmrdfblstpcbgpf`, and the merged
> API is deployed. `offerr_evaluation_enabled = 'false'` and all three Offerr
> tables are empty. **Installation is not launch** — Offerr is not reachable by
> sellers. Full evidence:
> [`offerr-staging-verification-report.md` §14](./offerr-staging-verification-report.md#14-production-landing-2026-07-31).

| Area | State |
|---|---|
| Domain contracts, orchestrator, gates, projection, store | **Implemented** |
| Structured address resolution (suffix/directional/state/ZIP+4/unit) | **Implemented** |
| Fail-closed ambiguity, geography-conflict, unit rules | **Verified** (62 tests green) |
| Side-effect and privacy proofs | **Verified** (executable, real-loader path) |
| Idempotency incl. races, payload reuse, partial snapshots | **Verified against real PostgreSQL 17** |
| Migration DDL / constraints / indexes / RLS / grants / rollback | **Verified on PostgreSQL 17** (47/47 checks) |
| 12-case evaluation matrix, flag gating, reconciliation | **Verified** (291/291 assertions, real DB, real comp loader) |
| Hosted verification | **Done** — ephemeral Supabase preview branch, real HTTPS (172/172); branch since deleted |
| PR #57 | **Merged** 2026-07-31 → `6a0fd934` |
| Production schema application | **Done** — single transaction, 36/36 production checks (11 write-probe checks intentionally skipped) |
| Production privilege contract | **Verified** — anon/authenticated zero, evaluations/events append-only, helper fn owner-only |
| Production API deployment | **Done** — `dpl_Fo1GnQTQRxKXFHbwt8VW8itZY15t`, Offerr disabled |
| Production disabled-route behaviour | **Verified** — 401 unauthenticated, canonical 423 authenticated |
| Correctness fixes required before flag flip | **Open** — 5 findings, report §14.9 |
| Public intake UI, seller auth, abuse protection, rate limiting, observability, canary | **Not started** — activation phase |
| Flag enablement, V3 enablement for Offerr production traffic | **Blocked** — operator decisions |
| Public intake, providers, LeadCommand lifecycle, messaging, contracts, title, marketplace | **Deferred** |

## 12. Future seams (designed, not implemented)

- **Provider adapter:** every external read is injectable
  (`resolveSubjectProperty`, `loadCandidates`, `loadSubjectProperty`,
  `loadComparableProperties`, `loadBuyerPurchases`, `loadV3CompCandidates`).
  A paid-provider adapter plugs in as alternative loaders — including
  pre-structured address components — without touching resolver rules or the
  spine.
- **Public intake seam:** the route contract (validated body, idempotency
  key, seller-safe response) is the future public-form backend; exposure
  requires seller auth, rate limiting, and abuse controls first.
- **LeadCommand handoff:** `offerr_evaluation_requests` carries
  `acquisition_opportunity_id` / `thread_key` / `master_owner_id`; precedent
  bridge is `opportunity-workflow-bridge.js`. Lifecycle creation is deferred.
- **Re-evaluation:** `evaluation_version` supports versioned re-runs; the
  spine writes version 1 only.

## 13. Explicitly deferred / known limitations

Deferred: DealMachine or any paid provider; contact enrichment; public
intake wiring; UI; SMS/email; Offer Room; seller auth; SignPro AI;
contracts; title routing; LeadCommand lifecycle creation; marketplace
publication; applying the migration anywhere.

Known limitations:

- Canonical address components are parser-derived from strings (§3);
  comma-less inputs with unusual token order can fail closed to
  NOT_FOUND/AMBIGUOUS (never wrong-resolve).
- Because the leading token of comma-less input is now protected as the house
  number (the five-digit house-number fix, §3), an input whose leading token is
  in fact a bare ZIP — `"77035 tx houston area"` — parses as house number 77035
  on a street named "tx houston area" and fails closed to `NOT_FOUND` instead
  of `INVALID_INPUT`. Both map to the same seller-facing outcome
  (`REVIEW_REQUIRED` / `confirm_property_address`). The trade-off is
  intrinsic: a leading five-digit token cannot simultaneously be protected as
  a house number and consumed as a ZIP.
- The candidate query remains a broad superset filter, so an address whose
  first street-name token is also a very common city name can produce a large
  candidate set. That now fails closed to `AMBIGUOUS`
  (`candidate_set_exceeds_safe_bound`) rather than silently truncating, but it
  is a review outcome, not a resolution. Narrowing the DB-side filter without
  risking false exclusion is future work.
- Overlay-conflict rules are v1 and compare only **seller claims against each
  other or against `estimated_value`** — `asking_price > 1.5 ×
  estimated_value`, and `condition ∈ {excellent, good}` with
  `repairs.level = major`. There is **no comparison of a claimed condition
  against a canonical condition field**, because the canonical `properties`
  table carries no condition column. A seller claiming "excellent" on a
  derelict property is therefore not detectable today.
- `classifyAssetLane` infers `SFR` at confidence 55 from a unit count of 0 or 1
  whenever it recognises no type keyword, so a commercial record can present as
  a supported residential family. Offerr now refuses these itself
  (`detectNonResidentialSignal` plus a confidence floor of
  `OFFERR_MIN_ASSET_CONFIDENCE = 70`) rather than changing the shared
  classifier the wider acquisition engine depends on. The underlying classifier
  weakness remains and is worth fixing at source separately.
- Idempotency uniqueness is DB-enforced only after the migration is applied —
  until then the spine fails closed on persistence entirely.
- Verification used an ephemeral local PostgreSQL 17 container, not a hosted
  Supabase project. PostgREST behaviour, Supabase Auth, API-gateway grants as
  actually served, and a deployed preview URL are therefore **unverified**.
- The PostgREST adapter used by the E2E harness
  (`offerr-pg-rest-adapter.mjs`) implements only the query surface the Offerr
  store and the acquisition comp path use — `.rpc`, `.select` (with real column
  projection), `.eq/.in/.gte/.lte/.gt/.lt/.ilike`, repeatable `.order` with
  explicit NULLS placement, `.limit`, `.range` (inclusive, like the Range
  header), `{ count: 'exact' }`, `.single/.maybeSingle`, insert and delete. It
  is verification tooling, not a general Supabase client.
- **Comp-retrieval SQL parity is closed; comp-*data* parity is not.** The
  canonical RPC and view are now exact production definitions (§10.1b) and the
  E2E harness runs them for real, but every run to date uses 40 synthetic comp
  rows. Production holds ~48k. Real comp density, duplicate rates and package
  frequency are uncharacterised, so a hosted V3-enabled result may exercise
  paths these fixtures never reach.
- **The canonical `ORDER BY` has no unique tiebreaker.** Candidates equal on
  (similarity, sale_date, distance) have implementation-defined order, so with
  `p_limit` truncating, *which* comps survive can vary run to run on identical
  data. Reproduced faithfully rather than silently patched. Recommended
  production fix: append `, comp_id ASC`.
- **The comp RPC does not reject zero/negative prices or future-dated sales.**
  `is_usable_comp` only tests `NOT NULL`. Nominal prices are quarantined at
  qualification, but they still consume rows against the 100-row cap, and
  future-dated sales are not rejected on recency by any layer.
- Production grants `anon`/`authenticated` full DML on the comp tables and
  `EXECUTE ... TO PUBLIC` on the comp RPC, with RLS as the only guard. Observed
  read-only, unchanged, and reported for separate triage.
- `persistence_ms` and `total_ms` never appear in the lifecycle event's payload,
  because the service assigns them after handing the payload to the store. An
  observability gap, not a correctness one.

## Commands

```bash
cd apps/api
# Offerr spine suites (139 with a verification database; 115 pass + 2 skip
# without one — the DB-backed RPC contract suites skip rather than fail)
NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test PODIO_USERNAME=test \
PODIO_PASSWORD=test INTERNAL_API_SECRET=test BUYER_WEBHOOK_SECRET=test \
OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
node --import ./tests/register-aliases.mjs --test --test-concurrency=1 \
  tests/critical/offerr-*.test.mjs

# Full critical gate
npm run test:critical
```

### Staging / migration verification (never against production)

Stand up a disposable PostgreSQL 17 and apply the migration:

```bash
docker run -d --name offerr-verify-pg -e POSTGRES_PASSWORD=offerrverify \
  -e POSTGRES_DB=offerr_verify -p 55432:5432 postgres:17

# Supabase role + default-ACL environment (LOCAL ONLY — hosted Supabase
# already has these roles; never run prereqs against a hosted project)
psql "postgresql://postgres:offerrverify@127.0.0.1:55432/offerr_verify" \
  -v ON_ERROR_STOP=1 -f apps/api/scripts/offerr/offerr-supabase-prereqs.sql

# Base schema the spine depends on (properties, buyer_comp_raw_v2,
# buyer_entities_v2, get_comp_candidates_for_subject, safe system_control).
# This one DOES apply to hosted staging — it is the bootstrap step.
psql "postgresql://postgres:offerrverify@127.0.0.1:55432/offerr_verify" \
  -v ON_ERROR_STOP=1 -f apps/api/scripts/offerr/offerr-staging-bootstrap.sql

# Then the Offerr migration
psql "postgresql://postgres:offerrverify@127.0.0.1:55432/offerr_verify" \
  -v ON_ERROR_STOP=1 \
  -f apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql

# 47-check schema verification (run as schema owner, not service_role)
psql "postgresql://postgres:offerrverify@127.0.0.1:55432/offerr_verify" \
  -f apps/api/scripts/offerr/offerr-schema-verify.sql
```

End-to-end matrix, idempotency, concurrency, and reconciliation:

```bash
cd apps/api
NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test PODIO_USERNAME=test \
PODIO_PASSWORD=test INTERNAL_API_SECRET=offerr-staging-verify-secret \
BUYER_WEBHOOK_SECRET=test OPS_DASHBOARD_SECRET=test \
APP_BASE_URL=http://localhost:3000 \
ALLOW_OFFERR_STAGING_FIXTURES=true \
OFFERR_VERIFY_DATABASE_URL='postgresql://postgres:offerrverify@127.0.0.1:55432/offerr_verify' \
node --import ./tests/register-aliases.mjs scripts/offerr/offerr-e2e-verify.mjs
```

`OFFERR_KEEP_FIXTURES=true` retains the synthetic rows for inspection.

The guard **refuses to run** on all six conditions, each covered by
`tests/critical/offerr-staging-guard.test.mjs` (16 tests):

1. `ALLOW_OFFERR_STAGING_FIXTURES` is not exactly `"true"`.
2. The runtime designates itself production — `NODE_ENV`, `VERCEL_ENV`,
   `APP_ENV`, `APP_ENVIRONMENT`, `ENVIRONMENT`, `DEPLOY_ENV`, or
   `OFFERR_ENVIRONMENT` set to `production`/`prod`/`live`. This applies
   **regardless of target**: a correct staging ref reached from a production
   runtime is still a production execution.
3. A declared `requiredSecrets` env var is missing or blank.
4. The production ref `lcppdrmrdfblstpcbgpf` appears anywhere in the target,
   including embedded pooler hostnames.
5. The target is ReivestiExchange or SignPro.
6. The target cannot be positively identified as local or as a Supabase project
   matching `OFFERR_STAGING_PROJECT_REF`.
Teardown: `docker rm -f offerr-verify-pg`.

### Comp-contract verification (added 2026-07-30)

Rebuild a disposable database from source control alone, then prove the real
comp path against it. Nothing below ever touches a hosted project.

```bash
cd apps/api
export URL='postgresql://postgres:offerrverify@127.0.0.1:55432/offerr_verify'

# 1. Supabase roles + default ACLs (LOCAL ONLY — hosted Supabase has these)
psql "$URL" -v ON_ERROR_STOP=1 -f scripts/offerr/offerr-supabase-prereqs.sql

# 2. Canonical comp contract + staging guards. \ir-includes
#    supabase/contracts/offerr-comp-intelligence/canonical/*.sql
psql "$URL" -v ON_ERROR_STOP=1 -f scripts/offerr/offerr-staging-bootstrap.sql

# 3. The Offerr spine migration
psql "$URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql

# 4. Read-only contract/drift check — must print COMPATIBLE
OFFERR_SCHEMA_CHECK_DATABASE_URL="$URL" \
  node scripts/offerr/offerr-schema-drift-check.mjs

# 5. RPC contract suite against real PostgreSQL 17 (20 cases + 2 loader cases)
OFFERR_VERIFY_DATABASE_URL="$URL" NODE_ENV=test PODIO_CLIENT_ID=test \
PODIO_CLIENT_SECRET=test PODIO_USERNAME=test PODIO_PASSWORD=test \
INTERNAL_API_SECRET=test BUYER_WEBHOOK_SECRET=test OPS_DASHBOARD_SECRET=test \
APP_BASE_URL=http://localhost:3000 \
node --import ./tests/register-aliases.mjs --test --test-concurrency=1 \
  tests/critical/offerr-comp-rpc-contract.test.mjs

# 6. Full real-path E2E — no injected comps (291 assertions)
ALLOW_OFFERR_STAGING_FIXTURES=true OFFERR_VERIFY_DATABASE_URL="$URL" \
OFFERR_LATENCY_SAMPLES=30 NODE_ENV=test PODIO_CLIENT_ID=test \
PODIO_CLIENT_SECRET=test PODIO_USERNAME=test PODIO_PASSWORD=test \
BUYER_WEBHOOK_SECRET=test OPS_DASHBOARD_SECRET=test \
APP_BASE_URL=http://localhost:3000 \
node --import ./tests/register-aliases.mjs scripts/offerr/offerr-e2e-verify.mjs
```

`OFFERR_MATRIX_JSON=/path/matrix.json` writes the per-case comp diagnostics
(RPC rows, clusters, effective sample size, package/duplicate counts, execution
state, confidence) for comparison across runs.

---

## 14. Hosted verification environment — Supabase preview branches

### 14.1 One canonical project, temporary branches

There is exactly **one** permanent Supabase project, `real-estate-automation`
(`lcppdrmrdfblstpcbgpf`), shared by LeadCommand, OfferrAI, Reivesti Intelligence
and Reivesti Exchange. Product boundaries are enforced through schemas, tables,
grants, RLS, APIs, feature flags and domain contracts — **never** by standing up
a second permanent database.

Hosted verification therefore runs on a **temporary Supabase preview branch**
inside that project. A preview branch has its own project ref, its own
credentials, and its own empty database. It is a verification environment, not a
product database, and it is deleted when the PR that motivated it closes.

Do not duplicate canonical property, comp, buyer, acquisition or intelligence
architecture across permanent projects.

### 14.2 Proving you are on a preview branch

`offerr-staging-guard.mjs` proves a target is **not** production. It cannot prove
a target **is** a preview branch — with a per-branch ref it can only be *told*
so via `OFFERR_STAGING_PROJECT_REF`. Since the parent project's **default branch
is production**, "it's a branch" is not a safety property on its own.

`offerr-preview-branch-guard.mjs` closes that gap by asking the Supabase control
plane: the target ref must appear in the parent project's branch list **and**
must not be the default branch. It fails closed when identity cannot be
resolved. Call it before **every** hosted write:

```js
import {
  assertOfferrPreviewBranch, printPreviewIdentity,
} from './offerr-preview-branch-guard.mjs';

const identity = await assertOfferrPreviewBranch({ target: process.env.OFFERR_STAGING_DB_URL });
printPreviewIdentity(identity);
```

### 14.3 What hosted Supabase already provides

`offerr-supabase-prereqs.sql` exists to make a **bare PostgreSQL container**
resemble hosted Supabase. Do **not** apply it to a hosted project: the roles
(`anon`, `authenticated`, `service_role`, `authenticator`), schema `USAGE`, and
the `public` default privileges are already there, and
`offerr-staging-bootstrap.sql` creates `public.system_control` itself.

On a hosted project the sequence is just:

```
offerr-staging-bootstrap.sql   →   PROPOSED_..._offerr_evaluation_spine.sql
```

### 14.4 The privilege trap this uncovered

Hosted Supabase seeds default privileges for **tables, functions and sequences**:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... ON SEQUENCES TO anon, authenticated, service_role;
```

These become **explicit per-role grants**. `REVOKE ... FROM PUBLIC` removes
PostgreSQL's implicit `PUBLIC` grant but is powerless against them. Any new
`public` function in an Offerr migration must therefore revoke from the roles by
name, not only from `PUBLIC`:

```sql
REVOKE ALL ON FUNCTION public.my_fn() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_fn() FROM anon, authenticated, service_role;
```

This is a real defect that shipped and was only caught on hosted Supabase —
see the verification report §13.7. `offerr-supabase-prereqs.sql` now reproduces
the `ON FUNCTIONS` / `ON SEQUENCES` defaults so it is reproducible off-host, and
`tests/critical/offerr-hosted-privilege-contract.test.mjs` guards it.

Revoking a trigger function from `service_role` is safe: PostgreSQL checks
`EXECUTE` on a trigger function at `CREATE TRIGGER` time, not per firing.

### 14.5 Verifying the deployed system, not just the logic

`offerr-e2e-verify.mjs` calls `handleOfferrEvaluationsRequest` **in process**. It
proves the domain logic against a real database, but it skips the Vercel edge,
Next.js request parsing, the serverless cold start, the shipped runtime env, and
the real network hop to Supabase.

`offerr-preview-https-verify.mjs` drives the **deployed preview URL over HTTPS**
instead. Use it for anything whose answer depends on the deployment rather than
the code. It is split by `--phase` because two of its phases need a redeploy
with different runtime env:

| phase | preconditions | proves |
|---|---|---|
| `disabled` | flag OFF | auth-before-flag, uniform 423, zero rows written |
| `v3-disabled` | flag ON, V3 OFF | fail-closed, no range, no V2 fallback |
| `matrix` | flag ON, V3 ON | 12 cases, validation contract, idempotency, concurrency, privacy, side effects, latency |
| `persistence-failure` | flag ON | induced snapshot failure → 503, compensating deletion, key reusable |

Note the route's gate ordering: `auth (401) → flag (423) → size (413) → parse
(400) → intake (400)`. With the flag OFF **every** authenticated request returns
423, including malformed and oversized bodies — a disabled feature must not
parse attacker-controlled input. The 400/413 contract is only observable with
the flag ON.

### 14.6 Deployment-scoped env beats project-scoped Preview env

The Vercel `api` project has **no connected Git repository**, so Vercel refuses
branch-scoped Preview environment variables (`git_branch_required`). Writing
project-wide Preview variables instead would leak the preview database into any
future preview deployment of that project.

Pass configuration per deployment instead — nothing persists in project
settings, and there is nothing to clean up:

```bash
vercel deploy -e SUPABASE_URL="$URL" -e SUPABASE_SERVICE_ROLE_KEY="$KEY" ... --yes
```

Never pass `--prod`. Verify `target: null` in the deploy result — that is what
distinguishes a preview from a production deployment.
