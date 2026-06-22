# Acquisition SMS Template Matrix

**Status:** Audit-only — no templates edited  
**Generated:** 2026-06-22  
**Sources:** Supabase `sms_templates` (1,000 active), `local-template-registry.js` (67 emergency candidates), `template-coverage-audit.mjs`, `flow_map.js` use-case inventory

---

## Executive Summary

| Source | Count | Role |
|--------|-------|------|
| Supabase `sms_templates` (active) | 1,000 | Production catalog |
| Local template registry | 67 | Emergency fallback when Supabase selector fails |
| `safe_for_auto_reply=true` | **1** | Auto-reply effectively disabled |
| Follow-up templates in Supabase | **0** (`is_follow_up` never set; no `*_follow_up` use cases) | Follow-ups rely on local registry or re-use first-touch bodies |
| `ownership_check` in Supabase | **1** (Vietnamese only) | S1 cold outbound critically under-covered in production catalog |

**Metadata integrity:** 924/1,000 rows carry `stage_code=S2` regardless of `use_case`. Selector logic must prefer `use_case` over `stage_code`.

**Send attribution:** All `usage_count` and `success_rate` fields are **0** in Supabase. Historical performance must be derived from `send_queue` / `message_events` (14,731 queue rows; 11,776 message events) — not yet joined to `template_id` in this audit.

---

## Supabase Catalog — Aggregate Matrix

### By language (active)

| Language | Count | Primary use cases |
|----------|-------|-------------------|
| Vietnamese | 76 | consider_selling (69), seller_asking_price (6), ownership_check (1) |
| Spanish | 75 | consider_selling (69), seller_asking_price (6) |
| German | 75 | consider_selling (68), seller_asking_price (7) |
| French | 75 | consider_selling (69), seller_asking_price (6) |
| Italian | 75 | consider_selling (69), seller_asking_price (6) |
| Portuguese | 75 | consider_selling (69), seller_asking_price (6) |
| Polish | 71 | consider_selling (69), seller_asking_price (2) |
| Russian | 62 | consider_selling (55), seller_asking_price (7) |
| Hebrew | 62 | consider_selling (57), seller_asking_price (5) |
| Greek | 61 | consider_selling (55), seller_asking_price (6) |
| Korean | 61 | consider_selling (56), seller_asking_price (5) |
| Arabic | 60 | consider_selling (57), seller_asking_price (3) |
| Japanese | 60 | consider_selling (58), seller_asking_price (2) |
| Mandarin | 58 | consider_selling (56), seller_asking_price (2) |
| Indian (Hindi or Other) | 40 | consider_selling (38), seller_asking_price (2) |
| English | 14 | consider_selling (10), seller_asking_price (3), who_is_this (1) |

### By use_case (active)

| use_case | Count | stage_code tags | Notes |
|----------|-------|-----------------|-------|
| `consider_selling` | 924 | S2 (924) | S2 interest question — bulk of catalog |
| `seller_asking_price` | 74 | S3 (74) | S3 price discovery |
| `ownership_check` | 1 | S1 (1) | **Only Vietnamese** — critical S1 gap |
| `who_is_this` | 1 | SP (1) | English only; only safe auto-reply template |

### By stage_code (active — unreliable)

| stage_code | Count | Actual use_case mix |
|------------|-------|---------------------|
| S2 | 924 | consider_selling |
| S3 | 74 | seller_asking_price |
| S1 | 1 | ownership_check (Vietnamese) |
| SP | 1 | who_is_this |

---

## Stage × Touch × Language Matrix

Policy: **no silent English fallback**. Missing cell = human review or local-registry emergency path.

