# Hardcoded Seller-Facing Copy Inventory

Scope: seller-facing outbound message copy hardcoded in the API/dashboard (not logs, API errors, or internal UI text).

## Dispatch reality (verified)

Every automated send path resolves a message body from a **template** and fails closed without one — no anonymous hardcoded
string is ever dispatched via autopilot:

- `apply-inbound-automation-decision.js` render requires `template.template_body` → returns `template_body_missing` otherwise (line ~1022).
- `autonomous-seller-reply.js`, `execute-referral-automation.js` render from `template.template_body`.
- `execute-autonomous-reply.js` requires a non-empty `message_body` (fails closed, line ~42).
- Grep for an `insertSupabaseSendQueueRow`/`enqueueSendQueueItem` call with a string-literal `message_body`: **none**.

So the hardcoded copy below is **review-suggested text**, not autopilot output.

## A. `coverage-net/safe-fallback.js` — stage×uncertainty clarifiers (review suggestions)

`FALLBACK_MATRIX` = 7 uncertainty types × 6 stage buckets = **42 clarifier strings**, plus 1 generic fallback. Surfaced by
`ensure-inbound-coverage.js` only when `should_queue_reply` is false; it sets `should_mark_human_review = true` and never flips
the auto-reply gate. `coverage-contract.js` uses the presence of `suggested_text` only to classify coverage state
(`SAFE_FALLBACK`). None of these dispatch.

| file:line (block) | stage bucket → canonical stage | uncertainty (outcome) | language | trigger | existing template equivalent | currently measurable | proposed canonical key | recommendation |
|---|---|---|---|---|---|---|---|---|
| safe-fallback.js:77–82 (`identity`) | S1–S6 | ownership uncertainty | English | inbound unclear + low confidence, ownership not confirmed | `ownership_check` / `who_is_this` | no (no template_id on suggestion) | `fallback_identity_clarifier_{stage}` | operator-only review suggestion; migrate to review-tagged templates if these begin dispatching |
| safe-fallback.js:85–90 (`intent`) | S1–S6 | intent uncertainty | English | unclear intent | `consider_selling` | no | `fallback_intent_clarifier_{stage}` | operator-only review suggestion |
| safe-fallback.js:93–98 (`price`) | S3/S5 mainly | price ambiguity | English | monetary ambiguity / `asking_price_needs_clarification` | `seller_asking_price` | no | `fallback_price_clarifier_{stage}` | operator-only review suggestion |
| safe-fallback.js:101–106 (`condition`) | S4 mainly | condition uncertainty | English | condition unclear | `condition_probe` | no | `fallback_condition_clarifier_{stage}` | operator-only review suggestion |
| safe-fallback.js:109–114 (`offer`) | S5 | offer response uncertainty | English | offer reaction unclear | `offer_reveal_cash` | no | `fallback_offer_clarifier_{stage}` | operator-only review suggestion |
| safe-fallback.js:117–122 (`contract`) | S6 | contract-path uncertainty | English | contract-phase unclear | `asks_contract` | no | `fallback_contract_clarifier_{stage}` | operator-only review suggestion |
| safe-fallback.js:125–130 (`language`) | S1–S6 | language preference | **Bilingual (ES + EN)** | non-English detected but continuity unresolved | none (this is the ask-preference bridge) | no | `fallback_language_preference_{stage}` | operator-only review suggestion. NOTE: the EN half here is a one-time preference bridge in a review suggestion, NOT an autopilot English fallback — the autopilot template selector still fails closed on missing language (`language_template_missing`). |
| safe-fallback.js:134 (`GENERIC_SAFE_FALLBACK`) | any | generic | English | matrix miss | none | no | `fallback_generic_clarifier` | operator-only review suggestion |

## B. `templates/local-template-registry.js` — 85 keyed local templates

These are hardcoded template **bodies** but each carries `use_case`, `variant_group`, `language`, `sequence_position`, and (for
auto-reply) an approval record with `content_hash` in `LOCAL_NEGOTIATION_AUTO_REPLY_APPROVALS`. They are the approved local
fallback registry used only when the DB catalog lags, gated by `verifyLocalAutoReplyApproval` (env-approved, hash-matched,
strategy-allowed, kill-switch). They are **keyed and versioned**, not anonymous.

| file | count | stage/use_case coverage | language | currently measurable | recommendation |
|---|---|---|---|---|---|
| local-template-registry.js | 85 | ownership_check (+follow-up), consider_selling_follow_up, asking_price_follow_up, condition/creative probes, offer reveals (cash/lease/subject-to/novation), MF underwrite, negotiation (justify/timeline/narrow), close handoff | English (+ some ES) | partially (content_hash + approval version, not a KPI-joined template_version_id) | **keep** as canonical local registry; promote to `sms_templates` rows with immutable `template_version_id` (see template system audit) so KPIs attribute to them |

## C. `ownership-interest-combo-experiment.js` (this branch)

Internal-only draft (EN+ES), dormant, canary-phone gated, not in `LOCAL_TEMPLATE_CANDIDATES`. Recommendation: **keep as internal
experiment**; promote to `sms_templates` with a version id if/when the experiment is approved for activation.

## Summary

- Seller-facing hardcoded copy that could reach a seller via autopilot: **0** (all autopilot sends are template-resolved, fail-closed).
- Hardcoded review-suggestion clarifiers: **43** (safe-fallback matrix + generic) — operator-only, recommend migrating to
  review-tagged canonical templates so they gain `template_id`/version attribution if they ever dispatch.
- Hardcoded keyed local templates: **85** — keep; promote to versioned `sms_templates` rows for KPI attribution.
