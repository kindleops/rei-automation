# Backend Automation Certification Pass — 2026-08-25

Target: `origin/main` @ `c29f5936`, branch `cert/backend-automation-pass`
(worktree `/Users/ryankindle/rei-cert`). Scope: the complete autonomous
seller-conversation pipeline, inbound event → terminal business outcome.

## 1. Architecture traced (actual production path)

```
TextGrid webhook POST /api/webhooks/textgrid/inbound
  → request receipt (webhook_request_receipts) → signature mode (strict default)
  → webhook_log write → message_events upsert (unique message_event_key)
  → claim_inbound_processing RPC on inbound_processing_ledger
      (unique idempotency_key; fail-closed 503 when claim unavailable)
  → buyer fork | seller path
  → context: loadContextWithFallback (outbound-pair first, Podio fallback)
      + orchestrator getDealContextByThread(asOf=inbound_received_at)
      (PR #82 semantics; ambiguous owner ties fail closed to review)
  → burst coordinator (seller_inbound_bursts; 20s debounce / 90s max / 300s
      lease / 5 attempts; safety latch; flush cron * * * * *)
  → classify() — heuristicOnly (AI-assist unreachable from live traffic)
  → run-inbound-intelligence-phase → applyInboundAutomationDecision
      (+ coverage net: canonical_intent / safety_status / exception workflow
       / SLA / safe fallback / scheduled_next_action / coverage_state)
  → resolveSellerStageTransition (S1–S10, authority-gated, monotonic)
  → executeInboundAutomationDecision (template authority → render → optional
      constrained NLG (default OFF) → mode/scope/cap/window gates →
      insertSupabaseSendQueueRow with dedupe_key + idempotency)
  → queue runner (cron * * * * *): reconcile → gates → candidates →
      queue_atomic_claim_send_row RPC (FOR UPDATE, lock_token, 10-min lease)
      → contact window (08:00–21:00 local) → TextGrid send → sent
  → delivery webhook → reconcile_delivery_receipt RPC (rank-monotonic,
      duplicate/out-of-order safe) → delivered/failed_transport/…
  → retries: finalizeSendQueueFailure (+5m, max_retries → paused_max_retries)
  → follow-ups: seller-followup-scheduler (deferred body resolution),
      cancelled on new inbound via INBOUND_TAKEOVER
  → terminal disposition recorded on inbound_processing_ledger
      (10 terminal + reply_deferred_burst pending; deny-nothing mapping)
```

Recovery lanes: `/internal/webhooks/recover-inbound` (*/2, signature
fail-closed), `/internal/seller-flow/recover-inbound` (*/5, metadata-gated,
now with a 5-minute processing-grace window), delivery polling fallback,
burst liveness scanner, ledger SLA scan.

Dead/competing implementations flagged (not on the live path):
`lib/automation/intentMap.js` family, `lib/sms/next_action_from_classification.js`
family, `lib/domain/acquisition/inbound-dispatcher.js` (zero callers),
`autonomous-seller-reply.js` (imported, never invoked),
`deterministic-stage-map.js` (diagnostics only), two diagnostic replay routes
re-implementing stages 5–9.

## 2. Defects found (with root cause)

