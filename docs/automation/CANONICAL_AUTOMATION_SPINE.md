# Canonical Acquisition Automation Spine

Status: authoritative contract for the autopilot build (2026-08-07).
Base: `feat/acquisition-autopilot-spine` @ 6d320a36.
Scope rule: **consolidate onto the canonical paths named here; do not create parallel ones.**

This document answers, for any seller thread: who is this, what property, what campaign,
what did we ask, what did they answer, what do we know, what stage, what next action, when,
is automation allowed, why, what valuation applies, what ceiling, what was our last offer,
what is the seller asking, and what happens if they reply right now.

---

## 1. The one state machine

```
campaign (campaigns + campaign-state-machine.js)
  → outbound (campaign_target_graph → campaign_targets → createCampaignQueuePlan → send_queue
              → /api/internal/queue/run → queue_atomic_claim_send_row → TextGrid)
  → inbound (webhooks/textgrid/inbound → handle-textgrid-inbound.js
              → seller-inbound-burst-coordinator → flush-inbound-bursts cron)
  → contextual intent (build-conversation-context.js + classify.js — deterministic, no LLM)
  → seller/property state (inbox_thread_state + universal_lead_state S1–S10
                           + acquisition_opportunities.metadata.negotiation_state)
  → next action (resolve-seller-stage-transition.js → NEXT_ACTIONS enum)
  → execution (maybe-queue-seller-stage-reply → enqueueSendQueueItem → queue/run)
  → valuation (ADE V2 acquisitionDecisionEngine.js → metadata.ade_snapshot)
  → offer (negotiation-state.js offers_made ledger, authority-clamped)
  → negotiation (negotiation-policy.js + negotiation-strategy-router.js, ceiling-bounded)
  → agreement (negotiation-state terms_accepted / accepted_price / accepted_terms)
  → contract (run-deals-autopilot.js: create-contract-from-offer → DocuSign envelope)
  → closing handoff (signature webhook → title routing → closing → maybeMarkClosed; Podio SoR)
```

Every transition above already exists in code. The autopilot build closes the gaps listed in §8
and retires the duplicates in §9. Nothing else gets a new architecture.

## 2. Canonical state model (per thread)

| Question | Canonical source |
|---|---|
| WHO / WHAT property / WHAT campaign | `send_queue` row provenance + `inbox_thread_state` (`prospect_id`, `property_id`) + `master_owners` |
| WHAT did we ask | `conversation_context_v1` (`build-conversation-context.js`) — last sent/delivered outbound with unanswered question |
| WHAT did they answer | `message_events` + burst aggregate (`seller-inbound-burst-policy.js`) |
| WHAT do we know | seller facts (`extract-seller-facts.js` output merged by `mergeSellerFacts`, stored in `acquisition_opportunities.metadata`) |
| WHAT stage | `universal_lead_state` S1–S10 (`LIFECYCLE_STAGE_CODES`, index-based resolver `resolve-seller-stage-transition.js`) |
| WHAT next action / WHEN | `NEXT_ACTIONS` (13-value enum, `universal-lead-state-registry.js:68`) + `inbox_thread_state.next_action_at` / scheduled `send_queue` row |
| IS automation allowed / WHY | `auto_reply_mode` (sole reply-send authority) + `queue_execution_mode` (sole dispatch authority) + suppression/contactability (§5) — each denial carries a reason string |
| WHAT valuation / ceiling | `metadata.ade_snapshot` (ADE V2) — the ONLY financial authority (§6) |
| Last offer / seller ask | `negotiation_state` (`latest_offer`, `current_asking_price`, append-only histories) |
| What if they reply now | webhook → burst → classify → stage resolver → gated execution (deterministic; replayable via `/api/internal/testing/replay-inbound`) |

Two state stores exist (`inbox_thread_state` = ops/inbox surface; `universal_lead_state` = lifecycle).
That duality is accepted for now; the registry (`universal-lead-state-registry.js`) is the stage/next-action
vocabulary authority. Do not introduce a third store.

## 3. Canonical next-action model

`NEXT_ACTIONS` in `lib/domain/lead-state/universal-lead-state-registry.js` is THE enum:
`send_message_now, wait_for_seller, schedule_follow_up, execute_ade, generate_offer, negotiate,
generate_contract, await_signature, start_disposition, resolve_closing_blocker, close,
human_review, no_action_contact_blocked`.

