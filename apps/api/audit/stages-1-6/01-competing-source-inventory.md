# Stages 1–6 — Competing Source-of-Truth Inventory

The audit's central structural finding: **three divergent intent/stage
vocabularies** existed. This is the root cause behind most coverage risk.

## A. Intent taxonomies found

| # | Source | Status | Vocabulary (sample) | Dead-end? |
|---|---|---|---|---|
| 1 | `classification/classify.js` → `INTENT_PRIORITY` | **LIVE (canonical)** | `wrong_number`, `seller_interested`, `asking_price_provided`, `condition_disclosed`, `tenant_occupied`, `unclear` | no |
| 2 | `seller-flow/deterministic-stage-map.js` + `seller-flow-safety-policy.js` | DIAGNOSTIC + stage engines | `wrong_person`, `asking_price_value`, `condition_signal`, `tenant_or_occupancy` | falls through to REVIEW |
| 3 | `automation/intentMap.js` (+ `queueAutoReply`, `templateSelector`) | **DEAD / ISOLATED** | `wrong_number`, `asking_price_provided`, stages `DNC`/`DEAD_LEAD`/`LEGAL_REVIEW` | **`unclear → ESCALATE → "needs_review"`** |
| 4 | `sms/next_action_from_classification.js` (`processClassification`) | **DEAD** | flow_map ACTIONS | `unclear → AI_FREEFORM` |

### Caller proof (repo-wide grep over `apps/api/src` + `apps/api/tests`)

- `deterministic-stage-map.js`: imported only by `app/api/diagnostics/stage-map`, `app/api/diagnostics/inbound-replay`, `lib/diagnostics/inbound-replay-verifier.js`. **Not the live webhook.**
- `automation/intentMap.js` / `queueAutoReply.js` / `templateSelector.js`: **zero external importers.**
- `next_action_from_classification.js` (`processClassification`): **zero importers (incl. tests).**

## B. Stage vocabularies found

| Source | Stages | Role |
|---|---|---|
| `config/stages.js` → `STAGES` | Ownership / Offer / Q-A / Contract / Follow-Up (5) | legacy high-level lifecycle |
| `communications-engine/state-machine.js` → `CONVERSATION_STAGES` | 10 stages | canonical conversation state |
| `seller-flow/canonical-seller-flow.js` → `SELLER_FLOW_STAGES` | ~40 micro-stages | template/use-case routing |

These are bridged by `brainStageForUseCase()` / `collapseLifecycleStage()`. They
do not conflict (they are nested resolutions), but the **three intent
vocabularies did conflict** with each other.

## C. Concrete divergence consequences (pre-fix)

1. **Suppression miss risk:** classifier emits `wrong_number`; the deterministic
   diagnostic table only knew `wrong_person` → diagnostics under-reported
   suppression vs. live behavior.
2. **Policy fall-through:** classifier `asking_price_provided` / `condition_disclosed`
   did not match safety-policy keys `asking_price_value` / `condition_signal` → REVIEW default.
3. **Dead-end review:** the dead `intentMap.js` routed `unclear → needs_review`
   with no next action — a literal dead end (not wired, but a trap if reused).

## D. Reconciliation applied this pass (safe net)

- New `coverage/canonical-intent-aliases.js` is the **one** normalizer:
  `wrong_person → wrong_number`, `asking_price_value → asking_price_provided`,
  `condition_signal → condition_disclosed`, `tenant_or_occupancy → tenant_occupied`,
  opt-out synonyms → `opt_out`, etc. Unknown → `unclear`.
- The live decision core (`applyInboundAutomationDecision`) now normalizes
  `primary_intent` through it (no-op for already-canonical classifier output).
- `deterministic-stage-map.js` gained a `wrong_number` rule mirroring `wrong_person`.
- Dead modules (#3, #4) annotated `@deprecated` + isolated (NOT deleted, per
  instruction — see `08-next-consolidation-sequence.md` for removal plan).

> Full vocabulary consolidation (collapsing #2's policy table onto the canonical
> names, and removing the dead modules) is **deferred to the consolidation pass**.
