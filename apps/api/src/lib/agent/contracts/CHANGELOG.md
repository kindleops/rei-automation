# Agent contracts changelog

The S2 UI (`apps/dashboard/src/modules/agent/**`) mirrors these contracts and its
drift test compares them. Every change here is additive and backward compatible
unless stated otherwise.

## 2026-10-09 — S3 (live Entity Graph Quick Scan)

Nothing existing was renamed, removed or re-typed. `EVENT_TYPES`,
`OPERATION_LABEL_TEMPLATES`, `EVIDENCE_STATUSES`, `EVIDENCE_STATUS_META` (for the
existing statuses), `FINDING_TYPES`, `BRIEF_SECTIONS`, `SOURCE_FAILURE_REASONS`
and every state table are unchanged, so the mirror drift test still passes.

### evidence.js (new exports)
- `EVIDENCE_SOURCE_CLASSES` — the five P4 visual classes:
  `official_public_record | internal_record | third_party_vendor | derived_inferred | unavailable_blocked`.
  `EVIDENCE_SOURCE_CLASS_META[class] = { label, description, statuses[] }` lists the
  evidence statuses each class may carry. `sourceClassViolations(finding)`.
- `EXTENDED_EVIDENCE_STATUSES` = `EVIDENCE_STATUSES` + `internal_record`, `derived`
  and `EXTENDED_EVIDENCE_STATUS_META` (labels "LeadCommand record", "Derived").
  Live findings may carry these two statuses. **UI action:** look labels up in
  `EXTENDED_EVIDENCE_STATUS_META` (or fall back) — `EVIDENCE_STATUS_META[s].description`
  is undefined for the two new statuses.
- `EVIDENCE_AUTHORITY_WEIGHT` gains `internal_record: 0.9`, `derived: 0.7`.
- `findingViolations` accepts the extended statuses (results for the existing
  statuses are unchanged).
- `QUICK_SCAN_FINDING_TYPES` — finding types with no DR equivalent:
  `property_facts, transfer_history, equity, valuation, outreach_state,
  sms_eligibility, market_context, street_view` ({ label, section, inspector_panel }).
  Look up `FINDING_TYPES[t] ?? QUICK_SCAN_FINDING_TYPES[t]`.

### Live finding shape (superset of `Finding`)
Adds: `run_id`, `source_class`, `source_name`, `evidence_label`, `provenance`
(service/table path), `limitations[]`, `basis_finding_ids[]`, `unavailable_reason`
(on unavailable findings), `live: true`. Unavailable findings always have
`value: null`, `display_value: null`, `is_negative_claim: false`,
`freshness_state: 'never'`.

### events.js (payload whitelist additions; no new event types)
- `finding.conflict` payload may also carry `best_supported` (claim or `null`),
  `reason`, `remaining_uncertainty`, `follow_up`. `members[]` entries are
  `{ finding_id, claim, source_id, source_name, source_class, evidence_status, as_of }`.
  `resolution_state` is `open` (unresolved) or `resolved_by_rule`.
- `brief.section` payload may carry `property_id` (batch runs emit one set of
  sections per property; the envelope `property_id` is also set).
- Brief claims carry `source_class` in addition to the S1 `BriefClaim` fields.

