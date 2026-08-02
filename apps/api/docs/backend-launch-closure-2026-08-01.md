# Backend Launch Closure — 2026-08-01 (rev 2, post-review)

Branch: `launch/backend-closure` (PR #62). Two lanes: (A) internal live
automation proof via a bounded, fail-closed contact-window override; (B)
seller messaging intelligence and state-transition hardening. Rev 2
incorporates the full PR #62 review closure (17 threads), the classifier
negation fix, the policy-constrained response layer, and the full-corpus
replay.

**Status contract of this document.** Every capability below is placed in
exactly one of five buckets — *implemented* (code exists on the branch),
*tested* (focused deterministic tests pass), *replay-observed* (exercised
against historical production data, read-only), *production-proven* (observed
working in live production traffic), or *still missing*. *The backend is NOT
complete*: §5 lists what remains absent, and nothing in this document claims
otherwise.

## 1. Architecture map (inbound spine)

```
TextGrid webhook  POST /api/webhooks/textgrid/inbound (route.js)
  → webhook_log (raw HTTP payload; http_received_at stamped once at receipt)
  → handleTextgridInboundWebhook  ← DISPOSITION CHOKE POINT (wrapper)
      → idempotency claim (runtime-state store; ledger row written in parallel;
        no-SID key = from|to|body|provider-receipt-hint — retry-stable)
      → message_events (first pass) → unknown-inbound router (no-context branch)
      → burst coordinator (SELLER_INBOUND_BURST_ENABLED; claim RPC)
      → classify() [deterministic heuristics; negation scope BEFORE ownership]
      → processSellerInboundMessage
          → facts extraction → intelligence phase → resolvers
          → executeInboundAutomationDecision
              → latest-intent precedence (resolvePriorThreadState: nested
                summary → context.summary → flat fallback) → suppression gates
              → template select/render → natural-response wording layer
                (env-gated OFF; validated substitution only; deterministic
                 fallback) → queue write (internal-phone quarantine stamp)
          → follow-up scheduler → buildSellerFlowDecision
          → patchUniversalLeadState (single authoritative state writer;
            offer_interest advance gated on reopen_conversation=true)
      → message_events second pass → notifications/audit
  → terminal disposition recorded to inbound_processing_ledger
     (count-verified; zero-row update = failure + P0 alert)
Dispatch: cron * * * * * → /api/internal/queue/run → claim RPC (mode-gated)
  → contact window (internal-proof bypass: audit write is part of the gate —
    a thrown/zero-row audit write DENIES the bypass and defers)
  → compliance re-check → TextGrid → delivery webhook.
Retention: daily /api/internal/inbound/ledger-retention-purge cron.
```

## 2. Implemented AND tested (deterministic tests pass on this branch)

Everything in this section is *implemented* and *tested*; nothing in it is
production-proven.

- **Terminal-disposition contract** — ten canonical dispositions; wrapper at
  the handler choke point; ledger writes are count-verified
  (`ledger_row_missing` on zero rows) and the wrapper raises the
  always-critical `inbound_no_disposition` alert on record failure. The
  wrapper test genuinely drives a throwing core handler.
- **Latest-intent precedence on the live context shape** —
  `resolvePriorThreadState` (nested `latestThreadContext.summary` →
  `context.summary` → flat compatibility fallback) at every call site. The
  canonical "Not interested." → "Are you still interested in buying?" flow is
  proven against the exact live nested object: re-engagement detected, prior
  state superseded, automation resumed, `new_reply`, temperature raised,
  lifecycle reopened, `contextual_reply_required`.
- **Reversal semantics** — a fresh decline over stale positive state pauses
  automation, sets `not_interested`/`paused`/`cold`, and can never advance
  `lifecycle_stage` to an interest stage; only `reopen_conversation=true`
  advances. End-to-end persistence test through the full pipeline.
- **Soft-suppression release** — lookups normalized to writer E.164; zero-row
  release fails and fail-safes the reopen patch away; binding opt-outs never
  auto-clear; unknown reasons fail closed; post-STOP seller contact routes to
  human review only.
- **Classifier negation (was the launch blocker)** — negation scope evaluated
  before positive ownership matching. "That's not my house", "wrong house",
  "I never owned it", "I sold that property", "My mother owns it, not me",
  Spanish and typo/slang/compound variants can no longer resolve
  `ownership_confirmed`; they route to the correct suppression/correction/
  unclear lanes. 85-case negation suite + 9 positive controls, all passing.
- **Ontology coverage from the real vocabulary** — `classify.js` exports
  `INTENT_PRIORITY`; load-time validation enforces exactly-one ontology
  registration per live label (including `unclear`); hand-copied mirrors
  removed.
- **Adversarial corpus with real assertions** — all 68 cases assert
  `intent_any_of` AND `disposition_any_of`; six distinct metrics (disposition
  coverage, intent accuracy, disposition accuracy, re-engagement accuracy,
  suppression safety, state-transition accuracy) all at 100% — achieved by
  fixing 11 classifier gaps the corpus caught, not by weakening expectations
  (label corrections carry inline justifications).
- **Internal-proof session** — repeated `open-session` preserves the original
  first-open timestamp; hard absolute cap (240 min, drift-guarded constant)
  enforced from it; `close` surfaces read errors and only reports "expired"
  after the expiry write is read back; runbook `stamp-reply` is a conditional
  `count:'exact'` update on the observed queue status that aborts if the row
  transitioned. Known residual: a metadata-only concurrent write (status
  unchanged) could still be clobbered — PostgREST cannot express a jsonb
  merge; server-side merge RPC is the follow-up.
- **Contact-window bypass audit integrity** — a thrown or zero-row audit
  write denies the bypass, defers the row, never finalizes a transport
  failure, never writes an outbound failure event, never calls TextGrid.
- **Queue no-send predicate derivation** — `isProofOrNoSendQueueRow` =
  `hasAbsoluteNoSendMarkers ∪ hasQuarantineMarkers`; the absolute list exists
  in exactly one place and is checked before the internal-canary exception.
- **PII minimization + retention** — ledger stores `body_sha256`+`body_length`
  (never raw text), indexed `retain_until` (receipt + 30 days, documented in
  the migration COMMENTs and `INBOUND_LEDGER_RETENTION_DAYS`), daily bounded
  purge route; replay reports redact bodies by default (raw only behind
  `--include-raw-bodies` with a printed privacy warning; reports gitignored).
- **No-SID idempotency** — key = `from|to|body|receipt-hint` from
  provider/route-supplied fields only (never `new Date()`): same request
  retried → same key; same text later → different key; SID path unchanged.
- **SLO scan parameter clamping**; **sentence-boundary regex** (decimals,
  currency, repeated punctuation, multiline).
- **Policy-constrained natural response layer** (`natural-response-engine.js`
  + wiring behind `renderSafeTemplate`) — see §4 for its exact status.

## 3. Replay-observed (read-only, historical production data)

Full-corpus replay (rev 2): **all 1,232 historical inbound events**
(2026-04-23 → 2026-07-30) — the complete corpus, not the 400-newest slice rev
1 used — plus a thread-aware pass carrying state turn-to-turn through the
live nested context shape, the 68-case adversarial corpus, and scripted
golden sequences. Numbers in §replay-results below. Seller text is never
written to reports (SHA-256 prefixes + lengths only).

Replay observation is NOT production proof: replay exercises the decision
engine against recorded inputs; it does not exercise transport, delivery,
webhooks, or concurrent production state.

## 4. Implemented and tested but NOT production-proven

- **Natural-language response generation** — implemented behind the
  deterministic reply-policy seam and fully tested (schema/confidence/
  invented-numeric/prohibited-claim/unapproved-fact/language/mechanical-
  restart/length validation; suppression hard-gate; audit output; golden +
  adversarial scenario matrix). BUT: env-gated OFF, no model provider is
  configured in production, and no generated reply has ever been sent. Until
  a provider is configured, canaried, and observed live, production behavior
  is the deterministic template path, byte-identical to before.
- **The entire inbound intelligence spine on live traffic** — every item in
  §2 is proven by deterministic tests and (where applicable) replay; NONE of
  it has processed live production traffic on this branch. The branch is not
  deployed; the ledger migration is not applied.
- **Internal-proof runbook** — sequence intact (§7), hardened this pass;
  never executed end-to-end (operator-gated).

## 5. Still missing (the backend is NOT complete)

1. **Live behavioral/sentiment scoring** — the analysis contract's behavioral
   estimates remain `{value:null, scorer:"unscored"}` by design; no scoring
   model exists.
2. **Detector coverage for required high-value intents** — the negation/
   ownership family is now covered, but ontology intents still lack live
   detectors (probate/trust/LLC/title/lien detail, language_switch,
   voicemail_call_request, …) — enumerated by
   `listIntentsWithoutClassifierCoverage()`.
3. **Durable database-backed idempotency enforcement** — the ledger is
   observability + SLA authority; the ENFORCEMENT layer is still the
   per-instance `/tmp` runtime store. Swap enforcement to the ledger.
4. **Durable disposition recording for route-level rejects** — invalid
   signature/payload rejects at the route still terminate before the wrapper
   and are log-only.
5. **Synchronized state transitions on live traffic** — proven on the live
   nested shape in tests and replay; not observed in production.
6. **Burst aggregation production proof** — `SELLER_INBOUND_BURST_ENABLED`
   unset in prod; the burst leg has never run live.
7. **Complete send → inbound → reply → state update chain proof** — blocked
   on operator-gated deploy + migration + runbook execution (§7).
8. **Natural-response live provider** — see §4.
9. **Runbook metadata jsonb-merge RPC** — closes the residual concurrency
   window in §2's internal-proof item.

## 6. Test reality (hermetic baseline, this branch)

`npm run test:critical` in a clean worktree at PR head `0f018cd1`: 4,613
tests, 4,519 pass, **89 fail** (91 distinct failure names; dominated by
`queue-run-finalization`, `queue-run-selection`, `inbound-stage-lifecycle`;
includes `launch-critical-alerting`'s stale wrapper-count assert). This is
the honest reproducible baseline — larger than the "19 known red tests" rev 1
claimed, because rev 1 counted only the files it had inspected. The review
pass reproduced the same failure set at the final head (see PR #62 report);
new failures introduced by this branch: none.

## 7. Production activation sequence (internal proof — operator-gated)

Unchanged from rev 1 (§13 there): burst env (optional) → deploy with
`DEPLOY_GIT_SHA` → apply `20260801060000` migration (NOTE: rev 2 edited this
still-unapplied migration — digest columns + retention) → runbook
open-session/arm/mint/fire/verify/stamp-reply/mint-reply/fire-reply/close.
All commands one-per-step in `scripts/ops/internal-proof-runbook.mjs`.

## Replay results (full corpus, rev 2)

Runner: `scripts/ops/inbound-full-replay.mjs` (read-only; bodies redacted —
SHA-256 prefixes + lengths only; report artifacts gitignored).

**Bulk (context-free) pass** — 1,232 events fetched (the complete corpus,
2026-04-23 → 2026-07-30), 1,200 replayed (32 internal-canary excluded):
- terminal-disposition coverage **100.00%**, engine exceptions **0**, silent
  drops **0**, suppression violations **0**;
- disposition histogram: 570 human_review_required / 343 no_reply_required /
  203 suppressed_opt_out / 84 suppressed_wrong_number (would-reply outcomes
  deterministically degrade to review without thread/template context — the
  human-review share is a replay artifact, not production routing);
- intent agreement vs the historically recorded labels: **88.42%** of 1,192
  labeled events; processing latency p50 **18 ms** / p95 **29 ms**;
  low-confidence rate 0.00% (heuristic confidences are calibrated ≥0.6).
- Stratification: language 1,041 English / 150 Spanish / 9 other; message
  length 435 ≤5 chars / 370 6–20 / 282 21–60 / 113 longer; thread age 987
  &gt;60 d / 146 31–60 d / 67 ≤30 d; market proxy spread across 60+ area codes
  (top: 317, 209, 401, 404, 918).

**Thread-aware pass (state carried turn-to-turn through the live nested
`summary` shape)** — 943 threads, 150 multi-turn, 1,200 turns: **0
exceptions, 81 re-engagements detected, 0 would-reply-after-opt-out.**

**Adversarial corpus (68 cases)** — terminal disposition 68/68; expected
intent 68/68; expected disposition 68/68; re-engagement 5/5; suppression
safety 22/22; state transitions 68/68.

**Golden sequences (state carried turn-to-turn)** — 4/4:
re-engagement-after-decline, reversal-after-interest,
stop-then-seller-initiated (human review only, no auto reply),
need-time-follow-through.

**Manual review of the 144-event intent-disagreement sample** (12.1% of
labeled events, stratified by historical label): four systematic classes —
(1) context-free conservative degradation (`ownership_confirmed` → `unclear`,
37×; safe direction); (2) vocabulary folds into suppression lanes
(`property_specific_non_owner`/`tenant_respondent`/`former_owner_respondent`
→ `wrong_number`/`tenant_occupied`, ~31×; finer canonical labels are derived
downstream); (3) replay improvements over history (historical `unclear` →
specific intents, ~22×; plus 5 historical opt_out labels that were actually
lender spam / rental clarifications / a seller offering another property);
(4) **a real defect: compound/embedded opt-outs** ("NFS. Stop", "No stop",
"NOT for sale. STOP !!!", "please stop communication", "remove my name and
number…") classified as soft reopenable declines — **fixed this pass**
(guarded sentence-final STOP rule + remove-me phrases; suite + 126-test
consumer sweep green; the numbers above include the fix).
