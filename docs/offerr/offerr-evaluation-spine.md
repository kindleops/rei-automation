# Offerr Evaluation Spine — Internal Vertical Slice (Phase 0)

**Date:** 2026-07-29
**Status:** Implemented on `feat/offerr-ai-evaluation-spine`; feature flag OFF; migration PROPOSED (not applied)
**Scope:** Internal-only evaluation spine — no seller communication, no contracts, no marketplace behavior
**Repository:** `kindleops/rei-automation`
**Safety posture:** No production data was modified. No migrations were applied. The branch was not merged.

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
published to Reivesti Exchange or any member-facing marketplace.

This slice implements only the internal evaluation spine. It never produces a
binding offer, never contacts a seller, never creates a contract, and never
routes title. Every result is preliminary and non-binding by construction.

## 2. Request lifecycle

`POST /api/internal/offerr/evaluations` → `evaluateOfferrProperty(input, deps)`:

| Stage | Module | Fail-closed behavior |
|---|---|---|
| 1. Validate + normalize intake | `offerr-contracts.js` | 400 `invalid_offerr_intake` |
| 2. Idempotent replay lookup | `offerr-evaluation-store.js` | 503 if store unreachable |
| 3. Deterministic address resolution | `offerr-property-resolution.js` | AMBIGUOUS / NOT_FOUND → review, no range |
| 4. Canonical subject hydration | `loadSubjectProperty` (engine) | hydration miss → AMBIGUOUS |
| 5. Asset classification + seller-fact overlay | `classifyAssetLane` + `detectOverlayConflicts` | unsupported family → UNSUPPORTED |
| 6. Comp + buyer + decision paths | engine loaders + `calculateAcquisitionDecision` | loader error → structured failure |
| 7. Offerr safety gates | `offerr-safety-gates.js` | any uncertainty → review, no range |
| 8. Immutable snapshot persistence | `offerr-evaluation-store.js` | persistence failure → no range returned |
| 9. Seller-safe projection | `offerr-seller-projection.js` | malformed range → null range |

Every stage is timed independently; timings land in structured logs and the
persisted provenance.

## 3. Canonical components reused (no duplication)

| Capability | Canonical component |
|---|---|
| Pure decision | `calculateAcquisitionDecision` (`apps/api/src/lib/acquisition/acquisitionDecisionEngine.js`) — same read-only invocation pattern as `comp-intelligence-v3-projection.js` |
| Subject hydration | `loadSubjectProperty` (117-column canonical `properties` read + enrichments) |
| Comp evidence | `loadComparableProperties`, `loadBuyerPurchases`, `loadV3CompCandidates` (RPC `get_comp_candidates_for_subject`) |
| Contamination defense | `qualifyComps` / `transactionClustering` (packages collapse to one economic transaction; correlated rows cannot inflate depth) |
| Numeric invariants | `assertAcquisitionInvariants` (nonfinite, negative, reversed, anchor-multiple, single-comp share) |
| Vocabulary | `EXECUTION_STATES`, `VALUE_CLASSIFICATION`, `LANE_FAMILY`, `ENGINE_VERSION` / `FORMULA_VERSION` |
| Route conventions | `requireSharedSecretAuth` (INTERNAL_API_SECRET), `child()` logger, `captureRouteException`, `system_control` flags + canonical 423 envelope |
| Fact-claim conventions | claim envelopes modeled on `extract-seller-facts.js` (`source`, `verified`, `received_at`) |

Deliberately **not** used: `scoreProperty` (persists engine output to
`property_acquisition_scores`), `buyer_comp_properties_v2` blind ZIP pulls,
and every outbound-execution surface (queues, messages, contracts, title,
campaigns). A static test enforces the absence of those references.

## 4. New seams (why they had to exist)

1. **Deterministic address → property resolution.** The repo is
   `property_id`-first; the only address path was fuzzy ranked search.
   `resolveOfferrSubjectProperty` matches on normalized equality against
   `properties.property_address_full`: one exact match → `RESOLVED`; several →
   `AMBIGUOUS`; partial-only → `AMBIGUOUS`; none → `NOT_FOUND`. It never
   guesses a winner.
2. **Offerr outcome gating** (`offerr-safety-gates.js`) — maps engine states
   to the Offerr outcome vocabulary with fail-closed defaults.
