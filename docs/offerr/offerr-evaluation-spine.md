# Offerr Evaluation Spine — Internal Vertical Slice

**Date:** 2026-07-29 (hardening pass same day)
**Status:** Implemented + independently reviewed on `feat/offerr-ai-evaluation-spine`; feature flag OFF; migration PROPOSED (not applied anywhere)
**Scope:** Internal-only evaluation spine — no seller communication, no contracts, no marketplace behavior
**Repository:** `kindleops/rei-automation`
**Safety posture:** No production data or schema was modified. No migrations were applied. The branch was not merged.

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
| 2. Idempotent replay lookup | `offerr-evaluation-store.js` | 503 store unreachable; 500 `offerr_incomplete_snapshot` for an orphaned request; 409 key reuse with different payload |
| 3. Deterministic address resolution | `offerr-property-resolution.js` | AMBIGUOUS / NOT_FOUND / INVALID_INPUT → review, no range |
| 4. Canonical subject hydration | `loadSubjectProperty` (engine) | hydration miss → AMBIGUOUS |
| 5. Asset classification + seller-fact overlay | `classifyAssetLane` + `detectOverlayConflicts` | unsupported family → UNSUPPORTED |
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
ZIP columns override). A future provider adapter can supply pre-structured
components through the same parsed-component shape without touching the
resolver rules.

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
  delete of the request row, and a surviving orphaned request is answered
  with `500 offerr_incomplete_snapshot` — a partial snapshot is never
  presented as a completed evaluation.

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

## 10. Current staging state

**There is no staging Supabase project for this repository.** The
authenticated CLI lists three projects; the linked one
(`lcppdrmrdfblstpcbgpf`, "real-estate-automation") is the **production**
database named in the V3 audit, and the other two belong to different
products (ReivestiExchange, SignPro). Per the safety rules, nothing was
applied anywhere.

**Exact operator instructions to stage the migration** (when a staging
project exists):

1. Verify identity: `supabase projects list` — the target ref must NOT be
   `lcppdrmrdfblstpcbgpf` and must be a project you can positively identify
   as staging (name + org + creation intent).
2. Copy `PROPOSED_20260729120000_offerr_evaluation_spine.sql` into the SQL
   editor of that staging project (or rename without the `PROPOSED_` prefix
   in a staging-only checkout and `supabase db push --linked` there). Do not
   rename the file on this branch — the local link points at production.
3. Verify: three `offerr_*` tables exist; RLS enabled with service-role-only
   policies; `anon`/`authenticated` have no grants;
   `system_control.offerr_evaluation_enabled = 'false'`.
4. Smoke test with synthetic fixtures only (the critical suites); seed no
   seller or property records.
5. Leave the flag disabled. Rollback per §6 if needed.

## 11. Launch state

| Area | State |
|---|---|
| Domain contracts, orchestrator, gates, projection, store | **Implemented** |
| Structured address resolution (suffix/directional/state/ZIP+4/unit) | **Implemented** |
| Fail-closed ambiguity, geography-conflict, unit rules | **Verified** (59 tests green) |
| Side-effect and privacy proofs | **Verified** (executable, real-loader path) |
| Idempotency incl. races, payload reuse, partial snapshots | **Verified** |
| Migration | **Staging-ready** (PROPOSED; operator instructions in §10) |
| Staging application | **Blocked** — no staging project exists (business decision) |
| Flag enablement, V3 enablement for Offerr traffic | **Blocked** — operator decisions |
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

Known limitations: canonical address components are parser-derived from
strings (§3); comma-less inputs with unusual token order can fail closed to
NOT_FOUND/AMBIGUOUS (never wrong-resolve); overlay-conflict rules are v1
(asking-price and condition/repairs only); idempotency uniqueness is
DB-enforced only after the migration is applied — until then the spine fails
closed on persistence entirely.

## Commands

```bash
cd apps/api
# Offerr spine suites (59 tests)
NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test PODIO_USERNAME=test \
PODIO_PASSWORD=test INTERNAL_API_SECRET=test BUYER_WEBHOOK_SECRET=test \
OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
node --import ./tests/register-aliases.mjs --test --test-concurrency=1 \
  tests/critical/offerr-*.test.mjs

# Full critical gate
npm run test:critical
```
