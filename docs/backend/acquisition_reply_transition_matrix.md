# Acquisition Reply Classification & Transition Matrix

**Status:** Audit-only specification  
**Generated:** 2026-06-22  
**Sources:** `classify.js`, `flow_map.js`, `intentMap.js`, `negotiationEngine.js`, Workflow V2 system graphs, `next_action_from_classification.js`

---

## Routing Architecture (three parallel paths)

| Path | Entry | Queue writer | Status |
|------|-------|--------------|--------|
| **Legacy seller-flow** | `next_action_from_classification.js` → `flow_map.js` | `queue_message.js` → `send_queue` | Active for inbound auto-reply |
| **Automation intent map** | `queueAutoReply.js` → `intentMap.js` | `templateSelector.js` | Parallel; fewer intents |
| **Workflow Studio V2** | System graphs + `action.run_classification` | `queue-adapter.js` (proof/no-send) | Published, not live-sending |

**Strategy decision required:** Consolidate to single canonical path before arming workflows.

---

## Canonical Classifications

Primary intents from `classify.js` schema:

`opt_out` · `wrong_number` · `hostile_or_legal` · `asking_price_provided` · `asks_offer` · `callback_requested` · `not_interested` · `need_time` · `ownership_confirmed` · `latent_interest` · `tenant_occupied` · `condition_disclosed` · `who_is_this` · `info_request` · `unclear`

Objections from `flow_map.js` OBJECTION_ROUTES (priority over stage progression):

`wrong_number` · `who_is_this` · `not_interested` · `already_listed` · `need_more_money` · `need_time` · `need_family_ok` · `tenant_issue` · `condition_bad` · `probate` · `divorce` · `financial_distress` · `has_other_buyer` · `wants_retail` · `needs_call` · `needs_email` · `wants_written_offer` · `wants_proof_of_funds` · `send_offer_first` · `stop_texting`

Positive signals (stage progression): `confirms_ownership` · `affirmative` · `interested` · `open_to_offer` · `price_given` · `price_curious` · `send_offer_first` · `condition_given` · `verbal_yes` · `accepts_offer` · `contract_signed`

---

## Master Transition Matrix

