
## 11. Deal economics gate (owner P0 2026-10-10)

Owner: "We have all the data on the property. We should know what's a deal and what isn't. A seller asking $3M on a $174K property should never be in Priority."

**Verdict** (`inbox/deal-economics-gate.js`, `assessDealEconomics`). Ask ÷ reference value, per asset lane.
- Reference: the latest `property_acquisition_scores.valuation_mid` (canonical). It is *credible* at valuation_confidence ≥ 50 and ≥ 3 comps; otherwise low confidence. A PAS mid more than 3× off the AVM is contaminated: a low-confidence one yields to `properties.estimated_value`; a credible one is demoted to low confidence. No PAS → the AVM, low confidence. No value at all → `unknown` (never a deal, never junk).
- Bands (credible / far above with a credible value / far above with a low-confidence value / too low): SFR 1.25 / 2.0 / 2.5 / 0.15; MF 2–4 1.3 / 2.0 / 2.5 / 0.15; MF 5+ 1.35 / 2.0 / 2.5 / 0.10; land/other 1.5 / 2.5 / 3.0 / 0.10. Any lane: more than 1.5× ARV is far above. Below $10K is `ask_implausibly_low`.
- `classify.js` computes it on every ask (`price_parse.deal_economics`). A far-above ask is read as `asking_price_implausible` (rule `price_far_above_value`), exactly like the existing 2.5×-AVM plausibility rule.

**Priority gate** (`reply-actionability.js` `resolvePriorityGate`, used by the writer).
- `asking_price_provided` is Priority only inside the credible band. Stretch, unknown value or too low → New Replies.
- Interest without an ask (`asks_offer`, `seller_interested`, `contract_requested`, call requests) is Priority only with good identity: a linked property, no non-owner / wrong-number disposition, and no earlier far-above ask on the thread.
- `asking_price_implausible` → stored `follow_up` (the **Price gap** nurture; was `cold`). Never Priority, never New Replies, never HOT. Follow-ups keep running.

**Reader.** JS mirror `in_price_gap`; PROPOSED view `PROPOSED_20261010120000_inbox_price_gap_gate.sql` (round 9 + `f_price_gap`; supersedes the round-9 file). Priority, New Replies, Unclear and HOT all exclude `f_price_gap`.

**Pipeline projection.** `asks_offer` projects Offer Interest, not Offer (an offer needs a recorded offer event); an implausible ask never projects Asking Price.
