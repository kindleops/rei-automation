# Stages 1–6 — Current Intent Inventory

## Canonical (LIVE) intents — `classify.js` `INTENT_PRIORITY` (19)

Priority order (first match wins in `pickPrimaryIntent`):

1. `opt_out` — STOP/unsubscribe/DNC → **suppress**
2. `wrong_number` — wrong number / not owner / sold → **suppress** (≡ `wrong_person`)
3. `who_is_this` — identity challenge → identity response
4. `hostile_or_legal` — threats / attorney / harassment → **safety hold**
5. `not_interested` — declines → do-not-reply + nurture
6. `need_time` — later / not ready → scheduled follow-up
7. `seller_interested` — open to selling → price discovery
8. `asking_price_provided` — gives a number → price-response
9. `asks_offer` — "make me an offer" → price/condition probe
10. `callback_requested` — wants a call → text-only redirect
11. `property_correction` — wrong property type/address → review (conflicting identity)
12. `ownership_confirmed` — confirms owner → consider-selling
13. `latent_interest` — soft interest → price discovery
14. `tenant_occupied` — renter/tenant → rental underwriting
15. `condition_disclosed` — condition info → condition follow-up
16. `info_request` — how/why/company → info-source explanation
17. `reaction_only` — emoji/reaction → ambiguous review
18. `acknowledgement` — "ok"/"thanks" → ambiguous review
19. `unclear` — fallback → ambiguous review + safe fallback

## Supporting classifier fields

`primary_intent`, `detected_intent` (alias), `objection`, `emotion`,
`compliance_flag` (`stop_texting`), `confidence` (0–1), `motivation_score`,
`language`, `source` (`ai`/`heuristic`).

## Objections (drive review/risk)

- `HIGH_RISK_OBJECTIONS`: `financial_distress`, `probate`, `divorce` → review if conf < 0.9
- `REVIEW_ONLY_OBJECTIONS`: `wants_proof_of_funds`, `property_correction` → always review
- routing objections: `needs_call`, `needs_email` → text-only redirect

## Contact-identity classes — `contact-identity.js` (7)

`confirmed_owner`, `probable_owner`, `owner_related_contact`, `renter_occupant`,
`wrong_person`, `wrong_number`, `unknown`.

## Unknown-number buckets — `unknown-inbound-router.js` (10)

`OPT_OUT`, `WRONG_NUMBER`, `SPAM`, `UNKNOWN_AGENT_OR_REALTOR`,
`UNKNOWN_BUYER_OR_INVESTOR`, `UNKNOWN_TITLE_OR_LENDER`,
`UNKNOWN_VENDOR_OR_CONTRACTOR`, `UNKNOWN_SELLER_REPLY`, `UNKNOWN_PERSONAL`,
`UNCLEAR_UNKNOWN` — each with a reply + suggested action + suppression rule.

## Coverage outcome (post-fix)

Every one of the 19 canonical intents resolves — across all 6 stages, 7
identities, 2 confidence bands — to a non-`missing_coverage` decision with a
scheduled next action. See `coverage-matrix.json` (1,862 rows, 0 missing).
