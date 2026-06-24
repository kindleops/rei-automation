# Stages 1–6 — Template / Use-Case Backlog (prioritized)

Priority: **P0** = coverage/compliance gap · **P1** = quality/conversion · **P2** = breadth.

Coverage is already guaranteed by the safe-net fallback; this backlog raises
reply *quality* and removes reliance on the generic clarifier.

## Cross-stage / compliance

| Pri | Use-case | Target intent / identity | Strategy | Tests |
|---|---|---|---|---|
| P0 | `wrong_person_ack` | wrong_number / wrong_person | one-line apology + suppress; never advance | suppression assert |
| P0 | `opt_out_ack` (optional, compliance-safe) | opt_out | silent suppress (no marketing) — confirm legal stance | no-send assert |
| P1 | `language_es_clarifier` | unclear + ES | ES safe clarifier per stage | fallback lang test |

## S1 Ownership

| Pri | Use-case | Identity | Strategy |
|---|---|---|---|
| P0 | `identity_clarifier_s1` | unknown / probable_owner | ask owner vs not, no ownership assumption |
| P1 | `who_is_this_s1`, `how_got_number_s1` | any | trust-building, source explanation |
| P2 | `representative_s1`, `estate_probate_s1` | owner_related_contact | authority clarification |

## S1F Follow-up

| Pri | Use-case | Strategy |
|---|---|---|
| P1 | `ownership_recheck_followup`, `reengagement_long_delay` | low-pressure re-touch, market/urgency-adjusted |
| P2 | `final_low_pressure_followup` | terminal-before-suppress nudge |

## S2 Consider Selling

| Pri | Use-case | Strategy |
|---|---|---|
| P1 | `consider_selling_maybe`, `wants_offer_early` | acknowledge + redirect to price/condition |
| P2 | `text_only_preference` | honor channel preference |

## S3 Asking Price

| Pri | Use-case | Strategy |
|---|---|---|
| P1 | `price_refusal_offer_first`, `retail_expectation_reset` | reframe without committing a number |
| P1 | `price_value_confirm` | confirm captured number |

## S4 Condition

| Pri | Use-case | Strategy |
|---|---|---|
| P1 | `condition_unknown_probe`, `occupancy_probe`, `access_probe` | one question each |
| P2 | `refuses_condition` | proceed-with-caveat |

## S5 Offer

| Pri | Use-case | Strategy |
|---|---|---|
| P1 | `counteroffer_ack`, `rejection_ack`, `acceptance_confirm` | confirm-before-commit |
| P1 | `proof_of_funds`, `closing_costs`, `emd` | factual, no over-promise |
| P2 | `assignment_wholesale_explain` | transparency |

## S6 Negotiation / Close

| Pri | Use-case | Strategy |
|---|---|---|
| P1 | `justify_price`, `narrow_range`, `ask_timeline` | value framing |
| P1 | `close_handoff` | next-step / paperwork |
| P2 | `attorney_title_review`, `cancellation_request` | process + retention |

## Future S7 (Disposition) — DO NOT BUILD YET

Listed only as prerequisite (see `08-next-consolidation-sequence.md`): buyer-match
handoff templates, assignment packet, dispo outreach. **Out of scope** until
Stages 1–6 are locked and consolidation is done.
