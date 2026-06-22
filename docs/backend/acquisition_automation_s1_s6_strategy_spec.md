# Acquisition Automation S1–S6 Strategy Specification

**Status:** Audit-only specification — no live behavior changed  
**Repository:** `rei-automation-inbox-fix` / branch `inbox-live-fix`  
**Generated:** 2026-06-22  
**Inputs:** Workflow Studio V2 system graphs, `sms_templates` (Supabase), classification/flow services, existing workflow audit

---

## Executive Summary

The platform has a **coherent intended seller journey** (S1 ownership → S6 contract-to-close) encoded in:

1. **Workflow Studio V2 system graphs** (`system-workflow-graphs.js`) — 14 locked templates + master orchestrator
2. **Legacy SMS seller-flow** (`flow_map.js`, `canonical-seller-flow.js`, `classify.js`) — reply-driven template routing
3. **Supabase `sms_templates`** — 1,000 active templates (production catalog)
4. **Campaign tables** — `campaigns` / `campaign_runs` / `campaign_targets` and parallel `sms_campaigns`

**Critical gaps before live execution:**

| Gap | Impact |
|-----|--------|
| All system workflows `published` but `live_send_enabled: false`, `operational_mode: active_safe` | No live SMS from V2 graphs |
| Master orchestrator validation errors (inactive S6 node + dangling edges) | Enrollment path to S6 blocked at graph level |
| Template metadata skew: 924/1000 active templates tagged `stage_code=S2` / `use_case=consider_selling` | Selector may mis-route first-touch ownership |
| Only **1** template with `safe_for_auto_reply=true` | Inbound auto-reply effectively disabled |
| S6 workflow blocked (`pipeline_and_calendar_not_wired`) | No contract-to-close automation |
| Dual routing paths (seller-flow vs flow_map vs workflow V2) | Operator confusion, inconsistent transitions |
| V2 condition routing is boolean-only | Multi-intent branches (S2 seller_intent) may not resolve correctly |

**Recommendation:** Treat Workflow Studio V2 graphs as the **target canonical automation model**, with seller-flow template matrix as the **message content layer**, after reconciliation pass.

---

## Canonical Journey Mapping

### Intended business stages vs system workflow names

| Business stage | Purpose | V2 workflow name | `definition_key` | Workflow ID | Trigger | Mapping verdict |
|----------------|---------|------------------|------------------|-------------|---------|-----------------|
| **S1** Ownership Confirmation | Verify owner/control of property | Ownership Verification | `system_ownership_verification` | `e19c6dc8-…` | `trigger.classification_completed` | **Correct** — post-inbound classification |
| **S2** Selling Interest | Qualify openness to sell | Interest Qualification | `system_interest_qualification` | `32fa7116-…` | `trigger.ownership_confirmed` | **Correct** |
| **S3** Asking Price / Price Discovery | Obtain numeric/range price | Asking Price Extraction | `system_asking_price_extraction` | `f08d1622-…` | `trigger.interest_confirmed` | **Correct** |
| **S4** Property Condition / UW Inputs | Collect facts for offer engine | Underwriting Collection | `system_underwriting_collection` | `7acaa9dc-…` | `trigger.asking_price_extracted` | **Correct** — broader than “condition only” |
| **S5** Offer Presentation & Negotiation | Run acquisition engine, present offer | Acquisition Engine Orchestration | `system_acquisition_engine_orchestration` | `c4609f16-…` | `trigger.underwriting_fact_updated` | **Correct** — includes negotiation handoff |
| **S6** Contract-to-Close | Post-offer execution | Offer Follow-Up | `system_offer_follow_up` | `f7c77fe9-…` | `trigger.offer_sent` | **Partial** — name implies follow-up only; true S6 needs Pipeline/Calendar/Closing |

**Master orchestrator:** `82a08034-…` — `trigger.manual_enrollment`, gates S0–S6 via `condition.pipeline_stage`.

