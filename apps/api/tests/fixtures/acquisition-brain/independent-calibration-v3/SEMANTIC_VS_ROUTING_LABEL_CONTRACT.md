# Semantic gold vs production routing — label contract

Applies to **development pack v3** annotations and is **mandatory** for true blind-v3.1 gold.

## Principle

Do **not** use production routing aliases as the sole semantic gold label.

Routing compatibility (suppression, queue, stage machine) must not inflate semantic classifier accuracy.

## Required fields (every example)

| Field | Meaning |
|---|---|
| `canonical_semantic_outcome` | What the message *means* in domain terms |
| `classifier_primary_intent` | Expected production `primary_intent` string if routing today |
| `expected_secondary_intents` | Secondary production intents |
| `expected_facts` | Structured facts (ownership, price role, etc.) |
| `production_routing_outcome` | What automation should do (suppress, human_review, continue, …) |
| `suppression_action` | `none` \| `opt_out` \| `archive_wrong_number` \| `hold` \| … |
| `terminal_state` | `none` \| `opt_out` \| `wrong_number` \| `hostile_or_legal` \| … |
| `authority_candidate_eligibility` | Whether the *semantic* outcome could ever be an authority candidate |

## Examples

### Sold property
- `canonical_semantic_outcome` = `sold_property`
- `classifier_primary_intent` may currently be `wrong_number` (suppression-compatible path)
- `authority_candidate_eligibility` = false

### Never owned
- `canonical_semantic_outcome` = `never_owned`
- production route may suppress via wrong-number-compatible path
- not ownership confirmation

### Tenant
- `canonical_semantic_outcome` = `tenant_renter`
- must never gold as ownership confirmation

### Explicit seller asking price
- `canonical_semantic_outcome` = `seller_asking_price_disclosed`
- `classifier_primary_intent` = `asking_price_provided` only when semantic role is seller ask
- ZIP / year / mortgage / repair / ARV / negation → different semantic outcomes

### Context “yes” after asking-price question
- `canonical_semantic_outcome` = `short_affirmation_needs_clarification`
- not `ownership_confirmed`
- not `seller_asking_price_disclosed`

## Development pack v3 application

Overlay file `semantic-routing-labels.jsonl` maps each frozen `calibration_example_id` to dual labels without rewriting `gold-labels.jsonl`.