| Classification | Current stage | Extracted fields | Confidence | Next stage | Workflow action | Queue action | Pause/resume | Suppression | Human review | Reply template (use_case) | V2 subworkflow |
|----------------|---------------|------------------|------------|------------|-----------------|--------------|--------------|-------------|--------------|---------------------------|----------------|
| **owner confirmed** (`ownership_confirmed`) | S1 | `ownership_status=confirmed`, `seller_display_name` | ≥0.90 | S2 | `update_stage` → interest_qualification; enroll S2 | `consider_selling` | Cancel S1 follow-ups | — | If entity/probate signal | `consider_selling` | `system_interest_qualification` |
| **not owner** | S1 | `ownership_status=not_owner` | ≥0.85 | terminal | enroll wrong-number recovery | `wrong_person` or STOP | Pause enrollment | Soft suppress alternate paths | If hostile | `wrong_person` | `system_wrong_number_recovery` |
| **wrong number** | S1/S2 | `ownership_status=wrong_number` | ≥0.90 | DEAD | STOP + suppress | `wrong_person` / `wrong_number_knows_owner` | Cancel all follow-ups | **Suppress** | — | context-dependent | `system_wrong_number_recovery` |
| **who is this** | S1–S3 | — | ≥0.80 | same | QUEUE_REPLY | `who_is_this` | — | — | If repeated 3× | `who_is_this` (EN safe only) | identity branch in inbound classification |
| **how got number** | S1–S3 | — | ≥0.75 | same | QUEUE_REPLY | `seller_asks_legit` / `website_reviews_request` | — | — | If skeptical dominant | objection route | — |
| **interested** (`seller_interested`, affirmative) | S2 | `seller_intent=interested` | ≥0.85 | S3 | enroll S3 | `seller_asking_price` | Cancel S2 follow-ups | — | — | `seller_asking_price` | `system_asking_price_extraction` |
| **conditionally interested** | S2 | `seller_intent=conditional` | 0.70–0.84 | S2/S3 | QUEUE_REPLY or WAIT | `consider_selling` / probe price | Schedule S2F | — | If low confidence | `consider_selling_follow_up` | interest graph `unanswered` branch |
| **future interest** (`need_time`, `latent_interest`) | S2 | `timeline_hint` | ≥0.75 | nurture | WAIT + schedule nurture | `not_ready` / `text_me_later_specific` | Long-cycle nurture | — | — | `not_ready` | `system_nurture_reactivation` |
| **not interested** | S2 | `seller_intent=not_interested` | ≥0.85 | nurture/DNC | WAIT or STOP | `not_interested` / `obj_empathetic_not_interested` | Cancel active follow-ups | Optional soft suppress | If frustrated | **MISSING template** | interest graph → suppress |
| **maybe later** | S2 | `timeline_hint` | ≥0.70 | nurture | WAIT | `not_ready` | 30/60/90d nurture | — | — | `not_ready` | `system_nurture_reactivation` |
| **asking for offer** (`asks_offer`, `send_offer_first`) | S2/S3 | `wants_offer_first=true` | ≥0.80 | S3/S4/S5 | QUEUE_REPLY or engine pre-run | `photo_request` / `condition_question_set` / `offer_reveal_cash` | — | — | If not UW-ready | branch on `underwriting_ready` | S5 preliminary engine |
| **listed** (`already_listed`) | S2 | `listed=true` | ≥0.85 | nurture | QUEUE_REPLY | `already_listed` / empathetic variant | Long nurture | — | — | **MISSING in Supabase** | — |
| **represented** (agent) | S2 | `has_agent=true` | ≥0.80 | review | ESCALATE or WAIT | `already_listed` analog | Pause auto | — | **Yes** | — | `system_human_review_escalation` |
| **price provided** (`asking_price_provided`) | S3 | `asking_price`, `price_type` | ≥0.85 | S4 | persist fact; enroll S4 | `price_works_confirm_basics` or `price_high_condition_probe` | Cancel S3F | — | If unrealistic price | branch on `price_works` | `system_underwriting_collection` |
| **price too high** (`need_more_money`) | S3/S5 | `counter_price` | ≥0.80 | S4/S5 | QUEUE_REPLY + engine | `price_high_condition_probe` / `can_you_do_better` | — | — | If above policy max | negotiation templates | S5 engine re-run |
| **make me an offer** | S3 | `price_flexibility=open` | ≥0.75 | S4/S5 | preliminary engine | `photo_request` or `offer_reveal_cash` | — | — | If confidence low | `send_offer_first` route | `system_acquisition_engine_orchestration` |
| **non-numeric price** | S3 | `price_text_raw` | 0.50–0.84 | S3 | QUEUE_REPLY | `asking_price_follow_up` | S3F schedule | — | **Yes** if 2+ failures | `asking_price_follow_up` | re-ask loop |
| **condition provided** (`condition_disclosed`) | S4 | `occupancy_status`, `condition_summary` | ≥0.80 | S5 | update facts; engine run | `walkthrough_or_condition` / offer reveal | Cancel S4F | — | If fire/water/code | local condition probes | `system_acquisition_engine_orchestration` |
| **occupied** | S4 | `occupancy_status=owner_occupied` | ≥0.85 | S4/S5 | QUEUE_REPLY | `price_works_confirm_basics` | — | — | — | confirm basics | — |
| **vacant** | S4 | `occupancy_status=vacant` | ≥0.85 | S5 | engine with vacant assumptions | offer reveal | — | — | — | — | — |
| **tenant occupied** (`tenant_occupied`, `tenant_issue`) | S4 | `tenant_status` | ≥0.80 | review | ESCALATE | `has_tenants` / `tenants_ok` / `occupied_asset` | Pause auto-offer | — | **Yes** | tenant templates | `system_human_review_escalation` |
| **probate** | S4 | `probate_flag` | ≥0.75 | review | QUEUE_REPLY + review | `not_ready` / `probate_doc_needed` / `death_sensitivity` | Long nurture | — | **Yes** | sensitivity templates | human review |
| **foreclosure** (`financial_distress`) | S4 | `distress_type` | ≥0.80 | S4/S5 | QUEUE_REPLY | `foreclosure_pressure` | — | — | **Yes** | — | engine with distress playbook |
| **accepted offer** (`verbal_yes`, `accepts_offer`) | S5 | `offer_status=accepted` | ≥0.90 | S6 | advance pipeline; enroll S6 | `asks_contract` / `close_handoff` | Cancel offer follow-ups | — | — | `close_handoff` | `system_offer_follow_up` (**blocked**) |
| **counteroffer** | S5 | `counter_price`, `counter_terms` | ≥0.85 | S5 | re-run acquisition engine | `justify_price` / `narrow_range` | Offer follow-up reset | — | If above auto-negotiate limit | negotiation set | S5 graph counter branch |
| **rejected offer** | S5 | `offer_status=rejected` | ≥0.85 | nurture | WAIT / suppress | `ask_timeline` or nurture | 30/60/90d | Soft suppress | — | `ask_timeline` | nurture subworkflow |
| **opt-out** | any | `compliance_flag=opt_out` | ≥0.95 | DNC | STOP | none | Cancel all | **Hard suppress** | — | none | `system_opt_out_suppression` |
| **hostile** (`hostile_or_legal`) | any | — | ≥0.90 | LEGAL_REVIEW | STOP + ESCALATE | none | Halt | **Suppress** | **Yes** | none | `system_human_review_escalation` |
| **unclear** | any | — | <0.70 | same | ESCALATE or AI_FREEFORM | none | — | — | **Yes** | — | `system_human_review_escalation` |
| **needs review** (low confidence any) | any | partial extractions | <0.70 | same | ESCALATE | none | Pause auto | — | **Yes** | — | `system_human_review_escalation` |
| **no response** (timeout) | S1–S6 | touch_count | — | same | `schedule_follow_up` | stage-specific `*_follow_up` | Continue until max touches | — | — | see cadence matrix | `system_stage_aware_no_reply` |
| **delivery failure** | any | provider_error | — | same | retry or suppress | — | Delivery recovery | After max attempts | — | — | `system_delivery_recovery` |