**Supporting workflows (not stage-primary):**

| Workflow | Role |
|----------|------|
| Inbound Classification | Entry router from inbound SMS |
| Opt-Out/Suppression | Compliance terminal |
| Wrong Number Recovery | S1 failure path |
| Stage-Aware No-Reply | Cross-stage no-response cadence |
| Delivery Recovery | Provider failure retry |
| Human Review Escalation | High-risk branch |
| Nurture/Reactivation | Low-interest long-cycle |

---

## Per-Stage Specification

### S1 — Ownership Confirmation

**Purpose:** Confirm the contacted party owns or controls the subject property before spending follow-up credits.

**Entry criteria:**
- Cold outbound first touch queued, OR
- Inbound message received and classified (Inbound Classification workflow), OR
- Manual enrollment into master orchestrator at ownership gate

**Trigger:** `trigger.classification_completed` (V2) / cold outbound feeder `ownership_check` use case

**Initial message (recommended canonical):**
- **EN:** `ownership_check` first-touch (local registry V1–V3; Supabase has 1 EN row tagged S1)
- **ES:** `ownership_check` Spanish variants (local registry + Supabase)
- **RU:** **0** active Supabase `ownership_check` templates (62 Russian templates exist but are `consider_selling` / `seller_asking_price` only — S1 RU coverage is **local-registry-only** until promoted)

**Follow-up sequence (current V2 graph):**
- `action.schedule_follow_up` category `ownership`, baseline **14–21 days** (`follow-up-service.js`)
- Cancel on reply via `action.cancel_pending_follow_ups`

**Timing cadence (current vs recommended):**

| Motivation | Current V2 baseline | Recommended (strategy) |
|------------|--------------------|-----------------------|
| High urgency | 14d × 0.75 ≈ 11d | 7–10d first no-reply |
| Medium | 14–21d | 14–21d (keep long-tail) |
| Low | 21d × 1.25 ≈ 26d | 21–30d |
| Unknown | 14–21d | **21d default** (credit-conserving) |

**Reply classifications (S1):** `ownership_confirmed`, `not_owner`, `wrong_number`, `who_is_this`, `property_correction`, `unclear`, `opt_out`, `hostile_or_legal`

**Required extractions:** `ownership_status`, `seller_display_name`, `property_address` confirmation

**Successful exit:** Ownership confirmed → enroll S2 (`system_interest_qualification`)

**Unsuccessful exit:** Not owner / wrong number → `system_wrong_number_recovery` or suppress

**Pause conditions:** Opt-out, suppression, kill-switch, human review flag

**Suppression:** Upstream opt-out guard + `system_opt_out_suppression`

**Human review:** Ambiguous ownership, entity/probate signals, hostile/legal

**Fallback:** Wrong-number recovery subworkflow; reengagement after long idle

**Timeout:** Stage-Aware No-Reply + ownership follow-up schedule

**Reactivation:** Nurture/Reactivation workflow (`30/60/90` day nurture cadence)

**Language:** Detect via `classify.js` (script + keywords); Russian supported in classification; **no Supabase S1 template** — must use local registry or flag missing-template review

**Queue behavior:** V2 graphs do not enqueue S1 SMS directly — relies on campaign feeder / inbound reply path. Queue via `queue-outbound-message.js` → `send_queue`.

**Linked templates:** `ownership_check`, `ownership_check_follow_up`, `who_is_this`, `wrong_person`

**Linked campaign types:** Cold outbound campaigns (`sms_campaigns`, `campaigns`)

**Linked services:** `classify.js`, `template-selector.js`, `supabase-candidate-feeder.js`, `flow_map.js`

**S1 audit findings:**
- Long-tail follow-up (14–21d) aligns with credit conservation for unknown motivation
- Missing: dedicated probate/deceased/entity/agent branches in V2 graph (handled partially in `flow_map` objection routes)
- Supabase stage_code metadata does not match use_case distribution — selector must prefer `use_case` over `stage_code`