3. **Seller-safe projection** — explicit allowlist; internal underwriting
   never rides along.
4. **Offerr persistence** — see §5.

## 5. Schema decisions

No existing table can hold Offerr records safely:

- `property_acquisition_scores` is `UNIQUE(property_id)` engine output — no
  history, wrong ownership.
- `property_cash_offer_snapshots` is a Podio-owned single-number offer mirror
  whose header explicitly forbids ranges.
- `acquisition_opportunities` has pipeline grain, no intake payload, no
  idempotency.

Additive schema (PROPOSED, **not applied**):
`apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql`

| Table | Grain | Notes |
|---|---|---|
| `offerr_evaluation_requests` | one intake | `UNIQUE(idempotency_key)`; seller facts stored as unverified overlay; future-handoff columns (`acquisition_opportunity_id`, `thread_key`, `master_owner_id`) |
| `offerr_evaluations` | one immutable snapshot per version | `UNIQUE(request_id, evaluation_version)`; carries `seller_projection`, `internal_result`, `provenance` |
| `offerr_evaluation_events` | append-only ledger | unique partial index on `dedupe_key` |

All three: service-role-only RLS (Pattern 1, matching `acquisition_contacts`),
`REVOKE` from `anon`/`authenticated`, comments documenting boundaries, and a
`system_control` seed of `offerr_evaluation_enabled = 'false'`. The
`PROPOSED_` prefix keeps the file outside the `supabase db push` path (same
convention as the closing-desk foundation), so nothing reaches production in
this task.

Provenance stored per evaluation: spine/engine/formula versions, active
feature flags, subject source, resolution method, `comp_set_hash` (sha256 of
comp identity + price + date), comp retrieval tier, effective sample size,
seller-fact overlay, material conflicts, gate checks, reason codes,
`computed_at`, `expires_at`, and per-stage timings.

## 6. API contract

`POST /api/internal/offerr/evaluations` (internal only; not publicly exposed)

- Auth: `x-internal-api-secret` (or `Authorization: Bearer`) vs `INTERNAL_API_SECRET`.
- Flag: `system_control['offerr_evaluation_enabled']`, read fail-closed;
  disabled → canonical `423 { ok:false, error:"system_control_disabled", flag_key, context }`.
- Body: `{ address, idempotency_key, seller_facts?, source? }`, max 32 KiB (413 beyond).
- Success `200`: `{ ok, route, request_id, evaluation_id, idempotent_replay, evaluation }`
  where `evaluation` is the seller-safe projection only.
- Errors: `400 invalid_offerr_intake` (+`validation_errors`), `401`, `413`,
  `423`, `503` persistence, `504 evaluation_timeout`, `500` otherwise.
- Idempotency: same `idempotency_key` deterministically replays the stored
  evaluation (DB unique constraint is the authority; insert races resolve by
  re-read).

## 7. Seller-safe vs internal result

Seller-safe projection (allowlist, leak-tripwire tested):
`evaluation_id`, `spine_version`, `outcome`, `property`
(address/city/state/zip/type only), `preliminary_range` (`{low, high, USD}`
or null), `confidence_label` (HIGH/MEDIUM/LOW), `next_step`, `assumptions`,
`data_conflicts`, `binding: false`, `preliminary: true`, `disclaimer`,
`expires_at`, `processing_ms`.

Never exposed: provider payloads, owner/contact enrichment, MAO formulas,
assignment-fee targets, buyer identities, raw comp data, internal risk rules,
private identifiers (`property_id` et al.), execution states, service/debug
information. The internal result (full engine decision + provenance) persists
in `offerr_evaluations.internal_result`, service-role only.

## 8. Outcome vocabulary

- Resolution: `RESOLVED | AMBIGUOUS | NOT_FOUND | UNSUPPORTED`
- Outcome: `INSTANT_RANGE_ELIGIBLE | CONDITIONAL_RANGE | REVIEW_REQUIRED | UNSUPPORTED`