| ID | Sev | Defect | Root cause |
|---|---|---|---|
| D1 | P0 | Compound "not for sale + question/new property" flattened to silent no-reply (the reported production defect) | `applyOwnershipProbeOverlay` overwrote every not-interested decision; decisions read only `primary_intent`; compound components survived classification but never reached a decision |
| D2 | P0 | No street-address extraction anywhere — second-property signals could not become entities | Missing extractor family |
| D3 | P0 | "123 Main" → $123M; "I live at 1503 Maple Drive" → `asking_price_provided` @0.88 into the auto-reply price lane; times/phones/years/zips parsed as prices, fed into reply personalization | Boundary-free naive `extractPrice` + no street-address negative role in `parseSellerAskingPrice` + `at <4+ digits>` money cue; three independent price parsers |
| D4 | P0 | "Already sold" suppressed the CONTACT (phone-global sms_suppression_list + phones.wrong_number) | Deliberate sold→wrong_number fold in `matchesOwnershipDisconnect`, contradicting the ontology's pairing-scope `sold_property` |
| M1 | P0 | Property-scoped claims (`former_owner_respondent`, `property_specific_non_owner`) wrote phone-level `do_not_text` → `is_suppressed` | Stage-resolver BLOCKING_INTENTS contactability map; evidence gate accepted it via CONFIRMED_WRONG_PARTY |
| D6 | P0 | Every benign inbound fragment cancelled ALL pending outbound (incl. cross-property campaign touches); newer-reply supersession guard unreachable → possible silent reply drop | Burst wirings passed an unknown policy string that fell through to COMPLIANCE_TERMINAL (no type filter); nobody passed `inbound_received_at` |
| D9 | P1 | Provider accept without SID → 5-minute retry → duplicate seller SMS risk | Generic throw classified retryable |
| M11 | P1 | `manual_temperature_lock` write-only; automation overwrote operator temperatures | No reader guard (stage lock had one) |
| M3 | P1 | `is_suppressed` minted from the presentation bucket, bypassing the evidence gate (the 2026-08-04 incident class, different door) | `classify-thread-from-chronology` derived the flag from `inbox_bucket === "suppressed"` |
| M4 | P1 | Unguarded raw `.update(body)` into send-authoritative `deal_thread_state` (opt_out/universal_status/inbox_bucket are hard send blocks) | Cockpit threads PATCH had no allowlist (route has no live callers) |
| D8 | P1 | Active-dedupe unique index lost coverage the moment a row entered `processing` → concurrent duplicate insert window | Partial index status list omitted in-flight statuses |
| D15 | P1/sec | Diagnostics replay route allowed all traffic when `INTERNAL_API_SECRET` unset | `verifyAuth` returned true on missing secret |
| D16 | P2 | Seller-flow recovery cron could double-run an inbound still mid-flight (it takes no idempotency claim) | No minimum-age filter |
| — | P2 | "STOP. Also …" (leading standalone STOP sentence) was NOT an opt-out | Keyword separators excluded sentence punctuation |

## 3. Changes made

Wave 1 — classification/decision (commit `fix(inbound): scope-correct sold/compound handling…`):
- NEW `src/lib/domain/classification/extract-address-signals.js`
- `classify.js`: address-aware price parse + `price_reject_address` role;
  single price truth for `seller_state.price_mentioned` (qualified parse
  only; `extractPrice` removed); structured-parse gate for the unless/but
  branch; `sold_property` live intent (priority, confidence, compound
  family, objection `already_sold`, automation decision, sold/negation
  detector, former-owner rule alignment); "I'd take 250,000" acceptance
  pattern; STOP-sentence separator fix; `address_signals` on every result
- `inbound-intent-ontology.js`: `sold_property` alias + `no_reply_required`
  terminal hint + pairing-scope description
- `canonical-intent-aliases.js`: `sold_property`/`already_sold` →
  `former_owner_respondent` (out of SUPPRESSION_INTENTS)
- `apply-inbound-automation-decision.js`: `resolveCompoundOpportunitySignal`
  + compound lanes (`new_property_opportunity`, `sold_with_new_opportunity`,
  `wrong_person_with_seller_signal`, `declined_but_asks_offer`), sold branch
  (`disposition_property_sold` / `property_sold`, no suppression), overlay
  compound guard, `compound_opportunity` in the decision contract
- `exception-workflows.js`: owned workflows for the new review reasons
- `resolve-seller-stage-transition.js`: property-scoped holds no longer
  write contactability (null patch); `sold_property` blocking entry;
  ownership_patch covers sold
