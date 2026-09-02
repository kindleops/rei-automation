# Mobile Seller Command Center — data map & source precedence

Measured against the live Supabase project on 2026-08-21 via the service role.
Fill rates are from a 1,000-row sample of `properties`; absolute counts are exact
`count(*)` over all 169,797 rows.

## 1. What does NOT exist

The rebuild brief assumed dedicated mortgage / lien / deed / tax / transaction
datasets. **They are not in the database.** Of the 259 relations PostgREST
exposes, zero match `mortgage|loan|lien|deed|transfer|foreclosure|probate`.

All of that intelligence is **aggregate columns on `properties`**, and most of
the granular columns are empty:

| Expected                          | Reality                                              |
| --------------------------------- | ---------------------------------------------------- |
| Per-loan schedule                 | `total_loan_amt` / `total_loan_balance` / `total_loan_payment` only |
| Lender / servicer                 | `lender_name` — **0% populated**                      |
| Rate, origination, maturity       | Columns do not exist                                  |
| Lien records (type/amount/holder) | `lien_type`, `lien_position`, `lien_recording_date`, `lienholder_name`, `judgment_amount` — **all 0%** |
| Foreclosure detail                | `foreclosure_stage/status/type`, `default_amount`, `default_date` — **all 0%** |
| Deed / transfer history           | One last-sale event per property; no grantor/grantee, no history table |
| Recording date / document type    | `recording_date` 0%, `document_type` 0% (`last_sale_doc_type` 81% is the usable one) |

Consequence: the Transactions section renders the events that genuinely exist
(last recorded sale, tax year, default date when present) and **states the gap
in-place** rather than presenting an empty timeline as if data were merely
missing for this record.

## 2. UI concept → source

| UI concept | Table / view | Column(s) | Fill | Nullable | Confidence | Already in UI | New |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Estimated value | `properties` | `estimated_value` | 100% | no | high | yes | — |
| Equity $ / % | `properties` | `equity_amount`, `equity_percent` | 100% | no | high | yes | — |
| Repairs | `properties` | `estimated_repair_cost` | 100% | no | modelled | yes | — |
| Debt | `properties` | `total_loan_balance` | 45% (75,992 rows > 0) | yes | medium | partial | — |
| Loan original / payment | `properties` | `total_loan_amt`, `total_loan_payment` | 47% / 46% | yes | medium | no | **new** |
| Annual tax | `properties` | `tax_amt`, `tax_year` | 100% | no | high | partial | `tax_year` **new** |
| Assessed value | `properties` | `assd_total_value`, `assd_land_value`, `assd_improvement_value` | 76% | yes | high | no | deferred |
| Tax delinquency | `properties` | `tax_delinquent` (8,283 true), `tax_delinquent_year` | 100% / 27% | no / yes | high | partial | — |
| Lien present | `properties` | `active_lien` (5,733 true) | 100% | no | flag only | partial | — |
| Last sale | `properties` | `sale_date` (120,895), `sale_price` (52%), `last_sale_doc_type` (81%) | — | yes | medium | partial | **new (timeline)** |
| Ownership tenure | `properties` | `ownership_years` | 81% | yes | medium | yes | — |
| Deed owner | `properties` | `owner_name`, `owner_location` | 100% | no | high | yes | relabelled |
| Portfolio owner | `master_owners` | `display_name`, `property_count`, `portfolio_*` | — | yes | medium | yes | relabelled |
| Prospect | `prospects` | `name`, `best_email`, `likely_owner`, `likely_renter`, … | — | yes | skip-trace | yes | relabelled |
| Phone owner | `phones` | `phone_owner`, `carrier`, `contact_window`, `timezone` | — | yes | provider | yes | relabelled |
| Workflow state | `inbox_thread_state` | `lifecycle_stage`, `operational_status`, `lead_temperature`, `is_starred/pinned/archived`, `snoozed_until`, `manual_*_lock` | — | yes | canonical | **not in dossier before** | **new** |
| Suppression | `sms_suppression_list` | `phone_number`, `reason`, `suppressed_at` | — | — | canonical | yes | — |
| Comps | `get_comp_candidates_for_subject` RPC → `v_recent_sold_comps`, `buyer_comp_properties_v2`, `recently_sold_properties` | see engine | — | — | derived | yes | corrected |
| Acquisition decision | `property_acquisition_scores` | `aos_score` (0–1000), `best_strategy`, `recommended_cash_offer`, … | — | yes | engine | yes | rescaled |
| Activity | `message_events`, `property_acquisition_scores`, `inbox_threads_hydrated` | — | — | — | derived | yes | relabelled |

### Other high-value datasets found (deferred, not wired)

- `buyer_purchase_events_v2` — 55,479 real purchase events (`purchase_date`,
  `recording_date`, `purchase_price`, `document_type`, buyer entity). Keyed to
  **buyer entities and comp properties**, not to subject properties, so it can
  power market/buyer context but *cannot* be presented as this property's
  ownership history.
- `universal_lead_state_events` — 4,792 rows; the honest audit trail for
  workflow changes (`field_name`, `previous_value`, `new_value`, `change_source`).
  Best future source for the Activity timeline.
- `acquisition_opportunity_history` — 449 rows of engine decision changes.
- `property_valuation_snapshots` — only 8 rows; not usable yet.
- `contact_outreach_state` — 8,708 rows; contact pacing, `dnc`, `is_paused`,
  `next_allowed_*_at`. Strong candidate for the contact-window UI.
- `census_geo_metrics` — already wired.

## 3. Source precedence

Where several sources answer the same question, the mobile summary uses the
first that is present; deeper sources stay available in expanded sections.

| Fact | Precedence |
| --- | --- |
| Property value | `decision_snapshot.value` → `properties.estimated_value` → `property_snapshot.value` |
| Equity | `decision_snapshot.equity_amount` → `property_snapshot.equity_amount` |
| Repairs | `decision_snapshot.repair_estimate` → `property_snapshot.repair_estimate` |
| Loan balance | `properties.total_loan_balance` → `inbox_threads_hydrated.total_loan_balance` → `total_loan_amt` |
| Sale date/price | `properties.sale_date` / `sale_price`; **0 means "not recorded"**, not "$0" |
| Owner name | `properties.owner_name` (deed) is canonical for *who is on title*; `master_owners.display_name` is canonical for *portfolio grouping*. They are shown as separate labelled roles, never merged. |
| Phone | `phones.canonical_e164` → `inbox_thread_state.canonical_e164` → `seller_phone` |
| Workflow state | `inbox_thread_state` only. The hydrated view has the flags but **not** stage/status/temperature. |
| Asset class | `properties.normalized_asset_class` → `asset_class` → `property_type`. `property_class` is **excluded** — see below. |

### Asset-class precedence is load-bearing

`properties.normalized_asset_class` is **null on 100% of sampled rows**. The
dossier previously back-filled it from `property_class` (`'Residential'`), which
is a coarse class, not an asset class. `'Residential'` normalizes to `'other'`,
whose family matches nothing — so every Single Family comp failed the asset gate
against a Single Family subject while both still *displayed* as "Single Family".

Two fixes, both canonical:

1. `deal-intelligence-dossier.js` no longer aliases `property_class` into
   `normalized_asset_class`.
2. `acquisitionDecisionEngine.js#resolveDefiniteAssetClass` walks the candidate
   fields in priority order and takes the first that resolves to a *definite*
   lane, instead of committing to whichever field was merely non-empty first.

Measured effect on live data (usable comps, before → after):
`251042651` 0 → 53, `278452886` 0 → 41, `273321375` 0 → 20.
