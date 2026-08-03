# Backend Final Completion — 2026-08-02

Branch `launch/backend-final-completion`, cut from `main` merge
`c83488d1` (PR #62, reviewed head `a968794a`). This pass closes the nine
open blockers §5 of `backend-launch-closure-2026-08-01.md` enumerated, so
the next action is exactly: one production deployment, one migration
sequence, one complete internal automation proof
(`production-activation-runbook-2026-08-02.md`).

**Status contract (unchanged from rev 2):** every capability sits in exactly
one bucket — *implemented*, *tested* (deterministic tests pass),
*replay-observed* (exercised against historical production data, read-only),
*production-proven* (observed in live traffic), or *still missing*. Nothing
in this pass is production-proven: the branch is not deployed, no migration
here is applied to production, and no live traffic has touched this code.

## 1. Database-authoritative inbound idempotency — implemented, tested, replay-observed

`claim_inbound_processing()` / `complete_inbound_processing()`
(migration `20260802090000`) are the ENFORCEMENT layer: exactly one
processing claim per idempotency key, with leases and expiry, attempt
counts, run-id fencing (a zombie whose lease expired gets `claim_fenced`,
never a silent overwrite), attempts-exhausted terminalization, and a
durable `duplicate_delivery_count` so a duplicate completed webhook is an
audited `duplicate_ignored` carrying the prior disposition reference —
never a silent drop. Outcomes: `claimed_new`, `retry_claimed`,
`duplicate_completed`, `already_processing`, `terminally_failed`,
`invalid_claim`.

The wrapper claims BEFORE the core handler; fail posture is closed: with
Supabase configured but the claim path unavailable, the webhook returns
503 + Retry-After instead of processing unclaimed. The `/tmp`
runtime-state store no longer decides anything when a DB claim is active —
it is labeled non-authoritative diagnostic caching (divergences logged,
never enforced), and remains the enforcement fallback only where Supabase
is unconfigured (hermetic tests, local dev).

Proofs: `scripts/proof/inbound-claim-concurrency-proof.mjs` — 12/12
invariants on real Postgres with 24 parallel connections (one winner per
storm, duplicate audit counting, single reclaim after lease expiry, zombie
fencing, per-key isolation). Hermetic: `inbound-claim-enforcement` 11/11.
Replay-observed: all 1,284 historical HTTP receipts replayed through the
REAL SQL functions — 1,208 claims, 76 duplicate_completed (exactly the
receipt-level duplicate count), 0 contract violations.

## 2. Route-level request receipts — implemented, tested

`webhook_request_receipts` (migration `20260802091000`): one durable row
per inbound webhook HTTP request outcome, including requests rejected
before the core handler — oversized (new 413 guard), malformed payload,
missing sender, invalid/missing signature (strict 401), parser exception,
internal error, fail-closed claim (503), duplicate delivery, empty/
media-only body, accepted. PII posture: hashed body + length, masked+hashed
phone identifiers, canonical rejection vocabulary (a rejected receipt
without a reason is unrepresentable), 30-day `retain_until` enforced by the
extended daily purge cron. Receipt writes never alter the HTTP response.
15/15 tests (module + route integration). Rate limiting: the receipts
vocabulary reserves `rate_limited`, but the route itself has no application
rate limiter (platform-level protection only) — recorded honestly, not
implemented.

## 3. Detector coverage — implemented, tested, replay-observed

Eight new live labels (`title_issue`, `lien_tax_issue`,
`bankruptcy_disclosed`, `trust_ownership`, `llc_corporation`,
`voicemail_call_request`, `requests_email`, `language_switch`) with
negation-guarded phrase banks, placed below compliance/identity and
explicit declines; estate-administrator and authorized-signer authority
folds; registry/ontology alignment (`needs_email` → `requests_email`);
legal/authority intents route to precise human review, never suppression.
Compound intents preserved end-to-end (`matched_intents` passthrough +
`compound_intent` marker): the canonical "probate + sister-executor +
150k" message keeps authority state, executor identity, asking price, sale
interest, the unanswered authority question, and next action. Ontology
detector gaps: 26 → 19; each remaining gap is a deliberate state-layer or
meta entry (re_engagement, changed_mind, seller_initiated_after_stop,
delayed_old_campaign_reply, sarcasm, typo_heavy, …) whose behavior lives in
latest-intent precedence / suppression state, proven by tests rather than a
text detector. Adversarial corpus: 68 → 80 cases, 100% on all six metrics.

Defect fixed during replay inspection (`7f771dc5`): bare "years ago" fired
the former-owner disconnect, so an owner's renovation anecdote replayed as
a wrong-number phone suppression (reproduced at the pristine merge SHA —
pre-existing). "years ago" now requires a transfer verb in-clause; 133/133
classification battery after the fix.

## 4. Behavioral scoring — implemented, tested, replay-observed

`conversation_behavior_scoring_v1`: fourteen deterministic scores
(sentiment, hostility, urgency, confusion, skepticism, trust_concern,
engagement, motivation, sale_readiness, price_sensitivity,
timing_sensitivity, reply_effort, conversational_momentum,
re_engagement_strength), each `{value, confidence, evidence[], scorer,
scorer_version, fallback_reason}`. Insufficient evidence → null +
`insufficient_evidence`, never a mid-range guess; message length alone can
never produce a psychological score (reply_effort is explicitly a
mechanical measure). The `modelAssistScorer` seam defaults to absent, is
ignored wholesale in compliance/identity/suppression contexts, can only
nudge mid-range values, and can never override opt-out / wrong-number /
identity / authoritative state facts (hostile-mock test). Scores reach
temperature/next-action only through the temperature model's bounded
`secondary` seam with documented caps (engagement-only can never leave
COLD; uncorroborated urgency cannot create WARM/HOT). Replay: 1,200/1,200
events scored, 0 exceptions. 23/23 tests; null-score degradation is
byte-identical to prior behavior.

## 5. Natural-response provider path — implemented, tested; NOT production-proven

Mode matrix (`NATURAL_REPLY_ENGINE`): unset/disabled (production default) /
`shadow` (generate+validate+audit; template always ships) /
`internal_proof` (substitution only for internal test phones; all real
threads behave as shadow) / `enabled`. Provider client: Groq/OpenRouter,
hardcoded per-provider model allowlist with audited fallback,
AbortController timeout (`NATURAL_REPLY_TIMEOUT_MS` 8000, clamp
1000–20000), exactly-one retry on network/429/5xx, max_tokens from the
length cap, latency + usage metadata into the audit. Wiring completeness:
suppression hard-gate, unanswered-questions/next-question/tone/length
validators now receive live inputs; every generation outcome persists an
automation event (`NATURAL_REPLY_APPLIED` / `_SHADOW_EVALUATED` /
`_FALLBACK`) and the audit rides all return shapes. 60/60 tests (26
pre-existing + 34 golden across 12 intent families, including suppression
families proving the model is never invoked after opt-out / wrong-number /
post-STOP). Replay shadow stage with recorded outputs: 12/12 compliant
validated, 12/12 hostile rejected to the deterministic template, 3/3
suppression gates held.

NO provider credential exists in any environment today; with keys absent
the path is byte-identical to the deterministic template behavior. Required
env NAMES for internal activation: `GROQ_API_KEY` or `OPENROUTER_API_KEY`;
`NATURAL_REPLY_ENGINE=internal_proof`; optional `NATURAL_REPLY_MODEL`,
`NATURAL_REPLY_TIMEOUT_MS`. Residual PII vector (documented): the prompt's
bounded 12-turn history contains seller-typed content; no phone-number
fields are transmitted; audits contain no raw seller text.

## 6. Atomic internal-proof stamp — implemented, tested

`internal_proof_stamp_queue_row()` (migration `20260802092000`): one
PK-targeted atomic UPDATE verifying observed `queue_status` + campaign
state, merging ONLY the five allowlisted stamp keys via server-side
`jsonb ||` (concurrent unrelated metadata survives — proven with a racing
writer), recording proof session + processing run, returning the updated
row, failing closed on zero-row match and on any disallowed key;
service_role-only EXECUTE. The runbook's stamp-reply uses it exclusively —
no fallback to the racy client-side merge. 15/15 real-Postgres concurrency
invariants; 25/25 hermetic.

## 7. Burst aggregation readiness — implemented, tested; production burst still OFF

`SELLER_INBOUND_BURST_ENABLED=internal_proof`: burst engages ONLY for an
internal test phone AND an active bounded internal-proof session, evaluated
per message; every failure mode fails closed to disabled. Real seller
burst behavior remains off until the full proof passes. SQL-level claim
verification on real Postgres (9/9): debounce window, one concurrent winner
(SKIP LOCKED), live-lease blocking, single reclaim with token rotation,
safety-latch flip, completed-burst immunity, one-open-burst-per-thread.
Full 86-test burst suite green with the gate in place (ordering, cutoff,
delayed/out-of-order/duplicate messages, mid-burst arrivals, per-inbound
terminal disposition, one reply decision per burst).

## 8. Authoritative state transitions — implemented, tested

One decision object (`seller_flow_decision` → `patchUniversalLeadState`)
drives lifecycle_stage, seller_stage, operational_status, lead_temperature,
disposition, suppression, follow-up, next action — with before/after audit
rows for every changed tracked field. The pre-spine classification sync no
longer writes decision-owned fields (`stage`/`status`/`next_action`/
`automation_state`/`disposition`) from its own interpretation on the seller
path; safety-latched messages keep the immediate protective projection.
12 sequence tests cover the 16 required scenarios including STOP,
post-STOP human-review-only, probate compound preservation, and
stale-reordered delivery. Remaining unguarded writers, deliberately out of
the inbound decision path: bucket-staleness maintenance (bucket has no
canonical writer by design), the operator workflow-rules lane (lifecycle
fields already route through the guarded patch), the dormant
`deal_thread_state` dispatcher, `acquisition_contacts` (different table/
lane), and the route-level chronology resync (self-consistent re-derivation
from full history; unaudited; deferring it needs spine-will-run knowledge
the route lacks at that point).

## 9. Full historical replay — replay-observed (final run, post-fix code)

All **1,232** historical inbound events (2026-04-23 → 2026-07-30), 1,200
replayed (32 internal-canary excluded), plus **1,284 raw HTTP receipts**:

- Idempotency (real SQL functions, local scratch PG): 1,204 unique-SID +
  4 no-SID receipts → **1,208 claimed, 1,208 completed, 76
  duplicate_completed, 0 violations** — duplicates match the receipt-level
  duplicate count exactly.
- Terminal-disposition coverage **100.00%**; exceptions **0**; silent drops
  **0**; opt-out violations **0**; wrong-number violations **0**;
  reply-policy self-consistency **100.00%**.
- Disposition histogram: 571 human_review_required / 343 no_reply_required /
  203 suppressed_opt_out / 83 suppressed_wrong_number (the review share
  remains a context-free replay artifact, not production routing).
- Intent agreement vs historical labels **88.42%** of 1,192 (the
  disagreement classes were manually characterized in rev 2; this pass adds
  finer legal/modality labels that count as "disagreements" against coarser
  history).
- Compound coverage: 70 multi-intent events, 27 carrying the
  compound_intent marker. Behavioral scoring: 1,200/1,200, 0 exceptions.
  Low-confidence rate 0.00%; human-review rate 47.58% (replay artifact, as
  above). Latency under a loaded host: p50 52 ms / p95 200 ms (uncontended
  runs of the same code measured p50 19–28 ms / p95 59–128 ms).
- Thread-aware pass: 943 threads / 150 multi-turn / 1,200 turns — 0
  exceptions, 81 re-engagements, **0 would-reply-after-opt-out**.
- Adversarial corpus (80 cases): 80/80 on ALL six metrics. Golden
  sequences 4/4. Natural-response shadow: 12/12 compliant validated, 12/12
  hostile rejected, 3/3 suppression gates.
- Manual stratified inspection (14 unique samples across 11 strata; bodies
  reviewed read-only, never persisted): verdicts correct or conservative in
  13/14; the 14th exposed the "years ago" false-suppression defect — fixed
  (`7f771dc5`) and the full replay re-run on the fixed code (numbers above).
  Two quality findings recorded, not blockers: (a) the language detector
  can flag short English texts containing "sale" as Spanish ("sale" is
  Spanish vocabulary) — fail-safe direction, since non-English threads
  without a matching template route to human review; (b) "not in
  foreclosure" still pushes condition_disclosed via a pre-existing
  condition phrase (conservative lane; noted for a future negation sweep).

## 10. Test reality (hermetic, this machine)

Baseline at the pristine merge SHA `c83488d1`, clean worktree: **4,767
tests — 4,673 pass, 89 fail, 5 skipped** (90 distinct failure names; the
documented chronic baseline). Branch-suite comparison and any delta are
recorded in the PR body; the gate is ZERO new failures against this
baseline. Known load-sensitive flakes (25s timeouts in
inbound-failure-idempotency and friends) reproduce at the pristine SHA
under CPU contention.

## Still missing / not claimed

- Anything "production-proven": requires the operator-gated runbook
  execution (deploy, migrations, env, internal proof session).
- Live behavioral model-assist scoring (the deterministic layer ships; the
  model seam is deliberately absent until a provider is approved).
- A live natural-response provider credential (path complete, key absent by
  design).
- Real seller burst activation (internal_proof only until the full proof).
- The 19 remaining ontology entries without text detectors (state-layer/
  meta by design, each covered by behavior tests).
- Application-level webhook rate limiting (vocabulary reserved; platform
  protection only).
