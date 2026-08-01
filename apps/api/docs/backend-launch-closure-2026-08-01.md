# Backend Launch Closure — 2026-08-01

Branch: `launch/backend-closure`. Two lanes: (A) internal live automation proof
via a bounded, fail-closed contact-window override; (B) seller messaging
intelligence and state-transition hardening. This document is the deliverables
record.

## 1. Architecture map (inbound spine)

```
TextGrid webhook  POST /api/webhooks/textgrid/inbound (route.js)
  → webhook_log (raw HTTP payload)
  → handleTextgridInboundWebhook  ← DISPOSITION CHOKE POINT (new wrapper)
      → idempotency claim (runtime-state store; ledger row now written in parallel)
      → message_events (first pass) → unknown-inbound router (no-context branch)
      → burst coordinator (SELLER_INBOUND_BURST_ENABLED; claim_seller_inbound_burst RPC)
      → classify() [deterministic heuristics only, classify_js_context_v2]
      → processSellerInboundMessage
          → facts extraction → intelligence phase → authority/conversation/stage resolvers
          → executeInboundAutomationDecision
              → latest-intent precedence (NEW) → suppression gates → template select/render
              → insertSupabaseSendQueueRow (queue write; internal-phone quarantine stamp NEW)
          → follow-up scheduler → buildSellerFlowDecision
          → patchUniversalLeadState (single authoritative state writer → inbox_thread_state
            + universal_lead_state_events audit; blocked results now surfaced)
      → message_events second pass (authoritative fields) → notifications/audit
  → terminal disposition recorded to inbound_processing_ledger (NEW)
Dispatch: cron * * * * * → /api/internal/queue/run → claim RPC (mode-gated, in-DB)
  → contact window → compliance re-check → TextGrid → delivery webhook.
```

Auto-replies are dispatched by the queue cron through the full send path
(contact window included). `queueAutoReply.js` and
`maybe-queue-seller-stage-reply.js` are legacy/test-only — the live writer is
`executeInboundAutomationDecision`.

## 2. Silent-drop paths found (and status)

| # | Path | Status |
|---|------|--------|
| 0 | `x-inbound-debug-stage` header: unauthenticated short-circuit of the public webhook at 13+ checkpoints, bypassing signature checks with zero persistence | **FIXED** — honored only outside production or with `x-internal-api-secret` |
| 1 | Idempotency/disposition ledger in `/tmp` (per-instance, ephemeral on Vercel) | **MITIGATED** — durable `inbound_processing_ledger` now records every attempt + disposition; enforcement swap of the claim itself is a follow-up |
| 2 | Empty `catch {}` around unknown-router Podio fallback write | **FIXED** — warns |
| 3 | Pre-idempotency early returns (missing from, empty body) persisted nothing | **MITIGATED** — wrapper records `failed_terminal` / `human_review_required` dispositions |
| 4 | ~30 warn-only swallowed exceptions in the handler (incl. authoritative 2nd-pass message_events write) | Documented; wrapper guarantees a disposition regardless |
| 5 | `patchUniversalLeadState` blocked results ignored — lifecycle/status/temperature silently not written | **FIXED** — surfaced + logged |
| 6 | `universal_lead_state_events` audit write failure console-only | Documented (state row still lands) |
| 7 | webhook_log write failure downgrades lane silently | Documented |
| 8 | Invalid-payload/signature rejects recorded nowhere queryable | **MITIGATED** — dispositions recorded at the wrapper for handler-reached traffic; route-level rejects remain log-only (follow-up) |
| 9-12 | Unknown-router dedupe-key divergence; unconditional `ok:true` unknown-router; partial-commit in the podio_write segment; burst edge cases | Documented as follow-ups |

## 3. Canonical analysis schema

`lib/domain/inbound/inbound-analysis-contract.js`
(`inbound_analysis_contract_v1`): deterministic surface signals (counts,
punctuation/caps intensity, emoji, latency, thread timing), intent block
(classifier + secondary + compliance + confidence + version), precedence block
(re-engagement / reversal / supersession + evidence), reply-policy block.
Behavioral estimates (sentiment, hostility, trust, motivation, sale readiness,
…) are explicitly `{value:null, scorer:"unscored"}` until a real scoring model
is wired — message length does not reveal psychology, and this contract refuses
to pretend otherwise.

## 4. Terminal-disposition contract

Ten canonical dispositions (`terminal-disposition.js`), enforced by:
- the wrapper at the handler choke point (every exit + thrown exception);
- `inbound_processing_ledger` (DB CHECK: completed ⇒ disposition NOT NULL);
- `/api/internal/inbound/disposition-slo-scan` cron (*/5) raising the
  always-critical `inbound_no_disposition` launch alert on SLA breach (10 min)
  or exhausted retries (60 min) — including when the scanner itself fails.

## 5. Intent ontology

`inbound-intent-ontology.js`: 74 canonical intents, every current classifier
label/alias mapped exactly once, compound intents preserved, per-intent reply
policy + state hints + compliance semantics (`not_interested` non-binding;
`opt_out` binding; `seller_initiated_after_stop` human-only). 26 intents have
no live detector yet — the highest-value gaps (re-engagement family) are
covered by the precedence pattern detector; the rest are enumerated by
`listIntentsWithoutClassifierCoverage()`.

## 6. Authoritative state transitions

`patchUniversalLeadState` remains the single writer for
lifecycle/status/temperature/disposition/contactability, audited per-field in
`universal_lead_state_events` with message/classifier/resolver provenance.
Precedence supersessions flow through that same patch (never a parallel
writer). Blocked patches are now loudly surfaced. Idempotency: per-turn patches
derive from the same decision object; the ledger records the processing run.