Rules:
- Exactly one next action per thread at any time, produced by the stage resolver (S1–S4),
  the negotiation router (S5+, reshapes template/action only), or the deals autopilot (S6+).
- Every next action that waits carries a due time (`next_action_at` or a scheduled `send_queue` row).
- New behaviors map into this enum; they do not add sibling enums.

## 4. Canonical intent taxonomy

- **Registry of meaning**: `inbound-intent-ontology.js` (75 slugs, 9 categories) is the canonical taxonomy.
- **Emitted set**: `classify.js` `INTENT_PRIORITY` (30 intents) is what the deterministic classifier produces.
- **Law**: downstream policy may key ONLY to emitted intents or to ontology slugs bridged via
  `normalizeToCanonicalIntent`. `listIntentsWithoutClassifierCoverage()` is the audited debt list;
  anything on it routes to `human_review`, never to silent no-op.
- Classification stays 100% deterministic. LLMs may only phrase replies (`natural-response-engine.js`,
  allowlisted models, validator-gated, deterministic fallback) — never decide intent, stage, price,
  suppression, or eligibility.

## 5. Authority boundaries (deterministic-only)

AI must never be the authority for: suppression, sending eligibility, campaign eligibility,
property classification, valuation bounds, offer ceilings, negotiation ceilings, contract
authority, financial limits. Canonical enforcement points:

| Authority | Sole owner |
|---|---|
| Reply-send | `auto_reply_mode` via `resolveGuardedAutoReplyMode` (authorized-timestamp required; never synthesized) |
| Dispatch | `queue_execution_mode` via `queue_atomic_claim_send_row` RPC (fail-closed `stopped`) |
| Follow-up scheduling | `followup_automation_mode` (8 modes, deny-by-default) |
| Suppression | `sms_suppression_list` + `COMPLIANCE_TERMINAL_INTENTS` + `BLOCKING_CONTACTABILITY` (precedence table in `canonical-no-contact-states.js`) |
| Pre-send eligibility | `presend-eligibility-engine.js` (strict mode in campaign loop) |
| Financial ceiling | `metadata.ade_snapshot` → `authorized_offer_ceiling` (§6) |
| Contract dispatch | `ENABLE_AUTO_CONTRACT_SEND` (default false — the containment boundary; DO NOT FLIP) |
| Operator config | `setSystemValues` OPERATOR_WRITE (restrictive by default) |

## 6. Canonical valuation authority (the interface Fable's buyer/comps work plugs into)

One resolver, `resolveValuationAuthority(property, facts)` (new, Agent C), normalizes the live
engine (ADE V2) into the canonical output every consumer uses:

```
valuation_method            enum: sfr_comp_ppsf_arv | small_multi_ppu_ppsf | multifamily_price_per_unit
                                  | income_noi_cap_rate | insufficient_data
estimated_value_low/mid/high
target_acquisition_price    maximum_acquisition_price
initial_offer               offer_confidence (0–1, SINGLE scale)
supporting_comps[]          buyer_demand    liquidity
calculation_version         reason_codes[]
```

Rules:
- Ceiling comes ONLY from this resolver (backed by `ade_snapshot`). The comp-intelligence
  `max_allowable_offer` fallback at `process-seller-inbound-message.js:1189` is retired — absent
  authority ⇒ `human_review`, never a different engine's number.
- 5+ units: price-per-unit is the first deterministic foundation; seller ask is recorded both
  absolute and per-unit. 2–4 units: PPU + PPSF. SFR: comp/PPSF/ARV with repair adjustment.
- Confidence is 0–1 everywhere at the interface; engine-native scales are converted at the boundary.
- Insufficient confidence ⇒ `insufficient_data` ⇒ review. No hallucinated numbers.
- V3 anomaly defense and buyer-intelligence remain pluggable behind this interface; their flags
  are deploy decisions, not touched here.

## 7. Canonical property communication class

One classifier module (Agent A): `resolvePropertyCommunicationClass({units_count, property_type, …})`
→ `single_family | duplex | triplex | fourplex | multifamily_5_plus | unknown`.

- Single source: consolidates `supabase-candidate-feeder.js:351` (correct units logic) and
  `property_scope.js` label parsing. Both campaign and feeder paths consume it; template scope
  matching maps class → `property_type_scope`.
