# Automation Activation-Readiness Audit

Branch: `feat/automation-activation-readiness` · Baseline: `origin/main` @ `b49c0f8419e3b6d03b36e95b141017ffc1393380` (PR #16 merge, 2026-07-10T05:50Z)

Deployment findings (2026-07-11):

| Surface | Evidence | SHA / build |
|---|---|---|
| Dashboard (`ops.leadcommand.ai`) | `/api/version` | `b49c0f8419e3…` — identical to origin/main |
| API (`api-steel-three-96.vercel.app`) | `/api/version` | commit not exposed (`unknown`); deployment `dpl_AMP4QqGx3xcRbQ2NL8CoeMNmXHqX`, built 2026-07-10T05:53:13Z — 3 minutes after the b49c0f84 merge, consistent with the PR #16 merge commit |

Everything below cites current-main code, not intentions.

---

## 1. Canonical state source of truth

**`inbox_thread_state` (keyed by canonical E.164 `thread_key`) is the single canonical lifecycle state row.** Canonical columns were added by
`apps/api/supabase/migrations/20260627120000_universal_lead_state.sql`: `lifecycle_stage`, `operational_status`, `lead_temperature`, `disposition`,
`contactability_status`, per-field `*_source` attribution, `manual_stage_lock`, `manual_temperature_lock`, `temperature_reason`, `temperature_confidence`,
plus legacy mirrors (`stage`, `status`, `seller_stage`, `conversation_status`, `temperature`).

**Canonical write service:** `patchUniversalLeadState()`
(`apps/api/src/lib/domain/lead-state/patch-universal-lead-state.js`):

- normalizes legacy field aliases → canonical (`normalizePatchToCanonical`, registry line 445);
- non-manual writers cannot override `manual_stage_lock` and cannot regress stage (monotonic guard, lines 233–246);
- mirrors every canonical write into the legacy columns so old readers stay consistent (`buildRowPatch`);
- writes a per-field audit trail to `universal_lead_state_events` (field, previous/new value, operator, `source_view`, `reason`, `change_source`, metadata);
- suppression flows from blocking contactability codes (`BLOCKING_CONTACTABILITY`).

**Enum registry:** `apps/api/src/lib/domain/lead-state/universal-lead-state-registry.js` — lifecycle (10), operational status (9),
temperature (4), disposition (10), contactability (6), `STATE_SOURCE_CODES` (`ai|manual|system|autopilot`), alias maps, and
`isAllowedLifecycleTransition` (forward-only, `closed` reachable from anywhere). The dashboard has a mirror copy.

### 1a. ⚠ Stage 7/8 ordering discrepancy (decision required — not changed by this branch)

The mission brief lists the lifecycle as `…6. Formal Contract, 7. Dispo, 8. Under Contract With Buyer, 9. Escrow, 10. Closed`.
The deployed canonical registry (and every persisted row, the dashboard mirror, and the transition resolver) orders it:

```
7. under_contract   (label "Under Contract")      ← seller contract executed
8. disposition      (label "Disposition")
9. prepared_to_close (label "Prepared to Close")  ← brief calls this stage "Escrow"
```

Reordering S7/S8 (or renaming S9) is a data + UI + resolver migration touching persisted `lifecycle_stage` values. Per the
"do not change the canonical ten-stage lifecycle" constraint, this branch keeps the registry as deployed and flags the
discrepancy for an explicit product decision. Nothing in Stages 1–6 automation depends on the S7/S8 order; stages ≥7 only
advance from authoritative operational events in either ordering.

## 2. All lifecycle state writers (current main)

Callers of the canonical service (compliant):

| Writer | Source value | Path |
|---|---|---|
| Manual operator edits | `manual` | `app/api/cockpit/lead-state/patch/route.js` → `patchUniversalLeadState` (full meta: operator, source_view, reason, locks) |
| Seller inbound automation | `autopilot` | `process-seller-inbound-message.js:899` |
| Gap recovery sweeper | `system` | `recover-seller-execution-gaps.js` |
| Inbound webhook flow | — | `lib/flows/handle-textgrid-inbound.js` |
| Opportunity service, notification executor, cockpit service | various | see grep of `patchUniversalLeadState` callers |

Direct writers that bypass the canonical service (the launch gap this branch fixes):

| Offender | What it writes | Risk |
|---|---|---|
| `lib/domain/automation/automation-actions.js:532` | legacy `stage`/`status`/`next_action`/`last_intent` upsert, `updated_by: automation_engine` | Ignores `manual_stage_lock`; writes legacy mirrors without canonical columns → view drift; no audit row |
| `app/api/internal/dashboard/inbox/thread-state/route.js` (PUT) | `is_read`/`is_archived` (+ `read_at`, not canonical `last_read_at`) | No audit trail; column drift (`read_at` vs `last_read_at`) |
| `lib/supabase/sms-engine.js` (4 sites) | message-projection fields only (`latest_delivery_status`, `latest_direction`, `disposition`, `is_suppressed`, unread counters) | Delivery/thread projection, not lifecycle — acceptable, but `disposition` writes skip audit |
| `lib/domain/inbox/live-inbox-service.js:2180` | `inbox_bucket`/`automation_lane` cold transition | Bucket taxonomy, not lifecycle — acceptable |
| `app/api/cockpit/properties/[id]/push-to-underwriting/route.js:76` | thread-state upsert on manual push | Narrow; audited via its own flow |

Verdict: the canonical owner is **unambiguous** (no stop condition); two writers need rerouting through the service
(`automation-actions.js`, internal thread-state PUT), and provenance meta needs the classifier/extractor version fields.

## 3. Inbound pipeline (evidence-verified)

```
POST /api/webhooks/textgrid/inbound
  → lib/flows/handle-textgrid-inbound.js         (persist message_events, negative-reply queue cancel,
                                                   classification, thread-state projection sync)
  → processSellerInboundMessage()                 (lib/domain/seller-flow/process-seller-inbound-message.js)
      1. cancelPendingFollowUpsForThread()        ← inbound takeover BEFORE classification (line 395)
      2. classify(message, brain)                 ← classify.js — the ONLY intent classifier
      3. normalizeClassificationContract()        ← canonical contract + relationship + ownership probe
      4. loadSellerDealState()                    ← persisted facts / negotiation / ADE / contract state
      5. runInboundIntelligencePhase()            ← stage engines (S2–S6) + intelligence snapshot
      6. resolveAskingPriceSignal()               ← monetary-understanding.js (kind disambiguation)
      7. resolveSellerStageTransition()           ← resolver v1: ONLY lifecycle stage authority
      8. bounded inline ADE (8s timeout)          ← valuation authority, never from seller text
      9. resolveNegotiationTurn() + authority clamp (offer never above ADE ceiling; fail-closed render)
     10. executeInboundAutomationDecision()       ← template select (language fail-closed) + queue insert
     11. scheduleFollowUp() (intent-gated)        + patchUniversalLeadState (source=autopilot, reason)
     12. persistSellerTransitionArtifacts()       ← acquisition_opportunities facts/negotiation/events
     13. emitSellerNotifications + emitWorkflowStudioEvents + execution timeline
```

Authority gates (all fail closed):

- `auto_reply_mode` — `disabled|dry_run|internal_only|live_limited`; legacy `auto_reply_live_enabled` explicitly blocked
  (`auto-reply-mode.js:50`); `internal_only` restricted to `INTERNAL_TEST_PHONE_SET` = {`+16127433952`, `+16124515970`} —
  exactly the two approved canary numbers (`lib/config/internal-phones.js`).
- `followup_automation_mode` — `disabled|dry_run|internal_only|canary_*|live_limited|full_live`; unreadable/missing ⇒
  disabled; legacy flags blocked (`delivery-triggered-followup.js:31–94`).

## 4. Delivery truth & follow-up engine

```
POST /api/webhooks/textgrid/delivery → handleTextgridDeliveryRequest
  → webhook-event-processor: syncDeliveryEvent (canonical send_queue/message_events delivery truth)
  → matched rows only: maybeScheduleFollowUpAfterDelivery
       gates: provider sid present · status ∈ {delivered, delivery_confirmed, confirmed} · declared followup_intent
              (from outbound automation_provenance) · no inbound after outbound · no newer outbound ·
              no duplicate pending followup · contactability not blocked · stage not terminal ·
              mode gate (internal_only ⇒ canary phones only; dry_run ⇒ telemetry only)
  → scheduleFollowUp(): intent-based cadence (NURTURE_DAYS), sha1 idempotency queue_key, 21610 suppression,
     canonical enqueueSendQueueItem writer
Inbound → cancelPendingFollowUpsForThread() (queue_status=cancelled + cancelled_by_inbound_event_id)
```

Retry (technical failure) is separate from follow-up (delivered, no reply): queue retry/reconcile crons
(`/api/internal/queue/retry`, `/api/internal/queue/reconcile`).

**Bug found:** the delivery gate's `BLOCKED_CONTACTABILITY = {opted_out, wrong_number, do_not_text}` mixes vocabularies —
`wrong_number` is a *disposition*; the wrong-number intent actually sets contactability `invalid_number`
(resolver `BLOCKING_INTENTS.wrong_number`), and `dnc`/`provider_blacklisted` are missing. Fixed on this branch by using the
registry's `BLOCKING_CONTACTABILITY`.

**Gap:** cadence is intent-keyed only; there is no per-lifecycle-stage follow-up policy registry (max attempts,
per-stage delay, stage-validity check at schedule time). Added on this branch.

## 5. classify.js (unchanged by this branch)

`apps/api/src/lib/domain/classification/classify.js` (185 KB): heuristic-first; compliance flags absolute; AI assist only
below `AI_CONFIDENCE_THRESHOLD` (pre-existing behavior); returns `language` (script+keyword detection for es/pt/it/fr/de/vi +
CJK/RTL scripts), `primary_intent`, `confidence`, `motivation_score`, `seller_state` (price_mentioned, condition, timeline,
tenant_occupied…), `automation_decision`. Canonical intent vocabulary normalized by
`coverage-net/canonical-intent-aliases.js`. **It remains the only production intent classifier.**

## 6. Extraction layer (Mission 3 — gap)

What exists:

- `monetary-understanding.js` — production-grade monetary extraction: kinds (asking price / counter / rent / mortgage payoff /
  repair / tax / earnest / insurance…), Spanish cues (`mil`, `debo`, `impuestos`, `reparar`, `depósito`), word-numbers,
  dot-thousands, ranges/minimums, bare-number reference disambiguation, `needs_clarification`
  (`low_confidence_monetary_extraction`, `conflicting_price_statements`). Ambiguous amounts are never promoted (orchestrator
  passes `price_signal.asking_price` which is null under clarification).
- `normalizeAskingPriceFact` carries provenance (value, price_type, confidence, source_message_id, extracted_text, captured_at).
- `resolve-inbound-relationship.js` — relationship/referral resolution (tenant, family, agent, PM, co-owner, executor…).
- `detect-inbound-condition-intent.js`, stage-4 engine condition outcomes.

What is missing (built on this branch): one versioned extractor module producing **typed, evidence-backed facts** —
each fact with normalized value, confidence, `source_message_id`, exact evidence text/position, `extracted_at`,
`extractor_version`, `needs_review`, `conflict` — covering condition/repairs (feature-vs-defect guard), timeline, occupancy,
listing/agent involvement, offer interest, objections, ownership/authority claims
(`authority_type/claimed/verified=false/can_execute_alone/additional_signers_claimed/requires_authority_review`),
reason-for-selling, contact instructions. `extracted_facts` in the classification contract
(`normalize-classification-contract.js:130`) currently carries values with **no per-fact evidence or version**.

## 7. Stage transition authority

`resolve-seller-stage-transition.js` (`seller_stage_transition_v1`) is the only lifecycle stage authority: pure, monotonic,
facts-driven (stage = first unresolved milestone), multi-stage advancement from one message (skips already-answered
questions — the "Yes, I own it and I want $120k" case lands S1→S3/S4 without re-asking), blocking intents
(opt_out / wrong_number / wrong_person / hostile) change contactability/disposition without stage movement, nurture intents
schedule follow-ups without regression, ambiguous/low-confidence input → `HUMAN_REVIEW` (never silent advancement),
S5 requires ADE/negotiation authority, S6 requires contract state, S7–S10 require
`disposition.started / disposition.buyer_selected / closing.ready / closing.closed` — **a text intent alone cannot advance
stages ≥5**.

## 8. Stage 1–10 coverage matrix

Legend: ✅ implemented with deterministic entry/exit + persistence · 🟡 partial · ❌ label only.

| # | Stage (registry code) | Entry/exit rules | Intents/outcomes | Extraction | Templates (EN/ES) | Follow-ups | Manual edit | Persistence | Workflow Studio | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `ownership_confirmation` | resolver milestone `ownership_status` | owner confirmed / wrong number / not-the-owner / never owned / former owner / family / tenant / PM / partner-co-owner / agent / entity rep / spam / unclear — full relationship taxonomy (`resolve-inbound-relationship`, `deterministic-stage-map` respondent rules) | ownership signal, referral extraction | `ownership_check` + follow-up variants | S1 ownership-probe overlay; suppression on non-owner (never re-probes a clear non-owner) | ✅ via lead-state patch | ✅ | events: `OWNER_CONFIRMED` | ✅ |
| 2 | `offer_interest` | milestone `interest` | stage2 engine outcomes: interested / conditional / requests offer / provides price / not interested / follow-up later / listed w/ agent / agent involved / trust question / family signoff / hostile / wrong contact / unclear | interest signal | `consider_selling` + follow-up | nurture 30/45d (not_interested / listed) | ✅ | ✅ | `OFFER_INTEREST_CONFIRMED`, `SELLER_NOT_INTERESTED`… | ✅ |
| 3 | `asking_price` | milestone price (or wants_offer + ADE sufficiency) | price provided / range / minimum / "make me an offer" / rent-mortgage-repair disambiguation / ambiguous → clarify | ✅ monetary-understanding (needs_clarification honored) | `seller_asking_price` + follow-up | 14d (asking_price_value nurture) | ✅ | asking-price fact w/ provenance → `acquisition_opportunities` | `SELLER_ASKING_PRICE_CAPTURED` | ✅ |
| 4 | `property_condition` | milestone occupancy+condition (or ADE underwriting_ready) | stage4 engine: condition disclosed / light / major / repair issue / refuses / tenant / vacant-boarded / photos-walkthrough / challenges comp/repairs / unclear | condition facts (needs evidence upgrade) | `condition_probe` | 14–21d | ✅ | ✅ | `CONDITION_FACT_CAPTURED`… | ✅ |
| 5 | `offer` | negotiation `terms_accepted`; offer amount ONLY from ADE authority (ceiling clamp fails closed; $0/overflow render blocked) | stage5 engine + strategy router (counter/accept/reject/best-and-final/proof) | counter extraction via monetary kinds | offer reveal + negotiation set | negotiation-driven | ✅ | negotiation state + offer versions (`persistSellerTransitionArtifacts`, `buildNegotiationStatePatch`) | `OFFER_REVEALED`, `SELLER_COUNTER_OFFERED`… | ✅ (live-cert checklist open) |
| 6 | `formal_contract` | `contract_state.executed/signed` — from contract engine/DocuSign webhook (HMAC-verified), not text | stage6 engine: requested/sent/viewed/signed/partially signed/declined/expired/review; waiting-on spouse/co-signer/LLC/executor/trustee events | authority claims (upgraded this branch) | `asks_contract`, `signature_reminder` | await-signature flow | ✅ | contract events | `CONTRACT_SENT/SIGNED`, `WAITING_ON_*`, `AUTHORITY_VERIFIED` | ✅ engine, 🟡 e2e cert |
| 7 | `under_contract` | `disposition.started` (external) | — | — | `close_handoff` | — | ✅ (manual moves allowed) | dispo readiness read from closing tables | `READY_FOR_DISPOSITION` (vocabulary ends here) | 🟡 event ingestion exists (buyers webhook), no canonical S7+ lifecycle events |
| 8 | `disposition` | `disposition.buyer_selected` (external) | buyers webhook → `handle-buyer-response-webhook` (buyer match items, dispo threads) | — | — | — | ✅ | Podio/closing tables are system-of-record | ❌ no canonical event | 🟡 |
| 9 | `prepared_to_close` | `closing.ready` (external) | title webhook → title routing + closing status (title issues, probate, liens tracked in closing domain) | — | — | — | ✅ | closing tables | ❌ | 🟡 |
| 10 | `closed` | `closing.closed` (external; `closing_marked_closed`) | closings webhook | — | — | — | ✅ | closing tables | ❌ | 🟡 |

Answers to the ten audit questions:

1. **Truly implemented:** S1–S6 end-to-end (conversation-driven); S7–S10 as externally-evidenced state reads with webhook ingestion.
2. **Labels only:** none are pure labels; S7–S10 lack canonical lifecycle *events* and automated thread-state advancement (by design — Podio/closing domain is system-of-record).
3. **Deterministic entry/exit:** S1–S10 all defined in `firstUnresolvedIdx`; S7–S10 predicates depend on external state objects.
4. **Follow-up policies:** S1–S4 (intent-keyed nurture) + delivery-confirmed follow-ups; S5 negotiation-driven; S6 signature reminder; S7–S10 none (correct — operational stages).
5. **Retry policies:** provider-failure retries via queue retry/reconcile crons, distinct from follow-ups.
6. **Extraction:** S3 strong (monetary); S1 relationship; S4 condition (value-only); evidence-backed extractor added this branch.
7. **Canonical persistence:** all stages persist via `patchUniversalLeadState` + `acquisition_opportunities` facts.
8. **Workflow Studio:** S1–S6 events emitted (`emitWorkflowStudioEvents` → `emitAutomationEvent`, deduped); S7–S10 not in the event vocabulary.
9. **Manual changes:** all stages manually editable via `PATCH /api/cockpit/lead-state/patch` (locks + audit).
10. **Drift between views:** the two direct writers above are the only lifecycle drift sources found; views read the same row (see §9).

## 9. View read-paths (drift check)

Inbox (`live-inbox-service` + `inbox-thread-state-contract`), Pipeline, Map, List, Deal Intelligence
(`deal-intelligence-dossier`), Queue (`queue-page-service`) and Workflow Studio activity all read `inbox_thread_state`
(directly or via `v_universal_lead_command`). The canonical writer mirrors legacy columns on every write, so readers of
`stage/status/temperature` see canonical values. The only writers that could desynchronize the mirrors are the two being
rerouted (§2).

## 10. Language & templates

- Templates: `sms_templates` (Supabase) with `language`, `is_active`, `safe_for_auto_reply`, `reply_mode`, property-type
  scoping; selection at `apply-inbound-automation-decision.js:792–860`.
- Fail-closed exists: non-English classified language with no exact-language template ⇒ `language_template_missing` ⇒ review;
  no silent English fallback for a detected non-English message.
- **Gap (fixed this branch):** selection uses only the current message's detected `classification.language` — an established
  thread/prospect language (`prospects.language_preference`, thread history) is not consulted, so one short/ambiguous English-
  looking reply ("ok") in a Spanish conversation could flip the thread to English. Canonical priority chain implemented:
  thread language → prospect preference → explicit inbound language → high-confidence detection → unknown (fail closed).
- There is no `language` column on `inbox_thread_state`; thread language derives from message history/prospect record.
  No migration required for the continuity fix (resolution helper, not new storage).

## 11. Workflow Studio

- Backend: `workflow-v2/` graph engine is **dormant** — `POST /api/workflows/process` is auth-gated, not cron-wired
  ("No cron integration yet"), and hardcodes `live_send_blocked: true`. It is a visualization/shadow surface, not a second engine.
- Real activity feed: `listWorkflowAutomationActivity` (enrollments + scheduled tasks + send_queue follow-ups) and
  `emitAutomationEvent` rows from the seller orchestrator (event_type, dedupe key, thread/property/prospect ids,
  stage_before/after, execution_mode).
- **Gaps (this branch):** payloads lack classifier snapshot (intent/confidence/language), extracted-fact summary + versions,
  template id/language, follow-up scheduled/cancelled as first-class events, suppression events, manual-override visibility.

## 12. Launch-blocker list → implementation on this branch

1. `automation-actions.js` + internal thread-state PUT rerouted through `patchUniversalLeadState` (one writer, locks, audit).
2. Provenance meta extended: `automation_authority`, `classifier_version`, `extractor_version`, `message_event_id` recorded
   on every automated state mutation.
3. Delivery follow-up contactability gate unified with registry `BLOCKING_CONTACTABILITY` (bug fix).
4. Versioned evidence-backed fact extractor (`extract-seller-facts.js`) feeding resolver `new_facts` (classify.js untouched).
5. Deterministic temperature components with reason codes (`temperature_reason`/`temperature_confidence` columns already exist).
6. Data-driven stage rule registry (`seller-lifecycle-stage-registry.js`) + transition validator consulted by the canonical writer.
7. Per-stage follow-up policy registry consumed by the scheduler + delivery trigger.
8. Language continuity resolver (priority chain, unknown-language support, fail-closed) wired into template selection.
9. `ownership_interest_combo_v1` internal-only draft template (EN+ES) with A/B metadata — not activated, not inserted into prod.
10. Workflow Studio event payload enrichment + follow-up cancel/schedule events.
11. Multilingual lifecycle regression fixtures (Mission 10 matrix).

Out of scope (explicitly not done): S7/S8 reorder decision (§1a), canonical S7–S10 lifecycle event vocabulary and webhook →
lifecycle advancement (requires product decision on Podio vs thread-state ownership), any migration, any deploy, any send.