### Live runs
- Quick Scan tasks use operation `research.check` with
  `jurisdiction = 'LeadCommand'` (labels read "Checking LeadCommand recorded liens
  (Recorded documents (vendor-transcribed))").
- `task.unavailable.reason` may be `interrupted_by_restart`; the task re-runs as
  `attempt: 2` (S1 idempotency on run/task/type/attempt — no duplicate rows).
- Live responses and snapshots carry `live: true, fixture: false`; live events never
  carry `fixture`.

### runtime (server-side, not mirrored)
- `sanitize.js`: values under identifier keys (`id`, `*_id`, `*_ids`) are no longer
  phone-masked (a 10-digit `property_id` was being masked to `••NNNN`). URL/email
  sanitization and length caps still apply.
- `store.js`: state gains `conflicts: Map`. `runtime/file-store.js` is the durable
  local-dev adapter with the same interface.

## 2026-10-09 — S3 durable persistence (branch feat/agent-s3-persistence)

No contract file changed. Server-side only:
- `runtime/pg-store.js`: Postgres adapter with the same store interface
  (`transaction / read / onCommit / kind`) plus `open / refresh / hydrateRun`.
  Schema: `supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence.sql`
  (PROPOSED, not applied). Snapshots report `store.kind: 'postgres'`.
- Live wiring: `AGENT_STORE=postgres` selects it; production additionally
  requires `AGENT_LIVE_PRODUCTION_PILOT=1` (all default off).
- `quickScan.recover()` never takes over a run whose lease is still live (another
  worker/instance owns it); it returns the resumed job ids with `.deferred` and
  re-checks when that lease would expire.
- Research job rows: the internal field `cross_checked` is now
  `cross_checked_property_ids` (never exposed in events or snapshots).
- The DB CHECK sanitizer allows contact keys (`phone`, `phones`, `email`, …) only
  as counts/flags — e.g. `contact_candidates.phones: 2` — never as values.

## 2026-10-09 — S3 RC hardening (branch feat/agent-s3-persistence)

API additions for the UI (no contract file changed):
- **Evidence expiry.** When retention purges a finished run's events/findings,
  `GET …/live/runs/:id` returns `evidence_complete: false` and
  `evidence_expired: { expired: true, expired_at, events_purged, findings_purged,
  conflicts_purged, tasks_purged, reason: 'retention_policy', notice }` with
  `view: null`, `findings: []`, `conflicts: []`. `GET …/events` returns
  `events: [], done: true, evidence_expired`. History rows carry
  `evidence_expired_at`. **UI action:** show `notice` ("Evidence expired on
  <date> …"); never render an expired run as a complete brief. Live snapshots of
  unexpired runs carry `evidence_complete: true`.
- **Research slot wait.** When 2 research jobs already hold a lease (org-wide,
  enforced across all workers), a confirmed scan waits and emits ONE `decision`
  event with `criterion: 'research_slot_wait'` ("Waiting for a research slot …").
- Runtime: workers claim tasks only while holding a live lease (fenced); a
  takeover of an expired lease reports in-flight reads `interrupted_by_restart`
  and re-runs them as the next attempt; `runService.claimLease` refuses terminal
  runs (`RUN_TERMINAL`). Read client allowlists `campaign_entity_contact_evidence`
  (STABLE, read-only; used by outreach when ENTITY_CONTACT_ROLE_V2 ≠ off).

## 2026-10-09 — security review fixes (branch feat/agent-s3-persistence)

- Run-scoped live routes (snapshot / events / cancel) return **404** to any
  operator other than the one who started the run; history lists only the
  caller's runs. (confirm already returned 403 for another operator.)
- The durable store connects as the least-privilege `agent_api` role
  (`AGENT_DATABASE_URL`, required in production, verified TLS with
  `AGENT_DATABASE_CA_PEM`). No UI change.

## 2026-10-10 — Gate B: named-user auth, review-only S3, spend guard, kill switch (branch feat/agent-gate-b)

API changes the UI must know (no contract file changed):
- **Auth.** Every `/api/cockpit/agent/live*` request needs the operator's own
  Supabase session: `Authorization: Bearer <access token>` (the Worker already
  forwards it; `callBackend` already sends it). The API verifies it itself and
  checks the operator allowlist. No session → **401 `SESSION_REQUIRED`** /
  `SESSION_INVALID` / `SESSION_EXPIRED`; not allowlisted → **403
  `OPERATOR_NOT_ALLOWLISTED`**; an `x-ops-user-id` that differs from the
  session user → **403 `OPERATOR_MISMATCH`**; Supabase Auth not configured on
  the API → **503 `IDENTITY_VERIFIER_UNCONFIGURED`**. **UI action:** on 401
  prompt re-sign-in; on 403 show "not authorized for the agent".
- **Rate limits.** 429 `RATE_LIMITED` (with `Retry-After`) and 429
  `DAILY_RUN_CAP`. **UI action:** show the message; never auto-retry a 429
  before `Retry-After`.
- **Actor stamp.** Every event carries `actor_user_id` (the run's verified
  operator); every finding carries `actor_user_id`; runs carry `actor_user_id`
  and `actor_verified_via: 'supabase_jwt'`. Additive.
- **Status probe** adds `read_only: true` and `identity: { method:
  'supabase_jwt', verified: true }`. **Preflight** adds `spend_guard: {
  this_job_usd, structural_zero, user_day_usd, global_day_usd }`.
- **Kill switch.** `AGENT_ENABLED` off → every agent route 404 (empty body),
  exactly like the route gate. A running scan stops at its next task boundary;
  its `job.cancel_requested.requested_by` is `system:kill_switch`.
- **Spend guard.** Confirm answers **423 `SPEND_CAP_*` / `TOKEN_CAP_*` /
  `SPEND_ACTOR_REQUIRED`** for a job that would cost money beyond the caps
  ($0 by default). Quick Scan ($0 by structure) is never refused by it.
