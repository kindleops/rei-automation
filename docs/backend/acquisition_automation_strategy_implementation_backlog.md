# Acquisition Automation Strategy — Implementation Backlog

**Status:** Prioritized backlog from audit-only pass — no implementation started  
**Generated:** 2026-06-22  
**Prerequisite:** Operator strategy approval on `acquisition_automation_s1_s6_strategy_spec.md`

---

## Priority Legend

| Priority | Meaning |
|----------|---------|
| **P0** | Blocks safe live execution or causes incorrect seller journey |
| **P1** | Required for full S1–S5 automation quality |
| **P2** | S6 platform wiring and long-tail nurture |
| **P3** | Optimization, cleanup, analytics |

---

## P0 — Critical Correctness

| ID | Item | Source finding | Effort | Dependencies |
|----|------|----------------|--------|--------------|
| P0-01 | **Fix master orchestrator validation errors** — reactivate `stage_6` node with `config.blocked:true` OR remove dangling edges (`82a08034`) | 2 validation errors block graph integrity | S | Strategy approval on S6 scope |
| P0-02 | **Reconcile dual automation paths** — choose canonical: Workflow V2 vs seller-flow (`flow_map` + `next_action_from_classification`) | Inconsistent transitions | L | Architecture decision |
| P0-03 | **Promote S1 ownership templates to Supabase** — EN (5), ES (2) from local registry; **author RU S1** | Only 1 production ownership_check (Vietnamese) | M | Template QA review |
| P0-04 | **Enable `safe_for_auto_reply` on approved template set** | 1/1000 templates safe — auto-reply disabled | M | Compliance sign-off |
| P0-05 | **Fix template metadata** — re-tag 924 `consider_selling` rows; align `stage_code` with `use_case` | Selector mis-routing risk | M | P0-03 |
| P0-06 | **Align use_case naming** — `seller_asking_price` vs `asking_price` across selector, flow_map, V2 graphs | Coverage audit MISSING for `asking_price` | S | P0-05 |
| P0-07 | **V2 boolean condition runner** — support multi-key `seller_intent` branches in Interest Qualification | Unanswered vs not_interested conflation | M | P0-02 |
| P0-08 | **Direct-execution audit remediation** — `execute-autonomous-reply.js` bypasses queue processor (immediate TextGrid after queue insert) | Parallel send path outside canonical processor | M | Architecture decision |
| P0-09 | **Missing-template human-review gate** — enforce no silent English fallback per language policy | RU S1 and most ES objection templates missing | S | P0-03 |

---

## P1 — Missing Templates & Language Coverage

| ID | Item | Languages | Stage |
|----|------|-----------|-------|
| P1-01 | `ownership_check_follow_up` promote/create | EN, ES, RU | S1 |
| P1-02 | `consider_selling` safe variants | EN, ES, RU | S2 |
| P1-03 | `consider_selling_follow_up` promote/create | EN, ES, RU | S2 |
| P1-04 | `asking_price` / `asking_price_follow_up` | EN, ES, RU | S3 |
| P1-05 | `price_works_confirm_basics` + follow-up | EN, ES, RU | S4A |
| P1-06 | `price_high_condition_probe` + follow-up | EN, ES, RU | S4B |
| P1-07 | `offer_reveal_cash` (+ lease/subject/novation) + follow-up | EN, ES, RU | S5 |
| P1-08 | Objection handlers: `not_interested`, `wrong_person`, `already_listed`, `who_is_this` | EN, ES, RU | Cross |
| P1-09 | Negotiation set: `justify_price`, `narrow_range`, `ask_timeline` | ES, RU | S5 |
| P1-10 | MF underwriting templates | ES, RU | S4 |
| P1-11 | Promote all 67 local-registry candidates through QA → Supabase with metadata | EN, ES | All |

---

## P1 — Validation Errors & Duplicate Workflows

| ID | Item | Workflow ID | Action (post-approval) |
|----|------|-------------|--------------------------|
| P1-12 | Archive empty duplicate drafts | `41fdc8a9-87ae-42ac-8b5d-359d757dde85` | Archive — 0 nodes, no run history, superseded by system orchestrator |
| P1-13 | Archive empty duplicate drafts | `a0b497b2-2cd0-4241-b396-e315b82118eb` | Archive — duplicate key `owner_acquisition_follow_up_mqn6ugvb` |
| P1-14 | Resolve master orchestrator graph errors | `82a08034-c1a5-4eeb-9623-dab7e1527b52` | See P0-01 |

**Third workflow with validation errors:** The two duplicate drafts (`41fdc8a9`, `a0b497b2`) account for 2 of 3 flagged workflows. The third is the master orchestrator (`82a08034`).

---

## P1 — Timing & Cadence Changes