## 7. Re-engagement / latest-intent precedence

`latest-intent-precedence.js` (`latest_intent_precedence_v1`):
- positive-over-stale-negative supersession (the canonical
  "Not interested." → "Are you still interested in buying?" scenario reopens
  the conversation: disposition `interested`, status `new_reply`, temperature
  warm/hot, automation resumes, soft suppression released);
- reversal (clear decline supersedes stale positive; automation pauses);
- need-time follow-through resumes;
- send-time ordering beats arrival order (delayed/reordered webhooks cannot
  supersede newer state);
- binding opt-outs never auto-clear; positive-after-stop → human review as
  `seller_initiated_after_stop`; unknown suppression reasons fail closed;
  soft-suppression release is allow-listed, and a failed release keeps the
  thread suppressed.

## 8. Response policy vs wording

Policy (whether/what/escalation) lives in `applyInboundAutomationDecision` +
the ontology reply_policy hints and is fully deterministic. Wording is the
template layer (`selectSafeAutoReplyTemplate`/`renderSafeTemplate`) —
deterministic, compliance-safe. A natural-language generation layer with
policy-constrained facts was deliberately NOT shipped tonight: shipping an
unreviewed generative reply path during launch closure would violate the
never-hallucinate constraint. It is a scoped follow-up behind the existing
policy interface.

## 9-10. Replay harness + coverage

- Engine: `inbound-replay-engine.js` (classify → dry-run decision → precedence
  → disposition; no sends, no writes).
- Adversarial corpus: 68 cases / 26 categories
  (`tests/fixtures/inbound-adversarial-corpus.mjs`), enforced by
  `inbound-adversarial-replay-coverage.test.mjs`: 100% terminal disposition,
  0 exceptions, 0 opt-out replies, 0 wrong-number replies, re-engagement and
  reversal expectations all pass.
- Historical replay (read-only, 400 newest prod inbound events, internal
  canary excluded): **100% terminal disposition, 0 engine exceptions, 0
  invariant violations**; histogram 208 human_review / 99 no_reply / 49
  opt_out / 23 wrong_number (the human_review share reflects context-free
  replay, not production routing).

## 11. Manually reviewed error categories

- **Negation-blind ownership matcher (real defect):** "That's not my house" →
  `ownership_confirmed` @0.9 (historical classification agreed — live bug, not
  a replay artifact). Mitigated today by pre-send eligibility/ownership gates;
  must be fixed in the classifier before UI acceptance.
- Conservative degradation without thread context: 11× historical
  `ownership_confirmed` → replay `unclear` (context-free replay artifact).
- Improvements over history: "Make me an offer." unclear→`asks_offer` @0.98;
  "I am interested." unclear→`latent_interest`.
- Vocabulary folds consistent (`property_specific_non_owner`→`wrong_number`,
  `tenant_respondent`→`tenant_occupied`).
- Spanish handled for price/opt-out/decline; "Porque" → `who_is_this` @0.85 is
  borderline but matches history.
- Bulk classes agree exactly (94 not_interested, 49 opt_out, 43
  ownership_confirmed, 14 wrong_number).

## 12. Remaining launch blockers

1. **Deploy + migration + proof execution** (operator-gated; see §13).
2. Negation-blind `ownership_confirmed` (above).
3. `/tmp` idempotency still the enforcement layer (ledger is observability +
   SLA authority); swap enforcement to the ledger next.
4. Route-level webhook rejects (invalid signature/payload) not yet ledgered.
5. 26 ontology intents without detectors (probate/trust/LLC/title/lien detail,
   language_switch, voicemail_call_request, …).
6. Natural-language reply generation (policy interface ready, generator not
   built).
7. Behavioral scoring model for the analysis contract's unscored estimates.
8. Burst aggregation disabled in prod (`SELLER_INBOUND_BURST_ENABLED` unset) —
   the burst leg of the chain proof needs it.
9. Pre-existing red tests on main (queue-run-selection 9, containment 2,
   canary-e2e classify 2, orchestration 6) — unchanged by this branch.

## 13. Production activation sequence (internal proof)

All commands from `apps/api`. Steps 1–2 are operator-gated (permission
classifier blocks them for the agent); everything after is one runbook command
per step.

1. *(optional, enables the burst leg)* `vercel env add SELLER_INBOUND_BURST_ENABLED production` → `true`
2. Deploy this branch: `vercel deploy --prod --yes --build-env DEPLOY_GIT_SHA=$(git rev-parse HEAD)` and confirm `/api/version` reports the sha.
3. Apply the ledger migration (additive, one txn): `psql "$SUPABASE_DB_URL" -1 -f supabase/migrations/20260801060000_inbound_processing_ledger.sql` (+ record in `supabase_migrations.schema_migrations`).
4. `node scripts/ops/internal-proof-runbook.mjs open-session` (2h hard expiry, pinned targets).
5. `node scripts/ops/internal-proof-runbook.mjs arm` (guarded scheduled_for pull while paused, then mode → scoped_canary_only).
6. `node scripts/ops/internal-proof-runbook.mjs mint` → prints RUN_ID/TOKEN.
7. `node scripts/ops/internal-proof-runbook.mjs fire --run-id … --token …` → one SMS to +16128072000.
8. `verify` after send, after delivery receipt, and after the handset reply.
9. Reply leg: `stamp-reply` → `mint-reply` → `fire-reply --row-id … --run-id … --token …`.
10. `node scripts/ops/internal-proof-runbook.mjs close` (mode → paused, session expired) — immediately after proof.