---

### S2 — Selling Interest

**Purpose:** Determine whether a verified owner is open to selling (now or later).

**Entry criteria:** `trigger.ownership_confirmed` / classification `ownership_confirmed`

**Trigger:** `trigger.ownership_confirmed`

**Initial message:** `consider_selling` (first touch) — **924 active Supabase templates** (metadata concern: may include mis-tagged rows)

**Follow-up:** `consider_selling_follow_up` — baseline **5–7 days** (V2) / **1 day** default (`latency.js` S2F)

**Reply classifications:** interested, conditionally_interested, future_interest, not_interested, listed, represented, wrong_person, unclear, needs_review, opt_out

**V2 graph branches (`condition.seller_intent`):**
- `interested` → advance to asking_price → enroll S3
- `unanswered` / `low_interest` → nurture subworkflow
- `not_interested` → suppress

**⚠️ Runtime risk:** Graph runner resolves boolean edges only — multi-key false branches may not distinguish unanswered vs not_interested.

**Successful exit:** Seller intent interested → S3

**Unsuccessful exit:** Suppress, nurture, or human review

---

### S3 — Asking Price / Price Discovery

**Purpose:** Obtain asking price, range, or explicit “make me an offer” signal.

**Entry criteria:** `trigger.interest_confirmed`

**Initial message:** `asking_price` / `seller_asking_price` — 74 active Supabase templates at S3

**Follow-up:** `asking_price_follow_up` — **2–3 days** (V2) / **2 days** (`latency.js` S3F)

**V2 actions:** `action.enqueue_sms` with `use_case: asking_price_request`, `template_key: asking_price` (proof/no-send)

**Extractions:** `asking_price` numeric normalization, range handling, “make me an offer” → preliminary engine run

**Successful exit:** Price extracted → `trigger.asking_price_extracted` → S4

---

### S4 — Property Condition & Underwriting

**Purpose:** Collect minimum facts for Acquisition Decision Engine confidence.

**Entry criteria:** `trigger.asking_price_extracted`

**Progressive information strategy (recommended):**

| Tier | Facts | Source priority |
|------|-------|-----------------|
| Essential | `asking_price`, `occupancy_status`, `property_condition`, asset class | Record + conversation |
| Conditional | repairs, roof/HVAC, tenant status, unit count | Ask only if offer confidence < threshold |
| Optional | detailed rent roll, HOA, mortgage | Multifamily/commercial only |
| Inferred | beds/baths/sqft, year built, zoning | Property record / Deal Intelligence |

**Playbooks:** `underwriting-playbooks.js` — asset-class `required_facts` + `escalation_threshold_missing`

**Offer-engine readiness:** `condition.missing_underwriting_fact` with readiness threshold; preliminary engine at S3, full engine at S5

**Follow-up:** **1–2–4–7 days** underwriting cadence (V2 loop)

**Templates:** `underwriting_question` (dynamic), `price_works_confirm_basics`, `price_high_condition_probe`, MF probes

---

### S5 — Offer Engine & Negotiation

**Purpose:** Compute offer, present to seller, handle counters within policy.

**Entry criteria:** `trigger.underwriting_fact_updated` + readiness gate

**Engine:** `acquisitionDecisionEngine.js` — tiers: `AUTO_HARD_OFFER`, `AUTO_RANGE_OFFER`, `CREATIVE_TERMS`, `NURTURE`, `REVIEW_REQUIRED`

**Automatic offer eligibility (recommended policy — operator approval required):**
- Tier `AUTO_HARD_OFFER` or `AUTO_RANGE_OFFER`
- Confidence ≥ operator-defined threshold (engine `REVIEW_REQUIRED` otherwise)
- Asset classes: SFR, small MF (≤4) with complete essential facts
- **Never auto:** probate without counsel review, portfolio bulk, commercial 5+, environmental flags