| ID | Item | Current | Recommended | Operator decision |
|----|------|---------|-------------|-------------------|
| P1-15 | S1 unknown-motivation default | 14–21d (V2) | **21d** default | Approve |
| P1-16 | S1 high-urgency | 14d × 0.75 | 7–10d | Approve |
| P1-17 | S2 follow-up conflict | V2: 5–7d vs legacy `latency.js`: 1d | Reconcile to single source | P0-02 |
| P1-18 | Reply latency profiles | hot 30–120s / neutral 120–300s / cold 300–900s | Keep; document in operator runbook | — |
| P1-19 | Contact window | 9:00–20:00 local | Keep; enforce in all send paths including autonomous | P0-08 |
| P1-20 | Nurture cadence | 30/60/90d | Keep for cold/not-interested | — |
| P1-21 | S1 max touches | Unbounded via schedule | Cap at 2 ownership touches before long-tail | Approve |

---

## P2 — S6 Wiring (Contract-to-Close)

| ID | Integration | Required events | Status |
|----|-------------|-----------------|--------|
| P2-01 | **Pipeline** | `verbal_yes` → `formal_contract` → `signed` → `closed` / `dead` | Not wired |
| P2-02 | **Calendar** | earnest money date, inspection, closing, extensions | Not wired |
| P2-03 | **Closing Desk** | agreement generation, title, lien resolution | Not wired |
| P2-04 | **Buyer Match** | disposition, buyer communication | Not wired |
| P2-05 | **Inbox** | S6 milestone notifications to operators | Partial |
| P2-06 | **Email Command** | contract package delivery | Not wired |
| P2-07 | **Workflow Studio** | unblock `system_offer_follow_up`; wire `trigger.offer_sent` | Blocked |
| P2-08 | **Entity Graph** | title/lien entity resolution | Not wired |
| P2-09 | **Deal Intelligence** | comp validation at close | Partial (S5) |
| P2-10 | **E-sign / documents** | signature status webhooks → pipeline | Not wired |
| P2-11 | S6 template family | contract_sent, title_intro, day_before_close, post_close_referral | Missing (local only: close_handoff) |

---

## P2 — Offer Engine Integration

| ID | Item | Detail |
|----|------|--------|
| P2-12 | Auto-send policy lock | Define confidence + financial-risk thresholds per asset class |
| P2-13 | Auto-send denylist | Probate, portfolio bulk, commercial 5+, environmental — never auto |
| P2-14 | Counteroffer → engine feedback loop | Persist counter as structured fact; re-run `acquisitionDecisionEngine` |
| P2-15 | Negotiation limits | Max auto-counter iterations; escalation to human review |
| P2-16 | Creative path gates | Novation/subject-to/lease-option template + engine branches |
| P2-17 | V2 S5 graph live send | Remove `live_send_blocked` only after P0/P1 complete |

---

## P2 — Testing & Rollout

| ID | Item | Acceptance criteria |
|----|------|---------------------|
| P2-18 | Dry-run harness for S1–S5 full journey | Enrollment → classification → template → queue row (no TextGrid) |
| P2-19 | Template selector integration tests | Every required use_case × language resolves or hits review gate |
| P2-20 | Classification → transition regression suite | Matrix rows covered with fixture messages |
| P2-21 | Cadence integration tests | Follow-up scheduled_at matches motivation-adjusted baseline |
| P2-22 | Shadow mode rollout | `operational_mode: active_safe` → monitor → `live_send_enabled` per workflow |
| P2-23 | Credit burn monitoring | S1 long-tail vs aggressive A/B telemetry |

---

## P3 — Cleanup & Analytics

| ID | Item |
|----|------|
| P3-01 | Archive duplicate `consider_selling` variants (~60/language) after canonical selection |
| P3-02 | Evaluate 14 non-EN/ES/RU languages with zero `usage_count` against owner demographics |
| P3-03 | Join `send_queue` / `message_events` to `template_id` for performance analytics |
| P3-04 | Retire `template_resolver.js` CSV catalog path if Supabase becomes sole source |
| P3-05 | Workflow Studio analytics on template resolution failures |

---

## Suggested Implementation Sequence

```
Phase 1 (P0): Graph fix + path reconciliation + metadata + S1 templates
Phase 2 (P1): Full EN/ES/RU template promotion + safe_for_auto_reply + condition runner
Phase 3 (P1): Cadence lock + max-touch caps + autonomous path alignment
Phase 4 (P2): Offer engine policy + S5 live send (shadow → prod)
Phase 5 (P2): S6 platform wiring (Pipeline, Calendar, Closing Desk)
Phase 6 (P2): End-to-end testing + staged rollout
Phase 7 (P3): Cleanup + analytics
```

---

## Operator Decisions Blocking Implementation

1. Canonical automation path: Workflow V2 only vs hybrid with seller-flow
2. S1 default cadence: 21d unknown vs 14d
3. S1 max ownership touches before long-tail suppress
4. Offer auto-send threshold and asset-class denylist
5. S6 scope: Offer Follow-Up only vs full contract-to-close platform
6. Auto-reply policy: enable safe template set vs human-review-only
7. Archive authorization for duplicate draft workflows
8. Russian (and other language) template authoring budget

---

## Document References

- Strategy spec: `acquisition_automation_s1_s6_strategy_spec.md`
- Template matrix: `acquisition_sms_template_matrix.md`
- Reply transitions: `acquisition_reply_transition_matrix.md`
- Workflow inventory: `workflow_studio_v2_system_workflow_audit.md`