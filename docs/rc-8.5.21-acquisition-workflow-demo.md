# rc-8.5.21: the non-contacting acquisition workflow demo

The demo runs the whole acquisition chain for one seller reply, end to end. It never contacts anyone:

- All fixtures are sanitized. The person, phone numbers, address, comps and investor purchases are fictional.
- It runs on a disposable PostgreSQL 17.
- The provider is simulated and throws on any TextGrid call.
- `fetch` is trapped, and so is every read of a TextGrid or Twilio credential.

**Test:** `apps/api/tests/critical/v3fix-acquisition-workflow-demo-8521-pg.test.mjs`.

**Reproduce:**

```
AGENT_PG_TEST_DB_URL=postgres://postgres@127.0.0.1:<port>/postgres \
DEMO_ARTIFACT_PATH=/tmp/demo.json \
node --experimental-strip-types --import ./tests/register-aliases.mjs --test \
  tests/critical/v3fix-acquisition-workflow-demo-8521-pg.test.mjs
```

The tables below quote the artifact rows the test wrote, with the clock at 2026-10-19T15:00Z.

**The thread.**

| | Text | Our question kind |
|---|---|---|
| ours | "Hi Sam, this is Jon. Do you still own 100 Demo Ln?" | ownership |
| seller | "Yes I still own it" | |
| ours | "Would you consider an offer on it?" | interest |
| ours | "What price would you be looking for?" | asking price (asked once) |
| **seller** | **"Maybe. You tell me what you'd pay, the roof needs work"** | |

## 1. Seller response → intent

The deterministic classifier makes the call. No model is used.

| Field | Value |
|---|---|
| primary_intent | `asks_offer` |
| compliance_flag | `null` (no stop of any kind) |
| confidence | 0.98 |

## 2. → the correct property

The thread's single attribution rule (`attributeInbounds`) resolved the reply:

| Field | Value |
|---|---|
| property_id | `demo-p1` |
| basis | `answers_open_question` |
| ambiguous | `false` |

## 3. → property facts

The canonical fact ledger built from the thread:

| Fact | Value |
|---|---|
| stage | **`S5_offer`**. The price was withheld after one ask, so the next step is research and then a gated offer recommendation. The condition question is not asked first. |
| next_missing | `null` |
| asking_price | `null` (none was given, and none is invented) |
| asking-price question | asked 1×, answered `false`, deflected `true` |
| condition | repairs needed: roof ("the roof needs work") |
| offer requests | 1 |

## 4. → sold comps

| Comp | Sold price | Sold date | Sqft |
|---|---|---|---|
| demo-sold-1 | 330,000 | 2026-01-15 | 1,772 |
| demo-sold-2 | 338,000 | 2026-02-15 | 1,784 |
| demo-sold-3 | 342,000 | 2026-03-15 | 1,796 |
| demo-sold-4 | 348,000 | 2026-04-15 | 1,808 |
| demo-sold-5 | 355,000 | 2026-05-15 | 1,820 |
| demo-sold-6 | 362,000 | 2026-05-15 | 1,832 |

There are also 12 fictional nearby investor purchases, from 248,000 to 292,000.

## 5. → valuation confidence

| Field | Value |
|---|---|
| as-is value | 341,900 (low 318,600, high 365,200) |
| confidence | 77 |
| comps used | 6 |
| basis | `sold_comps_repair_differential_adjusted` |

## 6. → lane economics (`laneValuation`)

`laneValuation` is pure. Its output is analysis only (`analysis_only_not_persisted_not_spendable`). The MAO is a **ceiling**, never the opening.

| | Production formula | Owner SFR lane (`sfr_lane: true`) |
|---|---|---|
| lane | `sfr` | `sfr` |
| formula | `repair_adjusted_exit_ceiling_less_assignment_target` | `sfr_llc_investor_cluster_less_13pct` |
| MAO (ceiling) | 207,300 | 204,600 |
| opening (engine `planOffer`) | 176,400 | 176,400 to 190,000 |
| decision tier / offer-ready | `AUTO_RANGE_OFFER` / `offer_ready` | |

The investor cluster mid is 235,200. It is authoritative, from `weighted_nearby_investor_purchase_quantiles`.

**HOT gate (`classifyOpportunityEconomics`).** Only an economic ask can be HOT:

| Seller ask | Class | Reasons |
|---|---|---|
| 195,000 (at or below the 207,300 MAO) | **HOT** | `ask_at_or_below_authoritative_mao`, `buyer_demand_strong`, `execution_complexity_low` |
| 520,000 (uneconomic) | **NURTURE** (never HOT) | `price_gap_above_authority` |
| no ask (this thread) | **INVESTIGATE** (never HOT) | `no_seller_stated_price` |

## 7. → the best next action

`decideActions` is deterministic. Its result is `offer_request_research_then_authorized_offer`, with these actions:

1. `UPDATE_SELLER_FACTS`
2. `RESEARCH_PROPERTY` (`offer_request_valuation`)
3. `PREPARE_OFFER` (`offer_request`)

## 8. → prepared work

There is no reply text, no number and no send.

**Offer recommendation:** 176,400. It comes from the engine's opening, strictly below the 207,300 ceiling, and is marked `sent: false`.

**The negotiation authority's verdict** is `ESCALATE_TO_OPERATOR`, reason `prepare_offer_requires_negotiation_authority`. This is the escalation outside authority: no envelope exists, so a person decides whether any number is offered.

**The prepared reply** is a DRAFT. It is written as a non-sendable `paused_operator_review` row and is never queued.

## 9. → permitted internal actions executed, and 10. → durable outcomes

| Durable artifact | Row |
|---|---|
| `followup_intents` | `offer_recommendation_review`, state **held**, reason `offer_recommendation_requires_authorization`. The recommendation and the ceiling are on the row, flagged review-required. |
| `send_queue` | `demo:draft:i2` → `paused_operator_review` (a draft; not sendable) |
| `inbox_thread_state` | stage `S5_offer`, disposition `interested` |
| canonical writer refusal | A sendable write to a contact with a `property_do_not_contact` restriction on this property was refused: `enqueue_contact_restricted:property_do_not_contact` |
| sendable rows created | **0** |

**Transport:** 0 TextGrid calls, 0 network calls, 0 credential reads.

## Invariants the test asserts

- **A draft is never a send.** No queued, scheduled, sent or delivered row exists for any demo key, and the provider was never called.
- **An uneconomic property is never HOT.** An ask far above the MAO is `NURTURE`, and no ask is `INVESTIGATE`. HOT needs an ask at or below an authoritative, spendable MAO.
- **No invented offers.**
  - The ledger records no asking price, because the seller gave none.
  - The only number is the engine's opening, which is strictly below its own ceiling, never sent, and escalated for authorization.
  - The decision never asks the condition question before the price.