**Human review:** `action.request_human_approval` when `review_required`; Human Review Escalation subworkflow

**Negotiation state machine (documented target):**

```
offer_generated → offer_presented → {accepted, counter, rejected, silent}
  accepted → S6 contract path
  counter → re-run engine with counter fact → revised offer (within negotiation limits)
  rejected → nurture or terminal suppress
  silent → offer follow-up cadence 1/3/7/14d
```

**V2 graph:** No direct SMS in S5 — offer message expected via template layer post-engine

---

### S6 — Contract-to-Close

**Current state:** **BLOCKED** — `stage_6` node inactive in orchestrator; `blocked_reason: pipeline_and_calendar_not_wired`

**Intended journey (spec only):**

| Phase | Events | Integrations |
|-------|--------|--------------|
| Verbal acceptance | `verbal_yes`, `accepts_offer` | Pipeline stage → `formal_contract` |
| Agreement | contract template resolve, e-sign | Closing Desk, document system |
| Earnest money | calendar milestone | Calendar |
| Title | title company, lien search | Pipeline, Entity Graph |
| Inspection/access | scheduled events | Calendar, Inbox |
| Buyer match | disposition | Buyer Match |
| Closing | funding, recorded | Closing Desk, Calendar |
| Terminal | closed, cancelled, dead | Pipeline, suppression |

**V2 Offer Follow-Up graph:** 1/3/7/14d touches, classification on reply, counteroffer extraction, human review on negotiation

**Required wiring (not implemented):** Pipeline opportunity stage sync, Calendar command events, Closing Desk handoff, contract generation bridge

---

## Follow-Up Cadence Matrix

Send window: **9:00–20:00 local** (`latency.js`). Weekend: same window unless operator overrides. Timezone: contact/property timezone with ET fallback. Reply resets: cancel pending follow-ups + queued stage follow-ups on any inbound reply.

### Immediate transactional (post-reply)

| Profile | Delay | Trigger |
|---------|-------|---------|
| Hot | 30–120s | motivated, affirmative, price_curious, send_offer_first |
| Neutral | 120–300s | default |
| Cold | 300–900s | skeptical, frustrated, guarded |

### Active stage no-reply (by motivation)

| Stage | Touch | High urgency | Medium | Low | Unknown (recommended) | Max attempts | Stop condition |
|-------|-------|--------------|--------|-----|----------------------|--------------|----------------|
| S1 ownership | T2 | 7–10d | 14d | 21–30d | **21d** | 2 | opt-out, wrong number, owner confirmed |
| S1 ownership | T3+ | — | — | 30d nurture | 30d nurture | 1 long-tail | no response after T2 |
| S2 interest | T2 | 3–4d | 5d | 7d | **5d** | 3 | interested, not interested (→nurture), opt-out |
| S3 asking price | T2 | 1d | 2d | 3d | **2d** | 3 | price extracted, opt-out |
| S4 underwriting | T2–T5 | 1d / 2d / 4d / 7d | same | +25% multiplier | same | 4 | facts complete, opt-out |
| S5 offer | T2–T5 | 1d / 3d / 7d / 14d | same | +25% | same | 4 | accepted, rejected (→nurture), opt-out |
| S5 counter | T2+ | 1d | 2d | 3d | **1d** | 3 | counter resolved, opt-out |
| S6 contract | T2–T5 | 1d / 2d / 5d / 7d | same | +25% | same | 4 | signed, dead deal (**blocked**) |

### Passive nurture

| Segment | Cadence | Entry | Exit |
|---------|---------|-------|------|
| S2 no-interest | 30 / 60 / 90d | `not_interested`, `need_time` | re-engagement reply or suppress |
| S5 rejected offer | 30 / 60 / 90d | offer rejected | new motivation signal |
| Cold lead reactivation | 90 / 180 / 365d | pipeline `nurture` stage | ownership re-confirm or suppress |

