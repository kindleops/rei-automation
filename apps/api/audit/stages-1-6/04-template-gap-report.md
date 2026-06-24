# Stages 1–6 — Template Gap Report

Templates are resolved at runtime from the Templates store (Podio/Supabase) by
`use_case` + `language` + `agent_style` + `property_scope`, via
`resolve-seller-auto-reply-plan.js` and the `template_use_case_candidates` in
`apply-inbound-automation-decision.js` `ROUTE_PROFILES`. This report inventories
the **use-cases the router can request** and flags where a request currently has
no guaranteed safe answer.

## Use-cases requested by the live router (by stage)

| Stage | Requested use-case candidates |
|---|---|
| S1 Ownership | `consider_selling`, `who_is_this`, `info_source_explanation`, `how_got_number`, `wrong_person`, `not_interested_soft_close`, `unclear_clarifier` |
| S1F Follow-up | `consider_selling_follow_up`, `asking_price_follow_up`, `reengagement` |
| S2 Consider Selling | `consider_selling`, `seller_asking_price`, `asking_price` |
| S3 Asking Price | `seller_asking_price`, `price_works_confirm_basics`, `price_high_condition_probe`, `creative_probe` |
| S4 Condition | `price_high_condition_probe`, `ask_condition_clarifier`, `creative_probe`, `tenant_probe`, `mf_confirm_units`, `mf_occupancy`, `mf_rents` |
| S5 Offer | `offer_reveal_cash`, `offer_reveal_lease_option`, `offer_reveal_subject_to`, `offer_reveal_novation` |
| S6 Negotiation/Close | `justify_price`, `ask_timeline`, `ask_condition_clarifier`, `narrow_range`, `close_handoff` |
| Cross-stage | `text_only_redirect`, `sms_only_response`, `not_interested_soft_close` |

## Gaps & risk

| # | Use-case | Gap | Mitigation this pass |
|---|---|---|---|
| T1 | `unclear_clarifier` | Single non-stage-aware clarifier (`resolve-seller-auto-reply-plan.js` returns one for all stages) — violates §9 | Coverage net supplies a **stage × uncertainty** safe fallback (`safe-fallback.js`) independent of the template store |
| T2 | Spanish variants | EN templates assumed; ES variants incomplete | `language_unsupported` exception workflow + ES clarifier strings in safe fallback |
| T3 | Identity-specific variants (renter / representative / estate) | No dedicated templates; renter routed via tenant underwriting | identity now first-class on the decision (`contact_identity`); template variants are backlog |
| T4 | `wrong_person` reply template | exists as use-case but is REVIEW/suppress; ensure it never auto-advances | suppression unified; never queues |
| T5 | No-template fallback path | If template store returns nothing, plan `fallback_reply` is null | safe fallback `suggested_text` is template-store-independent |

## Coverage guarantee

Even when the template store has **no** matching row, the decision is still
covered: ambiguous → `safe_fallback_coverage` (prepared clarifier), suppress →
`direct_coverage`, hold → `human_exception_with_owned_workflow`. No request can
produce `missing_coverage`. The remaining template work (T1–T3, T5) is quality /
breadth, not coverage — tracked in `07-template-use-case-backlog.md`.