- Cancellation: coordinator + webhook + flush wirings pass
  `INBOUND_TAKEOVER` + `inbound_received_at`;
  `cancel-supabase-pending-outbound.js` fails narrow on unknown policies

Wave 2 — guardrails (commit `fix(guardrails): certification wave 2…`):
- `patch-universal-lead-state.js`: `manual_temperature_lock` enforced
- `textgrid-provider-error-classifier.js` + `process-send-queue.js`: no-SID
  → terminal `provider_ambiguous_accept` manual review
- `classify-thread-from-chronology.js`: evidence-only `is_suppressed`
- `cockpit/threads/[thread_key]/route.js`: field allowlist
- `diagnostics/inbound-replay/route.js`: fail-closed auth in production
- `recover-unprocessed-inbound-messages.js`: 5-minute grace window
- NEW migration `20260825120000_send_queue_dedupe_covers_inflight.sql`
  (extends the active-dedupe partial index over in-flight statuses after
  defusing pre-existing collisions) — **branch-validated only, NOT applied
  to production**; prod apply remains operator-gated

Harness (commit `test(certification): permanent backend certification matrix…`):
- NEW `tests/critical/backend-certification-matrix.test.mjs`
- NEW regression suites: `price-address-disambiguation`,
  `sold-property-scope`, `compound-opportunity-preservation`,
  `inbound-cancellation-policy-scope`, `certification-guardrails-wave2`
- Contract updates (sold → `sold_property`) in
  `classifier-negation-ownership`, `classification-canonical-truth-table`,
  `classification-regression`

## 4. Not-for-sale + alternate-property: before / after

"No that property is not for sale. But what would you pay for 456 Oak Ave?"

| | Before (c29f5936) | After |
|---|---|---|
| Classification | compound preserved but unused | compound preserved AND consumed |
| Decision | `s1_not_for_sale_advance_with_followup`, reply_mode none — question silently dropped | `new_property_opportunity` review; extracted `456 Oak Ave` travels in `decision.compound_opportunity`; property-A nurture still applies via the resolver |
| Suppression | none (already correct) | none |

"I already sold that house" — before: `wrong_number` →
`should_suppress_contact=true` (phone-global suppression + archive);
after: `sold_property` → `disposition_property_sold`, disposition `sold` at
the pairing, contact untouched, deliberate no-reply with durable reason.
"I sold 123 Main, but I own 456 Oak…" → `sold_with_new_opportunity` review.

## 5. Suppression model (scopes as now implemented)

| Scope | Mechanism | Applies when |
|---|---|---|
| Channel/phone (hard) | `sms_suppression_list` phone-global; `inbox_thread_state.contactability_status ∈ {opted_out,dnc,provider_blacklisted,invalid_number,do_not_text}` + `is_suppressed` tuple (evidence-gated) | STOP/unsubscribe (incl. leading STOP sentence, "stop texting me about X" — canonical compliance choice), true wrong-number/wrong-person |
| Sender×recipient pair | `sms_suppression_list` pair rows | provider 21610 blacklist |
| Owner×phone cooldown | `contact_outreach_state.suppression_until` (45d) | any outbound touch |
| Seller×property (pairing) | thread `disposition` (`sold`/`unqualified`) + opportunity state + review hold — **no dedicated store exists** | sold, property-specific non-owner, not-for-sale |
| Message | `send_queue` cancellation (COMPLIANCE_TERMINAL = all types; INBOUND_TAKEOVER = auto_reply/followup only) | opt-out/safety vs benign new inbound |
| Campaign×target | `campaign_targets.suppression_status`, `campaign_target_graph.true_post_contact_suppression` | campaign eligibility |

Soft dispositions (`not_interested`, `need_time`) never write contactability
and are releasable (`latest-intent-precedence`).

## 6. Terminal-outcome model (no silent paths)