---

## Stage-Specific Exit Criteria

### S1 → S2

| Exit type | Condition | Action |
|-----------|-----------|--------|
| Success | `ownership_confirmed` confidence ≥0.90 | Enroll `system_interest_qualification`; queue `consider_selling` |
| Failure — wrong party | `wrong_number` or `not_owner` | `system_wrong_number_recovery`; suppress or alternate contact |
| Failure — no response | Max 2 ownership touches (recommended) | Long-tail nurture 21–30d or terminal suppress |
| Pause | Opt-out, hostile, human review | STOP; `system_opt_out_suppression` or human escalation |

### S2 → S3

| Exit type | Condition | Action |
|-----------|-----------|--------|
| Success | `interested` / `open_to_offer` | Enroll S3; queue `seller_asking_price` |
| Nurture | `not_interested` / `need_time` | `system_nurture_reactivation`; 30/60/90d |
| Terminal | Repeated not interested + max touches | Suppress cold path |

### S3 → S4

| Exit type | Condition | Action |
|-----------|-----------|--------|
| Success | Numeric price or explicit offer-request with confidence ≥0.85 | Persist `asking_price`; enroll S4 |
| Branch | Price works vs high vs creative | S4A / S4B / S4C per `flow_map` |
| Stall | Non-numeric after 2 follow-ups | Human review |

### S4 → S5

| Exit type | Condition | Action |
|-----------|-----------|--------|
| Success | Essential facts complete per `underwriting-playbooks.js` | `trigger.underwriting_fact_updated` → S5 engine |
| Partial | Missing non-material fact | Continue UW loop (1/2/4/7d) |
| Blocked | Tenant/probate/commercial complexity | Human review before engine |

### S5 → S6

| Exit type | Condition | Action |
|-----------|-----------|--------|
| Success | Offer accepted verbal yes | Pipeline → `formal_contract`; enroll S6 (**blocked today**) |
| Negotiation | Counter within policy | Engine re-run; `justify_price` / `narrow_range` |
| Failure | Rejected + no counter | Nurture or terminal |

### S6 (target state — not wired)

| Exit type | Condition | Action |
|-----------|-----------|--------|
| Success | Contract signed, funded, closed | Pipeline `closed`; post-close referral template |
| Failure | Cancelled, dead deal | Pipeline terminal; suppress reactivation unless operator override |

---

## Confidence Thresholds (recommended policy)

| Field / decision | Auto proceed | Human review |
|------------------|--------------|--------------|
| `ownership_confirmed` | ≥0.90 | <0.90 |
| `seller_intent` interested | ≥0.85 | 0.70–0.84 |
| `asking_price` numeric | ≥0.85 | <0.85 or range-only |
| `occupancy_status` | ≥0.80 | conflicting signals |
| Offer auto-send (engine tier) | `AUTO_HARD_OFFER` / `AUTO_RANGE_OFFER` + confidence | `REVIEW_REQUIRED` tier |
| Counteroffer auto-response | Within negotiation band | Above band or creative terms |

---

## Queue & Suppression Behavior

| Event | Pending follow-ups | Queued SMS | Enrollment |
|-------|-------------------|------------|------------|
| Seller replies | Cancel (`cancelFollowUpsOnReply`) | Cancel `workflow_v2` queued rows | Continue graph |
| Opt-out | Cancel all | Cancel all | Exit + suppress |
| Wrong number | Cancel all | STOP | Suppress contact |
| Stage advance | Cancel prior-stage follow-ups | — | Enroll next subworkflow |
| Human review | Pause scheduling | Hold approval queue | Pause enrollment |

---

## V2 Graph Condition Gaps

| Graph | Condition key | Issue |
|-------|---------------|-------|
| Interest Qualification | `condition.seller_intent` | Boolean-only runner may not distinguish `unanswered` vs `not_interested` vs `low_interest` |
| Master Orchestrator | `condition.pipeline_stage` | S6 node inactive → validation errors |
| Offer Follow-Up | `condition.offer_response` | Counter/accept/reject routing exists but S6 blocked at platform level |

---

## Document References

- Strategy spec: `acquisition_automation_s1_s6_strategy_spec.md`
- Template matrix: `acquisition_sms_template_matrix.md`
- Implementation backlog: `acquisition_automation_strategy_implementation_backlog.md`