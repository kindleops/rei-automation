# STAGES 1–6 — FOUNDATION + SAFE NET — FINAL REPORT

Pass scope (user-approved): **Audit foundation + safe-net fixes**, anonymized
fixtures, no full routing consolidation, no deletion of unproven-dead code.

## 1. Current intent count
**19** canonical live intents (`classify.js` `INTENT_PRIORITY`). Reconciled to one
vocabulary via `coverage/canonical-intent-aliases.js`. 7 contact-identity classes;
10 unknown-number buckets.

## 2. Current template count by stage/use-case
Templates are runtime-resolved from the store, not static files. The **router
requests** ~30 distinct use-cases across S1/S1F/S2–S6 + cross-stage (inventoried
in `04-template-gap-report.md`). Coverage does not depend on store contents —
the safe fallback is store-independent.

## 3. Historical messages audited
**0 this pass** — live production replay deferred per scope decision (synthetic +
contract verification used instead). Plan in `08-next-consolidation-sequence.md` §8.

## 4. Synthetic scenarios tested
**1,862** generated combinations (7 stages × 19 intents × 7 identities × 2
confidence bands) in `coverage-matrix.json`, all re-run live in the critical test
`stages-1-6-coverage-contract.test.mjs` (≥1,500 assertions in the grid gate) plus
9 targeted adversarial/unit tests.

## 5. Classification coverage %
**100%** — every canonical intent resolves to a defined classification + canonical
normalization; unknown labels deterministically collapse to `unclear` (which has a
defined process).

## 6. Routing coverage %
**100%** — every (stage × intent × identity × band) yields a routed decision with a
`next_action` and a guaranteed `scheduled_next_action`. 0 unowned.

## 7. Template-or-no-send coverage %
**100%** — each decision is one of: routed reply (`direct`), prepared stage-aware
safe clarifier (`safe_fallback`), intentional no-send with next action
(`no_reply_action`), or owned human workflow (`human_exception`). No
`missing_coverage`.

## 8. Follow-up / terminal coverage %
**100%** — every owned exception workflow defines an SLA, an automatic fallback
action, and a terminal resolution; every decision carries `scheduled_next_action`.

## 9. Remaining "Needs Review" by explicit reason
No generic dead-end review remains. Human-review now always routes to an owned
workflow: `suppression_confirmed`, `safety_hold`, `legal_compliance_hold`,
`identity_clarification`, `conflicting_property_identity`, `ambiguous_context`,
`language_unsupported`, `attachment_manual_processing`,
`technical_classification_failure`, `duplicate_out_of_order` — each with owner +
SLA + fallback + terminal.

Matrix distribution (1,862 rows): `direct_coverage` 735 · `safe_fallback_coverage`
931 · `human_exception_with_owned_workflow` 98 · `no_reply_action_coverage` 98 ·
`missing_coverage` **0**.

## 10. Gaps found
See `01-competing-source-inventory.md` (3 divergent intent vocabularies; 2 dead
modules; sparse safety policy) and `05-classifier-routing-followup-gap-report.md`
(C1–C6 / R1–R5 / F1–F5).

## 11. Templates / use-cases added
No store templates added this pass (coverage achieved via store-independent safe
fallback). Backlog of ~30 prioritized use-cases in `07-template-use-case-backlog.md`.

## 12. Classifier / router fixes
- Single canonical intent normalizer (`canonical-intent-aliases.js`); live decision
  normalizes `primary_intent` (no-op for canonical input).
- `wrong_person ≡ wrong_number` suppression unified (live + diagnostic table) — test-locked.
- Coverage net (`ensure-inbound-coverage.js`) makes every decision carry
  canonical_intent, contact_identity, safety_status, reply_disposition, owned
  exception workflow + SLA, stage-aware safe fallback, and scheduled_next_action.
- Stage-aware safe fallback matrix (`safe-fallback.js`) replaces the single generic clarifier.
- Dead `intentMap.js` / `next_action_from_classification.js` annotated `@deprecated` + isolated (not deleted).

## 13. Stage-by-stage readiness
| Stage | Coverage | Notes |
|---|---|---|
| S1 Ownership | ✅ | identity-aware; suppression unified |
| S1F Follow-up | ✅ | follow-up SLAs + reengagement path |
| S2 Consider Selling | ✅ | routed + safe fallback |
| S3 Asking Price | ✅ | price-response routing + price clarifier |
| S4 Condition | ✅ | condition/occupancy routing + clarifier |
| S5 Offer | ✅ | offer clarifier; no auto-commit |
| S6 Negotiation/Close | ✅ | contract clarifier; close handoff |

Coverage (no dead end) is locked at all stages; **reply-quality breadth** (template
variants, context-conditioned yes/no, language) remains backlog.

## 14. Stage 7 prerequisite backlog
Steps 1–4 in `08-next-consolidation-sequence.md` (re-key safety policy, stage-aware
clarifier in template path, remove dead modules, persist exception queue + SLA
dashboard) must complete before Stage 7. **Stage 7 not started.**

## 15. Tests / build results
- API **lint**: PASS.
- New critical test `stages-1-6-coverage-contract.test.mjs`: **9/9 pass** (incl. the live-engine grid, 0 missing-coverage); confirmed passing inside the full suite.
- Adjacent decision/classification tests (`auto-reply-decision`, `classification-automation-decision`, `classification-canonical-truth-table`, `seller-auto-reply-plan`): green.
- Full API critical suite (`npm run test:critical`): **3,009 / 3,017 pass — 8 fail**.
- Dashboard `tsc -b`: **PASS** (no dashboard files changed this pass).

### The 8 failures are PRE-EXISTING and OUT OF SCOPE (not caused by this work)
Failing files: `dashboard-ops-service`, `inbox-state-transition-matrix`,
`message-event-schema`, `podio-message-event-sync`, `queue-run-revision-limit`,
`inbox-live-v2-service`, `communications-state-machine` ("outbound sent →
Waiting"). All belong to the **`d67bac3` "inbox live routing" commit** that landed
on `main` during this session.

**Proof of pre-existence:** checking out `HEAD~1` (707abe0, immediately before this
commit, with the `coverage-net/` modules absent) and re-running those files yields
the **same failures** (40 pass / 6 fail across the sampled set). Repo-wide grep
confirms **none of these tests import any file changed in this commit**, and this
commit touches no inbox-realtime / send-queue / message-event / dashboard source.
The Stages 1–6 classification / routing / coverage tests all pass.

## 16. Final SHA
Recorded at push time (see commit on `main`).

## 17. Verdict
**STAGES 1–6 FOUNDATION + SAFE NET: LOCKED** for the audited scope —
classification, routing, suppression unification (`wrong_person ≡ wrong_number`),
owned exception workflows, stage-aware safe fallback, and 100% inbound coverage
(0 missing) are implemented, test-locked, lint-clean, and dashboard-typecheck-clean.
**No new automated sends introduced.**

Full end-to-end Stages 1–6 "LOCKED" still requires the consolidation steps in
`08-next-consolidation-sequence.md` **and** resolution of the 8 pre-existing
inbox-live/queue/message-event failures owned by `d67bac3` (out of this pass's
scope). **Stage 7 not begun**, as instructed.