- `unknown` ⇒ property-neutral wording only. SFR must never receive unit-count wording
  (forbidden-placeholder check, not just score-0).
- Fixes the live defect: campaign snapshot reads `unit_count ?? units` but the column is
  `units_count` — unit counts never reach scope resolution today.

## 8. Gap list being implemented (the whole build)

| # | Gap | Owner |
|---|---|---|
| G1 | `units_count` key mismatch → canonical communication class feeding template routing | A |
| G2 | Template eligibility matrix (campaign_type × class × stage × use_case → template, approved, weight, cooldown, required/forbidden fields), deterministic rotation preserved | A |
| G3 | Re-engagement layer: nothing re-enrolls a thread after its single follow-up row fires; attempt counters + stop conditions | B |
| G4 | Taxonomy consolidation: policy keys ⊆ emitted ∪ bridged; coverage for high-value uncovered intents (probate/estate, co-owner) with regression tests | B |
| G5 | Canonical valuation authority resolver (§6) incl. `calculation_version`, unified confidence scale | C |
| G6 | Ceiling fallback retirement (fail closed to review) | C |
| G7 | Concession ladder inputs never wired (`seller_moved_amount`, `new_material_fact`) | C |
| G8 | `offers_made` ledger misses offers sent via non-canonical use_case carrying `{{offer_price}}` | C |
| G9 | Durable Supabase terms snapshot at acceptance (today agreed terms exist only in Podio) | D |
| G10 | Adapter boundaries: docgen (absent) + storage wiring into contract path; email/esign/callbacks wrapped, provider-neutral | D |
| G11 | Campaign recommendation service, shadow/recommend-only, persisted with reasons (no autonomous scheduling) | D |
| G12 | Thread automation snapshot (observability): one readable projection per thread — Automation/Stage/ask/last offer/ceiling/next action/reason/due | Lead |

## 9. Duplicate/legacy paths — retirement list

Retire (delete or explicitly deprecate) when touched; never extend:
- `sms_campaigns` / `sms_campaign_targets` / `build_campaign_targets()` SQL — dead, zero refs.
- Dashboard parallel queue engine (`apps/dashboard/api/internal/queue/*`) incl. its divergent weighted `templateSelection.ts`.
- `lib/automation/negotiationEngine.js` — name-collision stage mapper, not the ADE engine.
- `resolve-seller-auto-reply-plan.js` V1 planner (diagnostics-only; remove from `ai-router.js` prod path).
- `seller-flow-automation-adapter.js` (zero importers).
- Dead strategy `DIRECT_PURCHASE`; v1 negotiation aliases in persisted JSON (keep read-compat, stop writing when safe).
- Root/one-off sender scripts (`execute_launch_batch_*.mjs` etc.) — quarantine, do not run.

Contained but NOT retired this build (live-risk): manual `send-now` bypass (L3/L4 direct
`sendTextgridSMS` call sites), legacy `processLegacyQueueItem`, workflow-v2 follow-up writer,
dual context builders (agree by construction — add cross-check tests, do not refactor now),
prod-only `inbox_thread_state` columns, `enabled`-mode burst activation claim.

## 10. Idempotency inventory (must hold for every transition)

- Sends: `send_queue.dedupe_key` unique partial index + `queue_atomic_claim_send_row` (FOR UPDATE SKIP LOCKED, claim ledger).
- Inbound: webhook idempotency claim; burst `claim_seller_inbound_burst` lease; `constituentKey`.
- Stage: monotonic advance (`persist-seller-transition.js:544`); facts merged strong-over-weak (`mergeSellerFacts`).
- Offers/negotiation: append-only ledgers; `duplicate_acceptance_suppressed`; acceptance capped at min(ask, ceiling).
- Contracts: `find-open-contract` existence check before create; signature webhooks HMAC + receipt tables.
- New work (G3, G9, G11) must follow the same pattern: natural keys + upsert/no-op on replay.

## 11. Non-negotiables for this build

No prod mutation. No deploys. No SMS. No live campaign-state changes. No flag flips
(`ENABLE_AUTO_CONTRACT_SEND`, V3 flags, activation modes stay as-is). Migrations are written,
never applied. All work on branches; commit early; never `git clean` / `stash -u` / `reset --hard`.