### S1 unknown-owner (credit-conserving)

Long-tail default: **21d** first no-reply, **30d** second, then nurture — not aggressive 1–3d polling.

### Escalation

- 2× unclear replies → human review
- 3× delivery failures → `system_delivery_recovery` then suppress
- Counter above auto-negotiate band → human review

**Current vs recommended:** Legacy `latency.js` S2F=1d conflicts with V2 `interest` 5–7d. **Recommend V2 baselines** with motivation multipliers from `follow-up-service.js`.

---

## Cross-Cutting Architecture

### Execution safety (verified)

- Workflow V2 `action.enqueue_sms` → `queue-adapter.js` → `insertSupabaseSendQueueRow` only
- `live_send_blocked: true` on all communication actions
- Dedupe via `buildQueueDedupeKey` + `buildSendQueueDedupeKey`
- Guards: kill-switch, suppression, opt-out, max-touches, approval-required, contact-window

**Flag:** `execution-service.js` references legacy `sendSmsPlaceholder` — dry-run only, not production path

**Flag:** Legacy `autonomous-seller-reply.js` may use CSV `template_resolver` (4-row stub) — parallel path risk

### Campaign linkage

- `campaigns` + `campaign_runs` + `campaign_targets` — automation control plane
- `sms_campaigns` + `sms_campaign_targets` — outreach lifecycle
- `send_queue.campaign_*` FKs link queue rows to campaigns

### Language routing

1. Source data / master_owner language preference
2. `classify.js` script/keyword detection (16 canonical languages)
3. `language_aliases.js` normalization
4. Template selector matches `language` dimension
5. **No silent English fallback** — policy: queue for human review if missing template

---

## Validation Errors & Duplicate Workflows

### `82a08034` — Master Acquisition Orchestrator

| Error | Node | Business impact |
|-------|------|-----------------|
| `edge_target_not_found` | `stage_6_gate` → inactive `stage_6` | S6 enrollment path broken at validation |
| `edge_source_not_found` | inactive `stage_6` → `exit` | Graph integrity failure |

**Execution:** Subworkflow enroll respects `config.blocked` but inactive node breaks validation and may block publish/arming.

**Recommended correction:** Keep `stage_6` active with `config.blocked: true`, or remove dangling edges.

### `a0b497b2` / `41fdc8a9` — Owner Acquisition Follow-Up (duplicate drafts)

| Field | `41fdc8a9` | `a0b497b2` |
|-------|------------|------------|
| Created | 2026-06-21 02:41 UTC | 2026-06-21 02:49 UTC |
| `definition_key` | `owner_acquisition_follow_up` | `owner_acquisition_follow_up_mqn6ugvb` |
| Nodes/edges | 0 / 0 | 0 / 0 |
| Errors | `graph_missing_trigger`, `graph_has_no_nodes` | Same |

**Recommendation:** Archive both after strategy approval; canonical acquisition path is system orchestrator + S1–S6 templates. Neither has run history or graph content.

---

## Operator Decisions Required

1. Confirm S4 scope: “Underwriting Collection” vs “Property Condition only” labeling for operators
2. Approve S1 default cadence: 21d unknown vs 14d
3. Set offer auto-send threshold and asset-class denylist
4. Resolve dual automation paths: migrate inbound to V2 vs keep seller-flow
5. S6 scope: Offer Follow-Up only vs full contract-to-close platform wiring
6. Template metadata cleanup: 924 consider_selling rows — re-tag stage/touch
7. Auto-reply policy: enable `safe_for_auto_reply` set vs human-review-only

---

## Document References

- Template matrix: `acquisition_sms_template_matrix.md`
- Reply transitions: `acquisition_reply_transition_matrix.md`
- Implementation backlog: `acquisition_automation_strategy_implementation_backlog.md`
- Workflow inventory: `workflow_studio_v2_system_workflow_audit.md`