Every inbound resolves on `inbound_processing_ledger` to one of:
`reply_sent, reply_deferred_compliance, suppressed_opt_out,
suppressed_wrong_number, suppressed_policy, human_review_required,
duplicate_ignored, no_reply_required, failed_retriable, failed_terminal`
(+ pending `reply_deferred_burst`), via a deny-nothing mapper (unmappable →
human review). Every decision carries `coverage_state ≠ missing_coverage`,
a concrete `scheduled_next_action`, and (for review/suppress) an owned
exception workflow with an SLA. The certification matrix enforces this
invariant on every scenario.

## 7. Matrix results

`CERTIFICATION_MATRIX_METRICS {"total":48,"replied":15,"review":20,
"suppressed":6,"deliberate_no_reply":7,"silent_drops":0,
"wrong_scope_suppressions":0}` — 50/50 assertions green (48 scenarios +
resolver scope matrix + metrics gate).

Full critical suite (post-fix): see §13.

## 8. Concurrency / idempotency

Certified by dedicated suites (inbound claim ledger, atomic queue claim,
duplicate guards, batch dedup, delivery-callback concurrency,
manual-send race): see §13 bundle result. Structural guarantees:
DB-level unique `idempotency_key` + run-fenced completion for inbound;
`queue_atomic_claim_send_row` FOR-UPDATE claim with lock tokens;
rank-monotonic delivery reconciliation; dedupe_key uniqueness now covering
in-flight statuses (pending prod migration).

## 9. Delivery / retry

Transient failures retry at +5m up to `max_retries` → `paused_max_retries`
(operator-visible, cockpit reprocess). Terminal provider classes map to
`failed_transport/carrier_blocked/opted_out/invalid_number`. Ambiguous
no-SID accepts are now terminal manual review (duplicate-send fail-safe).
Crash-mid-send rows land `expired/processing_lease_expired_manual_review`
— a deliberate fail-safe against blind requeue duplicates (the stale-lock
recycler above it is dead code; documented).

## 10. Review / escalation

Review is always durable: `human_review_reason` + owned exception workflow
+ SLA deadline + `inbound_intelligence_audit` row + thread state. New
compound lanes route to `conflicting_property_identity` /
`identity_clarification` / `ambiguous_context` workflows. Safe clarifier
sends only for ≤4-word ambiguous replies with no compliance/objection risk.

## 11. Remaining limitations (not concealed)

1. **No seller×property suppression store.** Pairing-scope semantics ride
   on thread disposition + opportunity state + review lanes. A multi-property
   seller on ONE phone still shares one thread state.
2. **M5**: the send-time terminal-intent scan is phone-global over the last
   50 events. New sold events (`sold_property`) no longer phone-block, but
   HISTORICAL sold texts recorded as `wrong_number` still do —
   **production data remediation required** (operator-gated): re-classify
   historical sold→wrong_number suppressions in `sms_suppression_list` /
   `phones` / `inbox_thread_state`.
3. **M2**: `disposition=not_interested` still presents as suppressed in
   inbox predicates (`isSuppressedContact`) — display-layer scope conflation
   left unchanged deliberately (UI count-contract risk; needs a coordinated
   dashboard change).
4. **M7**: a negative reply cancels queued outbound owner-wide (deliberate
   conservative stop; cancellation only, no state write).
5. **M10/M13**: enqueue-time checks are narrower than send-time (send-time
   fails closed); three non-send suppression readers fail open.
6. Multi-price/multi-property messages: first qualified price wins.
7. `already_listed`/`under_contract`/vacant/estate lanes resolve via review
   or generic lanes — no dedicated reply automation.
8. Migration `20260825120000` and all fixes are **NOT deployed**; prod
   deploy + migration apply remain operator-gated per repo process.
9. Pre-existing baseline failures (also failing at pristine `c29f5936`):
   `supabase-sms-runtime` (2), `workflow-studio-event-enrichment` (1
   stale `classify_js_v1` version-prefix assertion), plus any others noted
   in §13.