| Stage | Touch | English | Spanish | Russian | Missing coverage |
|-------|-------|---------|---------|---------|------------------|
| **S1** Ownership | T1 (first touch) | Local registry (5 variants) | Local registry (2) | **MISSING** — no Supabase, no local | RU S1 T1 required |
| **S1** Ownership | T2+ follow-up | Local registry (2 EN, 2 ES) | Local registry (2) | **MISSING** | RU S1 follow-up required |
| **S2** Interest | T1 | Supabase (10) — unsafe auto | Supabase (69) — unsafe auto | Supabase (55) — unsafe auto | EN/ES/RU `safe_for_auto_reply` |
| **S2** Interest | T2+ follow-up | Local registry (2) | Local registry (1) | **MISSING** | RU S2 follow-up; promote follow-ups to Supabase |
| **S3** Asking price | T1 | Supabase (3) | Supabase (6) | Supabase (7) | `asking_price` use_case missing (only `seller_asking_price`) |
| **S3** Asking price | T2+ follow-up | Local registry (2) | **MISSING** | **MISSING** | ES/RU S3 follow-up |
| **S4A** Confirm basics | T1 | **MISSING** (`price_works_confirm_basics`) | **MISSING** | **MISSING** | Full S4A first-touch set |
| **S4A** Confirm basics | T2+ | Local registry (2 EN) | **MISSING** | **MISSING** | ES/RU S4A follow-up |
| **S4B** Condition probe | T1 | **MISSING** (`price_high_condition_probe`) | **MISSING** | **MISSING** | Full S4B first-touch set |
| **S4B** Condition probe | T2+ | Local registry (2 EN) | **MISSING** | **MISSING** | ES/RU S4B follow-up |
| **S5** Offer reveal | T1 | **MISSING** (`offer_reveal_cash` etc.) | **MISSING** | **MISSING** | All offer-reveal variants |
| **S5** Offer reveal | T2+ | Local registry (2 EN) | **MISSING** | **MISSING** | ES/RU offer follow-up |
| **S5** Negotiation | — | Local: justify_price, narrow_range, ask_timeline (EN only) | **MISSING** | **MISSING** | Negotiation object handlers |
| **S6** Contract/close | T1+ | Local: close_handoff (2 EN) | **MISSING** | **MISSING** | Full S6 template family |
| **Cross** Who is this | — | Supabase (1, safe) | **MISSING** | **MISSING** | ES/RU identity templates |
| **Cross** Not interested | — | **MISSING** | **MISSING** | **MISSING** | All languages |
| **Cross** Wrong person | — | **MISSING** in Supabase | **MISSING** | **MISSING** | Objection handler set |
| **Cross** Reengagement | — | Local registry (3 EN, 2 ES) | Partial | **MISSING** | RU reengagement |
| **MF** Underwriting | — | Local registry (units/occupancy/rents/expenses) | **MISSING** | **MISSING** | MF Spanish/Russian |
| **Novation** | — | Local registry only (8 variants EN) | **MISSING** | **MISSING** | Creative-finance paths |
| **Disposition** | — | Local registry only (4 EN) | **MISSING** | **MISSING** | Post-contract buyer comms |

---

## Auto-Reply Intent Coverage (`template-coverage-audit.mjs`)

| Intent | Required use_case | English | Spanish |
|--------|-----------------|---------|---------|
| ownership_confirmed | consider_selling | ⚠️ 10 templates, none safe | ⚠️ 69 templates, none safe |
| asks_offer | asking_price | ❌ missing | ❌ missing |
| info_request | who_is_this | ✅ 1 safe | ❌ missing |
| not_interested | not_interested | ❌ missing | ❌ missing |
| condition_signal | price_high_condition_probe | ❌ missing | ❌ missing |
| asking_price_value | price_works_confirm_basics | ❌ missing | ❌ missing |

---

## Local Template Registry (67 candidates)

Emergency layer when Supabase selector returns no match. **Not promoted to production catalog.**

| use_case | EN | ES | Stage | Touch |
|----------|----|----|-------|-------|
| ownership_check | 5 | 2 | S1 | T1 |
| ownership_check_follow_up | 2 | 2 | S1 | T2+ |
| consider_selling_follow_up | 2 | 1 | S2 | T2+ |
| asking_price_follow_up | 2 | 0 | S3 | T2+ |
| price_works_confirm_basics_follow_up | 2 | 0 | S4A | T2+ |
| price_high_condition_probe_follow_up | 2 | 0 | S4B | T2+ |
| offer_reveal_cash_follow_up | 2 | 0 | S5 | T2+ |
| justify_price | 2 | 0 | S5 | negotiation |
| ask_timeline | 2 | 0 | S5 | negotiation |
| ask_condition_clarifier | 2 | 0 | S4/S5 | negotiation |
| narrow_range | 2 | 0 | S5 | negotiation |
| close_handoff | 2 | 0 | S6 | handoff |
| mf_confirm_units | 2 | 0 | S4 MF | T1 |
| mf_occupancy | 2 | 0 | S4 MF | T1 |
| mf_rents | 2 | 0 | S4 MF | T1 |
| mf_expenses | 2 | 0 | S4 MF | T1 |
| mf_*_follow_up | 4 | 0 | S4 MF | T2+ |
| mf_underwriting_ack | 2 | 0 | S4 MF | finalize |
| novation_* | 10 | 0 | S5 creative | various |
| disposition_* | 4 | 0 | S6 | disposition |
| reengagement | 5 | 2 | nurture | T1+ |

**Placeholders (all local):** `{{seller_first_name}}`, `{{agent_first_name}}`, `{{property_address}}`, `{{units}}` (MF)

**Fallback behavior:** Local registry injected via `template-selector.js` when Supabase returns zero candidates; does not set `safe_for_auto_reply`.

---

## Representative Supabase Templates (samples)

### S1 — ownership_check (sole production row)

| Field | Value |
|-------|-------|
| template_id | (Vietnamese row — sole S1 active) |
| language | Vietnamese |
| use_case | ownership_check |
| stage_code | S1 |
| is_first_touch | true |
| safe_for_auto_reply | false |
| body (pattern) | Ownership confirmation question re: property address |
| usage_count | 0 |

### S2 — consider_selling (English sample)

