# Outcome Event Contract (P3-6 — read-only)

Canonical NDJSON event rows consumed by `outcomes/adapter.mjs` and the label builders. Produced by **read-only export jobs** (never a live production coupling; exports are files handed to this package).

## Event row

```json
{
  "event_id": "text (stable)",
  "family": "seller_intent | investor_conversion | economic_outcome | verified_sale | listing",
  "event_key": "see enumerations below",
  "event_ts": "ISO-8601 — the EVENT time (never ingestion/export time)",
  "property_id": "canonical/vendor property id",
  "person_id": "individual_key or canonical person id (nullable)",
  "phone_e164": "join key when person unknown (nullable)",
  "value": "numeric (economics family; discount/spread/profit/durations)",
  "source": "producing table/view (see audit)",
  "source_row_id": "row id in source",
  "reliability": "exact | high | medium | low  (identity-join confidence)",
  "export_batch": "export job id",
  "exported_at": "ISO-8601"
}
```

Enumerated `event_key` per family — seller_intent: positive_response, offer_interest, conditional_interest, asking_price_given, follow_up_requested, listing_event, explicit_intent_to_sell · investor_conversion: offer_requested, offer_delivered, offer_accepted, contract_requested, contract_sent, contract_signed · economic_outcome: acquisition_closed, assignment_closed, purchase_discount, realized_spread, realized_gross_profit, days_outreach_to_contract, days_contract_to_close · verified_sale: qualifying_transfer (from recorder data) · listing: listed, price_cut, expired, withdrawn, sold.

## Laws

1. **Event time only.** `event_ts` is the message/stage/recording time from the source row, never export time.
2. **Time safety.** Label building enforces `event_ts > scoring_as_of`; feature building enforces `source_event_timestamp <= scoring_as_of`. The adapter never mixes the two directions.
3. **Identity joins are tiered.** person_id (exact) > phone_e164 via `phones.canonical_e164` (high) > address match (medium). Reliability travels with the event; low-reliability joins never silently upgrade.
4. **Read-only.** The adapter validates and transforms; it has no write path and no network client.
