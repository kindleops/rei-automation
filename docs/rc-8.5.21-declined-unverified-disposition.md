# `declined_unverified` disposition — consumer and writer table (rc-8.5.21, owner decision 3, 2026-10-17)

- **Meaning:** a polite decline or bare "Not interested" to the OWNERSHIP question. Ownership is UNVERIFIED, and the contact is held for that property × contact.
- **What it never is:** the 30-day nurture (that is `not_interested`), a suppression, or a denial fact.
- **Line numbers** are at a18e07a3, before this change.
- **Column:** `inbox_thread_state.disposition` is plain `text` with no CHECK, so no DB change is needed. The code gate is the lead-state registry.

| file:line (a18e07a3) | role | other dispositions today | `declined_unverified` before this change | `declined_unverified` NOW |
|---|---|---|---|---|
| api `lead-state/universal-lead-state-registry.js:130-156, 301-314, 369-375` | registry / normalize gate | defines the 10 codes; unknown → `none` | folded to `none` on every write | **First-class code** with META label "Declined · Ownership Unverified"; aliases `declined_unverified` and `ownership_declined_unverified` |
| dashboard `domain/lead-state/universal-lead-state-registry.ts:80-98, 253-266` | registry mirror (UI select / labels) | same | shown as "None"; a manual commit overwrote it | **Mirrored** (order, META, aliases) |
| api `classification/inbound-intent-ontology.js` (ownership_declined_unverified) | declarative hint | not_interested hints etc. | `none` | **`declined_unverified`** |
| api `seller-flow/resolve-seller-stage-transition.js:559-650` BLOCKING_INTENTS | WRITER (stage transition) | wrong_* → WRONG_*, non-owner → UNQUALIFIED, sold → SOLD, not_interested → nurture | fell to the neutral path and carried the current value | **New entry:** disposition DECLINED_UNVERIFIED, contactability null, NO ownership_patch (never not_owner), follow-ups cancelled, no review |
| api `inbox/resolve-inbox-state-from-classification.js:356-361, 484-486, 757-781` | WRITER (classification sync) + derived bucket | suppressed/wrong → dead; isOwnershipUnverified → unqualified; not_interested → `dead` (derived) / `not_interested` | bucket `new_replies`, and disposition **NULL** (attention-bucket rule) | **Writes `declined_unverified`** before the probe and attention rules. Intent is in CLOSED_FOR_PROPERTY_INTENTS (Dead). Derived bucket is `dead` |
| api `lead-state/patch-universal-lead-state.js:409, 449` | WRITER (authoritative) | normalized | stored `none` | Stored as is (registry) |
| api `seller-flow/seller-flow-decision-contract.js:184-187, 321` | WRITER (carries transition.disposition) | — | current value | Gets DECLINED_UNVERIFIED from the transition; no file change |
| api `seller-flow/latest-intent-precedence.js:74-76` | WRITER/C (reopen on positive reply) | not_interested / no_response / unqualified reopen to interested | never reopened | **Added to NEGATIVE_PRIOR_DISPOSITIONS:** a genuine later seller engagement supersedes the hold (owner rule 3) |
| api `followups/followup-execution.js:108-135` | C (follow-up execution) | terminal → skip; not_interested → NOT_INTERESTED_NURTURE | **falls to STAGE_SILENCE → `ownership_check` re-ask** | **NOT CHANGED HERE: owned by the P0 follow-up agent.** It must be added to TERMINAL_DISPOSITIONS (or a dedicated skip `ownership_declined_hold`) on rc-8.5.21-followup-p0 |
| api `seller-flow/seller-followup-scheduler.js` | C (intent-keyed) | not_interested → 30 d | `no_followup_rule_for_intent` (no nurture) | unchanged (safe); next_action is `end_outreach_in_scope`, so it is never called |
| api `seller-flow/no-response-followup.js:82, 147` | C (S2/S3 nudges) | non-owner dispositions ineligible; not_interested not in the set | **eligible** | **In NON_OWNER_DISPOSITIONS, and the intent in DISQUALIFYING_INTENTS:** never nudged |
| api `seller-flow/delivery-triggered-followup.js` | C | no disposition read | n/a | n/a (send-time guard covers it) |
| api `queue/send-time-contact-guard.js:116-125, 258-267` | C (every outbound) | wrong_* phone-wide; non-owner property-scoped | no match on the disposition | **PROPERTY_SCOPED_DECLINED includes `declined_unverified`** ⇒ OWNERSHIP_DECLINED_HOLD (deferred) for THAT property only |
| api `campaigns/opener-reply-exclusion.js:50-73` | C (campaign planner) | same sets | no match | **Same set:** excluded for that property, skip reason `ownership_declined_unverified_hold` |
| PROPOSED `20261016155000_campaign_graph_prior_reply_not_owner.sql` helper | C (graph refresh) | reads contact_property_resolution only | blocked by the role row | unchanged (returns `ownership_declined_unverified`) |
| api `queue/ownership-recontact-guard.js` | C | message text + resolution store | unaffected | unchanged |
| api `agent/operations/conversation-facts.js:146-172` verifyContactPermission | C (permission checker) | suppressed / wrong / sold → blocks | not detected | **`disp === 'declined_unverified'` ⇒ block `ownership_declined_unverified`**; ownership `declined_unverified` (never confirmed, never a denial) |
| api `agent/operations/recovery-classifier.js:123-127` + `recovery-linkage.js` | C (historical recovery) | not_interested → nurture program | continued to detections | **New class `ownership_declined_hold`** ⇒ action `none_ownership_declined_unverified_hold` |
| api `agent/operations/dead-deal-correction.js:51` | C (recovery plan) | skips suppression / wrong_owner | **planned a 30-day nurture** | **Skipped (`ownership_declined_unverified_hold`)** |
| api `agent/operations/ownership-evidence.js:37-39` nurtureIntentFor | C (recovery nurture intent) | not_interested → 30-day intent | not excluded | **null (`ownership_declined_unverified_hold`)** |
| api `agent/operations/action-center.js:123, 168` | C | not_interested → schedule the 30-day | not blocked | Blocked through the permission checker (`!permitted`); never reaches `:168` |
| api `agent/operations/supervisor-checks.js` | — | no disposition reads | n/a | n/a |
| PROPOSED `20261010120000_inbox_price_gap_gate.sql:53-60, 75-78` (v_inbox_thread_state_buckets, written, not applied) | C (inbox buckets, in_* flags) | sold/unqualified → dead; not_interested → follow_up | `new_replies` / in_unclear | **`declined_unverified` → dead; in `f_closed_disposition`; the intent in `f_reply_resolved` / `f_thread_resolved`** |
| applied `20261001160000_new_replies_genuine_engagement.sql` view | C (live view) | same | inbound → new_replies (only when inbox_bucket is NULL) | Live writers set inbox_bucket explicitly (dead). The backfill REFUSES unless the deployed view maps the value |
| api `inbox/inbox-bucket-predicates.js:59, 341-347, 384` | C (JS mirror of the view) | CLOSED = sold / unqualified | new_replies | **CLOSED_DISPOSITIONS includes it ⇒ dead** |
| api `inbox/reply-actionability.js:36-51, 163, 251` | C (Priority / heat / terminal) | non-owner dispositions terminal / no Priority | could reach Priority | **Terminal, never Priority; the intent is non-actionable** |
| api `email/email-seller-followup-lane.js:32` | C (email follow-ups) | never-set | not in the set | **The intent is in NEVER_INTENTS** |
| api `conversation-ai/followup-reevaluation.js:21` | C (AI follow-up re-eval) | DISINTEREST set | not in the set | **The intent is in DISINTEREST** |
| api `conversation-ai/**`, `lib/ai/**` (AI writer) | — | no disposition reads (intent / ledger) | — | already handled by intent (decideActions ⇒ NO_RESPONSE) |
| api analytics (`analytics/lab/metric-registry.js` etc.) | — | `disposition` there is the send outcome / buyer dispo, not thread disposition | — | unaffected; the label comes from the registry |
| dashboard `UniversalLeadStateControls.tsx`, `DealIntelligence25Panel.tsx`, `InboxCommandMap.tsx` | C (labels / select) | registry-driven | "None" | registry change |
| dashboard `modules/inbox/utils/participantLabels.ts:177` | C (seller authority) | wrong_person contradicts authority | not flagged | **Added to OWNERSHIP_CONTRADICTION_FLAGS** (never shown as verified authority) |
| dashboard `modules/inbox/desk/ledger-model.ts:452` | C (nurture lane) | follow_up + not_interested → nurture | — | not reached (bucket is dead) |
| one-off repair scripts (`new-replies-cleanup*.js`, hygiene PROPOSED, `reconcile-universal-lead-state.mjs`) | W (historical) | write not_interested etc. | — | not reused; legacy rows go through PROPOSED_20261017110000 only |

**Legacy records:** `supabase/migrations/PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill.sql` (plus `_dryrun`, `_rollback`, pre/posttests).
- **Cohort (evidence-backed only):** `disposition = 'not_interested'` AND a contact_property_resolution row with role `ownership_declined_unverified` for that phone × property.
- **Writes:** the disposition only. The backup table enables an exact rollback, which refuses if a row was re-dispositioned since.
- **Preconditions:**
  - role migration applied;
  - the deployed bucket view maps the value;
  - the pinned dry-run count matches.
- **Posttest (disposable DB) proves:**
  - every other thread column, sms_suppression_list and contact_property_resolution are byte-identical;
  - dispositions changed only on the cohort;
  - the derived bucket changes only cohort follow_up → dead (the intended no-nurture outcome).
- **Production count:** PROVISIONAL. Run the `_dryrun.sql` SELECT (BEGIN READ ONLY, statement_timeout 15s) after the role migration and the authorized correction.