| Field | Value |
|-------|-------|
| language | English |
| use_case | consider_selling |
| count | 10 variants |
| safe_for_auto_reply | false (all) |
| body pattern | Post-ownership interest probe ("would you consider selling if the number made sense") |
| variables | `seller_first_name`, `property_address`, `agent_first_name` (typical) |

### S3 — seller_asking_price (Russian sample)

| Field | Value |
|-------|-------|
| language | Russian |
| use_case | seller_asking_price |
| count | 7 variants |
| body pattern | "Какая цифра вам подходит?" / "Сколько вы хотели бы за это?" |
| segment estimate | 1 segment (short Cyrillic) |

### Cross — who_is_this (only safe auto-reply)

| Field | Value |
|-------|-------|
| language | English |
| use_case | who_is_this |
| safe_for_auto_reply | **true** |
| stage_code | SP |

---

## Template Quality Audit

### Keep unchanged (production-ready tone/structure)

| Group | Count | Rationale |
|-------|-------|-----------|
| Supabase `consider_selling` EN (10) | 10 | Natural interest probe; brief; compliant |
| Supabase `seller_asking_price` multilingual | 74 | Direct price ask; 1-segment friendly |
| Local `ownership_check` EN v1–v3 | 3 | Human, brief, no filler; TextGrid-safe |
| Local `who_is_this` equivalent | — | N/A in local; keep Supabase EN safe row |
| Local MF underwriting probes | 12 | Asset-class appropriate; progressive |

### Revise lightly

| Group | Issue | Recommendation |
|-------|-------|----------------|
| Supabase `consider_selling` (non-EN) | Some translations read machine-translated | Native-speaker review for ES/RU priority |
| Local ownership (agent/no-agent variants) | Inconsistent agent identity | Standardize on agent-present vs no-agent campaign types |
| Supabase stage_code metadata | 924 rows tagged S2 incorrectly for selector | Re-tag; do not change body text |

### Rewrite

| Group | Issue |
|-------|-------|
| None identified at body-text level in audit sample | Bulk catalog is homogeneous short probes — quality issue is **coverage and metadata**, not individual copy |

### Retire (do not delete in this pass)

| Group | Count | Rationale |
|-------|-------|-----------|
| Duplicate `consider_selling` variants per language | ~60/language | After canonical variant selection, archive extras to reduce selector noise |
| Unused languages with zero send history | 14 languages × ~60 | usage_count=0; evaluate against owner demographic data before retirement |

### Missing template required (critical)

| Priority | use_case | Languages | Stage |
|----------|----------|-----------|-------|
| P0 | ownership_check | EN (promote local), ES (promote local), **RU (new)** | S1 T1 |
| P0 | ownership_check_follow_up | EN, ES, RU | S1 T2+ |
| P0 | consider_selling + safe_for_auto_reply | EN, ES, RU | S2 |
| P0 | asking_price (align use_case name) | EN, ES, RU | S3 |
| P0 | price_works_confirm_basics | EN, ES, RU | S4A |
| P0 | price_high_condition_probe | EN, ES, RU | S4B |
| P0 | offer_reveal_cash (+ creative variants) | EN, ES, RU | S5 |
| P1 | not_interested, wrong_person, already_listed | EN, ES, RU | cross |
| P1 | All `*_follow_up` use cases | EN, ES, RU | S1–S6 |
| P1 | who_is_this | ES, RU | cross |
| P2 | S6 contract/signature/title templates | EN, ES, RU | S6 |
| P2 | Novation/disposition (if creative path enabled) | ES, RU | S5–S6 |

---

## Workflow / Campaign Linkage

| Template layer | Linked workflows | Linked campaigns |
|----------------|------------------|------------------|
| Supabase catalog | Referenced by `template-selector.js`, `template_resolver.js`, `queue-outbound-message.js` | Cold outbound via `sms_campaigns` / `campaigns` feeder |
| Local registry | Emergency injection in `template-selector.js` | Not campaign-linked |
| V2 workflow nodes | `action.enqueue_sms` specifies `template_key` / `use_case` (proof mode, `live_send_blocked`) | Enrollment via master orchestrator |

**Current assignment count:** Not tracked per-template in `sms_templates`; queue rows carry `use_case_template` in metadata.

---

## Segment & Compliance Notes

- Target: **≤160 chars / 1 GSM segment** for first-touch cold outbound
- Local ownership templates: ~80–120 chars (compliant)
- Supabase multilingual `consider_selling`: generally 1 segment in Latin scripts; Cyrillic/Greek may be 1–2 segments
- Opt-out: No template body includes STOP language in audit sample — compliance relies on upstream opt-out guard + `system_opt_out_suppression` workflow
- `reply_mode` and `allowed_property_groups` populated on safe template only

---

## Document References

- Strategy spec: `acquisition_automation_s1_s6_strategy_spec.md`
- Reply transitions: `acquisition_reply_transition_matrix.md`
- Implementation backlog: `acquisition_automation_strategy_implementation_backlog.md`