Mapping (fail-closed order): unresolved → review; unsupported family
(only `RESIDENTIAL_SINGLE` and `SMALL_MULTI` are supported) → unsupported;
V3 evidence layer off → review; non-range-eligible execution state, invariant
violation, material anomaly, or non-QUALIFIED value classification → review;
authorized cash figures absent → review. A range is presented only from
**authorized** (underwritten) figures — never scenario figures — as
`[authorized_opening_offer, authorized_recommended_offer]`, and only when the
ceiling clears `authorized_maximum_offer`, the conservative buyer exit, and
the qualified valuation anchor. INSTANT requires confidence ≥ 70 and
effective sample size ≥ 3 with no material source conflicts; CONDITIONAL
requires ≥ 55 / ≥ 2. Everything else is review.

## 9. Safety invariants (tested)

- Unresolved / ambiguous / unsupported → no range.
- Insufficient qualified comps → conditional or review (never instant).
- Package/broadcast consideration (Caldwell 1711 N Illinois Ave regression)
  → quarantine → review, no range; 12 rows count as one transaction.
- Single extreme comp (Austin 5314 Atascosa Dr $332.5M regression) → review,
  no range, never HIGH confidence (canonical 1-comp confidence cap).
- NaN / Infinity / negative / reversed engine output → hard failure, nothing
  persisted, nothing presented.
- Range ceiling ≤ conservative acquisition ceiling and ≤ independent
  qualified valuation anchor; floor ≤ ceiling.
- Source conflicts (e.g. seller asking price ≫ independent value, condition
  vs repair disclosure) downgrade eligibility.
- Seller facts remain claims (`verified: false`) and never mutate the
  canonical property (frozen-subject test).
- No automatic binding offer, no contract generation, no seller
  communication, no title routing (static source assertion + autonomy flags
  asserted false).

## 10. Feature flag

`offerr_evaluation_enabled` in `system_control` (runtime-toggleable, read
with `failClosedOnError: true`). Absent/false → the route answers the
canonical 423 envelope. The migration seeds it `'false'`. The acquisition V3
flags (`ACQUISITION_ENGINE_V3_*`) keep their existing defaults and are only
read, never changed, by this slice.

## 11. Observability and latency budget

Structured logs via `child({ module: 'domain.offerr.evaluation' })` and
`api.internal.offerr.evaluations`: `offerr_evaluation.requested / .completed
/ .failed / .timeout` with stage durations (`validate_ms`, `idempotency_ms`,
`resolution_ms`, `subject_ms`, `overlay_ms`, `comp_load_ms`, `engine_ms`,
`gates_ms`, `persistence_ms`, `total_ms`), outcome, reason codes, and model
versions. Addresses are logged only as a sha256 prefix + zip; no seller
contact PII exists anywhere in the spine.

The orchestrator enforces a 15 s internal deadline (`evaluation_timeout`,
fail closed) toward the future <15 s product target. Measured fixture runs
complete in well under one second, but no live-provider latency claim is made
— DealMachine/provider integration is deferred.

## 12. Future seams (designed, not implemented)

- **Provider adapter:** every external read is injectable
  (`resolveSubjectProperty`, `loadSubjectProperty`, `loadComparableProperties`,
  `loadBuyerPurchases`, `loadV3CompCandidates`). A DealMachine (or other paid)
  adapter plugs in as alternative loaders without touching the spine.
- **LeadCommand handoff:** `offerr_evaluation_requests` carries
  `acquisition_opportunity_id` / `thread_key` / `master_owner_id`; the
  precedent bridge is `opportunity-workflow-bridge.js`. Lifecycle creation is
  deferred.
- **Re-evaluation:** `offerr_evaluations.evaluation_version` supports
  versioned re-runs; the spine currently writes version 1 only.

## 13. Explicitly deferred

DealMachine credentials or live requests; paid data-provider integration;
contact enrichment; public intake form wiring; final UI animation; SMS/email
communication; Offer Room; seller authentication; SignPro AI; contracts;
title routing; LeadCommand lifecycle creation; public advertising claims;
marketplace publication; applying the PROPOSED migration.

## Commands

```bash
cd apps/api
# Offerr spine suites
NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test PODIO_USERNAME=test \
PODIO_PASSWORD=test INTERNAL_API_SECRET=test BUYER_WEBHOOK_SECRET=test \
OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
node --import ./tests/register-aliases.mjs --test --test-concurrency=1 \
  tests/critical/offerr-*.test.mjs

# Full critical gate
npm run test:critical
```