10. Live-fire (real provider) certification is outside this pass: the
    proof/canary machinery exists and remains gated (queue paused, canary
    scoped) per operator runbooks.

## 12. Verdict

**BACKEND AUTOMATION NOT CERTIFIED** — code-level invariants now hold and
are permanently enforced (zero silent drops, zero wrong-scope suppressions,
zero non-flaky regressions), but certification requires operator-gated steps
this pass cannot take, plus resolution of the pre-existing red baseline:

1. None of these fixes are deployed; production still runs the defective
   code paths (compound flatten, sold→contact suppression, price hijack,
   over-cancellation).
2. Migration `20260825120000` (in-flight dedupe uniqueness) is not applied —
   the duplicate-insert window remains open in production until it is.
3. Historical production data still holds wrong-scope suppressions from the
   sold→wrong_number era (sms_suppression_list / phones /
   inbox_thread_state / message_events.detected_intent feeding the
   phone-global terminal-intent scan) — operator-gated data repair required.
4. 91 pre-existing failing tests in the critical suite (verified identical
   at pristine `c29f5936`), including the inbound-stage-lifecycle /
   replay-handlers webhook families and the idempotency-record failure-
   marking contract — outside this pass's blast radius but inside the
   certification bar.
5. Live-fire (real provider) end-to-end certification remains gated behind
   the canary/proof machinery per operator runbooks.

Re-certification path: merge + deploy this branch, apply the migration,
run the data repair, triage the 91 baseline failures, then rerun
`backend-certification-matrix` + the full critical suite.

## 13. Suite results + commits

Baseline (pristine `c29f5936`, full critical suite):
**6019 tests — 5923 pass / 91 fail / 5 skipped.**

Post-fix (branch `cert/backend-automation-pass`):
- Full suite: **6105 tests — 5994 pass / 106 fail** (contended run, before
  contract alignment). After aligning the 11 old-contract tests, re-running
  all 42 previously-failing files: **92 distinct failures, of which 91 are
  the EXACT baseline set** (name-level match) and 1
  (`discord-command-center :: feeder auto scan ranks best offset`) passes
  53/53 in isolation — a CPU-contention flake.
- Net: **0 non-flaky regressions; +86 new tests, all green** (6 new suites:
  price-address-disambiguation, sold-property-scope,
  compound-opportunity-preservation, inbound-cancellation-policy-scope,
  certification-guardrails-wave2, backend-certification-matrix).
- Certification matrix: 50/50 —
  `{"total":48,"replied":15,"review":20,"suppressed":6,
  "deliberate_no_reply":7,"silent_drops":0,"wrong_scope_suppressions":0}`.
- Concurrency/idempotency bundle: 95 tests — 90 pass; all 5 failures verified
  pre-existing at baseline (3 idempotency-record marking, 2 claim-containment
  order/contention-sensitive).
- Lint (`npm run lint`): pass.

Hard-target scorecard (deterministic scope of this pass):
silent drops 0 · wrong-property mutations 0 · wrong-seller mutations 0 ·
incorrect global suppressions 0 (new events; historical data pending repair)
· duplicate business effects 0 (code paths; prod migration pending) ·
unexplained terminal paths 0 · unhandled inbound exceptions 0.

Commits (branch `cert/backend-automation-pass`, base `c29f5936`, worktree
`/Users/ryankindle/rei-cert`, working tree clean apart from this report):
- `28d29f55` fix(inbound): scope-correct sold/compound handling,
  price-address truth, narrow cancellation
- `92352581` fix(guardrails): certification wave 2
- `f7219937` test(certification): permanent backend certification matrix
- `16c54437` test(certification): sold-family contract alignment

Test commands:
```
cd apps/api
npm run test:critical            # full gate (lint + 411 critical files)
node --import ./tests/register-aliases.mjs --test \
  tests/critical/backend-certification-matrix.test.mjs   # the matrix alone
```
(with the standard NODE_ENV=test + stub-secret env vars from package.json)
