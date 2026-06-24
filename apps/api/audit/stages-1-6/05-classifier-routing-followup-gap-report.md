# Stages 1–6 — Classifier / Routing / Follow-up Gap Report

Status legend: ✅ closed this pass · ⚠️ partial / mitigated · ⛔ deferred to consolidation

## Classifier gaps

| # | Gap | Status | Notes |
|---|---|---|---|
| C1 | Intent vocab divergence (live vs safety-policy vs dead map) | ✅ | `canonical-intent-aliases.js` normalizes; live decision normalizes `primary_intent` |
| C2 | `wrong_person` not equal to `wrong_number` for suppression | ✅ | unified; both suppress; test-locked |
| C3 | `reaction_only` / `acknowledgement` had no defined safe action | ✅ | now → ambiguous_context workflow + stage-aware safe fallback |
| C4 | Context-free yes/no interpretation (e.g. "yes" after offer) | ⛔ | classify.js uses some context; full prior-question conditioning deferred |
| C5 | Multi-intent single message (resolve to one primary only) | ⚠️ | `secondary_intent` captured but routing uses primary; documented |
| C6 | Language coverage beyond EN/ES (PT/IT/FR/DE/VI/PL detected, not templated) | ⚠️ | detected → `language_unsupported` exception workflow |

## Routing gaps

| # | Gap | Status | Notes |
|---|---|---|---|
| R1 | Bare `mark_human_review` with no scheduled next action | ✅ | coverage net attaches scheduled_next_action + owned workflow |
| R2 | `callback_requested` vs `needs_call` profile naming drift | ⚠️ | both handled in decision; canonicalize in consolidation |
| R3 | `property_correction` / `reaction_only` had no route profile | ✅ | handled via ambiguous + conflicting_property workflows |
| R4 | Diagnostic stage-map vocab differs from live | ⚠️ | `wrong_number` rule added; full policy re-key deferred |
| R5 | Stage engines consume sparse `SELLER_FLOW_SAFETY_POLICY` | ⛔ | policy table is thin; consolidation will densify |

## Follow-up gaps

| # | Gap | Status | Notes |
|---|---|---|---|
| F1 | Review items had no SLA / deadline | ✅ | every exception workflow has `sla_ms` + computed deadline |
| F2 | No automatic reclassification rule on next inbound | ✅ | workflows carry `auto_reclassify`; safe fallback sets `reclassify_next_with_context` |
| F3 | No terminal resolution defined for stalled exceptions | ✅ | each workflow has a `terminal` resolution |
| F4 | `not_interested` long-term nurture eligibility | ⚠️ | scheduled_next_action = nurture_or_close_per_followup_policy; nurture cadence owned by `seller-followup-scheduler.js` |
| F5 | Quiet-hours / timezone / market-urgency on fallback dispatch | ⚠️ | inherited from existing scheduler; not re-implemented here |

## What this pass deliberately did NOT change

- No live-send behavior (`should_queue_reply` / `should_suppress_contact` / `reply_mode` untouched).
- No deletion of dead modules (annotated `@deprecated` only).
- No re-keying of the `SELLER_FLOW_SAFETY_POLICY` table (consolidation work).
