# v_universal_lead_command Schema Audit

## Status

- Live Supabase catalog inspected: **Yes**
- Project: `lcppdrmrdfblstpcbgpf`
- Audit date: `2026-06-11`
- Migration SQL edited during this audit step: **No**
- Migration applied: **No**

This document locks requested business fields to real Supabase columns before
the migration is revised. A business output name may differ from its physical
source column, but the migration must never reference a source column that does
not exist.

Status meanings:

- **Exact**: the requested name exists on the stated source relation.
- **Alias**: the requested business name maps to a differently named real
  source column.
- **Derived**: no physical source column has that name, but the value can be
  calculated from identified real columns.
- **Missing**: no trustworthy physical source exists. Do not silently
  substitute a semantically different field.

## Corrected Grain Audit

The property-only `campaign_target_graph` grain is not the required operational
grain.

The verified path is:

1. Start from the all-property `campaign_target_graph` rows and join
   `properties` by `property_export_id`.
2. Use `campaign_target_graph.master_owner_id` when populated, otherwise use
   `properties.master_owner_id`.
3. Expand all `prospects` for that resolved `master_owner_id`.
4. Expand every `phones.linked_prospect_ids_json` member that resolves to the
   prospect and owner.
5. Expand every `emails.linked_prospect_ids_json` member that resolves to the
   prospect and owner.
6. Emit one row for each property + owner + prospect + phone or email channel.

The graph remains necessary for property-to-owner stabilization:

- Total properties: 124,046
- Properties where graph supplies a missing property owner: 53,193
- Property/graph owner disagreements: 93
- In all 93 disagreements, the graph-selected prospect and phone belong to the
  graph owner, so graph owner takes precedence.

The graph's selected prospect and phone do not define the revised grain.

Pre-view cardinality estimate from the live linkage data, later confirmed by a
transaction-local compile of the revised view:

- Total command rows: 308,670
- Phone rows: 132,527
- Email rows: 176,143
- Distinct owners represented: 68,293
- Distinct prospects represented: 99,313

Every identity row is keyed by:

`property_export_id + master_owner_id + prospect_id +
contact_channel_type + contact_channel_value`

## Technical Linkage

| Business field | Status | Real source |
| --- | --- | --- |
| `property_export_id` | Exact | `properties.property_export_id` |
| `property_id` | Exact | `properties.property_id` |
| `master_owner_id` | Exact | Resolved from `campaign_target_graph.master_owner_id`, then `properties.master_owner_id` |
| `prospect_id` | Exact | `prospects.prospect_id` |
| `canonical_prospect_id` | Exact | `prospects.canonical_prospect_id` |
| `master_key` | Exact | `prospects.master_key` / `master_owners.master_key` |
| `owner_cluster_key` | Exact | `master_owners.owner_cluster_key` |
| `household_key` | Exact | `master_owners.household_key` |
| `phone_id` | Exact | `phones.phone_id` on phone rows |
| `email_id` | Exact | `emails.email_id` on email rows |
| `thread_key` | Exact | `inbox_thread_state.thread_key` |
| `conversation_thread_id` | Alias | Inbox identity is `inbox_thread_state.thread_key`; `workflow_runs.conversation_thread_id` also exists |
| `campaign_target_id` | Alias | Canonical target identity is `campaign_targets.id`; queue FK is `send_queue.campaign_target_id` |
| `queue_id` | Alias | Canonical queue identity is `send_queue.id`; `message_events.queue_id` references it. `send_queue.queue_id` is a separate legacy text field |
| `latest_message_event_id` | Exact | `inbox_thread_state.latest_message_event_id` |

## Prospect Facts

All unchanged names below are exact columns on `prospects`:

`prospect_id`, `canonical_prospect_id`, `master_owner_id`, `master_key`,
`full_name`, `first_name`, `gender`, `marital_status`, `education_model`,
`occupation_group`, `occupation_code`, `net_asset_value`, `buying_power`,
`matching_flags`, `person_flags_text`, `best_phone`, `best_email`,
`contact_window`, and `timezone`.

| Business field | Status | Real source |
| --- | --- | --- |
| `language` | Alias | `prospects.language_preference` |
| `estimated_household_income` | Alias | `prospects.est_household_income` |
| `mlb` / `birth_year_month` | Alias/partial | `prospects.mob` exists. No `mlb` or `birth_year_month` column exists, and the audit does not infer a stronger meaning than the stored `mob` field |
| `calculated_age` | Missing | No source column; `mob` alone is not sufficient to calculate age reliably |

## Property Facts

All unchanged names below are exact columns on `properties`:

`property_export_id`, `property_id`, `property_address_full`, `market`,
`property_type`, `estimated_value`, `equity_amount`, `equity_percent`,
`total_loan_balance`, `total_loan_payment`, `sale_date`, `sale_price`,
`units_count`, `tax_delinquent`, `tax_delinquent_year`, `active_lien`,
`ownership_years`, `last_sale_doc_type`, `property_address`,
`property_address_city`, `property_address_county_name`,
`property_address_state`, `property_address_zip`, `property_class`, `tax_year`,
`building_square_feet`, `document_type`, `recording_date`, `default_date`,
`year_built`, `effective_year_built`, `total_baths`, `total_bedrooms`,
`lot_acreage`, `lot_square_feet`, `latitude`, `longitude`,
`air_conditioning`, `basement`, `building_condition`, `building_quality`,
`construction_type`, `exterior_walls`, `floor_cover`, `garage`,
`heating_fuel_type`, `heating_type`, `interior_walls`, `pool`, `porch`,
`patio`, `deck`, `driveway`, `roof_cover`, `roof_type`, `sewer`, `water`,
`zoning`, `legal_description`, `school_district_name`, `subdivision_name`,
`flood_zone`, `hoa_fee_amount`, `property_flags_text`, `search_profile_hash`,
`beds_per_unit`, `rehab_level`, `structured_motivation_score`,
`deal_strength_score`, `tag_distress_score`, `final_acquisition_score`,
`calculated_improvement_value`, `calculated_land_value`,
`calculated_total_value`, `past_due_amount`, `stories`, `style`, `topography`,
`sum_commercial_units`, `estimated_repair_cost`, and `other_rooms`.

| Business field | Status | Real source |
| --- | --- | --- |
| `tax_amount` | Alias | `properties.tax_amt` |
| `apm_parcel_id` | Alias/correction | `properties.apn_parcel_id` |
| `total_loan_amount` | Missing | No column on `properties`; do not substitute `total_loan_balance`, which is separately requested |
| `hoa_one_name` | Alias | `properties.hoa1_name` |
| `hoa_one_type` | Alias | `properties.hoa1_type` |
| `square_foot_range` | Alias | `properties.sqft_range` |
| `average_square_foot_per_unit` | Alias | `properties.avg_sqft_per_unit` |
| `assessment_year` | Missing | No column on `properties`; do not silently reuse `tax_year` |
| `number_of_fireplaces` | Alias | `properties.num_of_fireplaces` |
| `sum_buildings` | Alias | `properties.sum_buildings_nbr` |
| `sum_garage_square_feet` | Alias | `properties.sum_garage_sqft` |

`properties.sale_date` is stored as `text`, not a date type.

## Master Owner Facts

All unchanged names below are exact columns on `master_owners`:

`master_owner_id`, `master_key`, `display_name`, `primary_owner_address`,
`owner_type_guess`, `best_channel`, `best_language`,
`financial_pressure_score`, `urgency_score`, `priority_score`,
`priority_tier`, `best_phone_1`, `best_phone_2`, `best_phone_3`,
`best_email_1`, `best_email_2`, `portfolio_total_value`,
`portfolio_total_equity`, `portfolio_total_loan_balance`,
`portfolio_total_loan_payment`, `portfolio_total_tax_amount`,
`portfolio_total_units`, `property_count`, `tax_delinquent_count`,
`oldest_tax_delinquent_year`, and `active_lien_count`.

| Business field | Status | Real source |
| --- | --- | --- |
| `owner_location` | Alias | `master_owners.owner_location_text` |

## Phone And Contact Facts

| Business field | Status | Real source |
| --- | --- | --- |
| `contact_channel_type` | Derived | Literal `phone` or `email` from the channel branch |
| `contact_channel_value` | Derived | `phones.canonical_e164` or `emails.email_normalized` |
| `phone_id` | Exact | `phones.phone_id` |
| `phone_number` | Alias | `phones.phone`; raw source is also retained as `phones.phone_raw` |
| `canonical_e164` | Exact | `phones.canonical_e164` |
| `phone_owner` / `carrier` | Alias/partial | `phones.phone_owner`; no dedicated `carrier` column exists |
| `phone_activity_status` | Alias | `phones.activity_status` |
| `usage_12_months` | Exact | `phones.usage_12_months` |
| `usage_2_months` | Exact | `phones.usage_2_months` |
| `phone_rank` | Alias | `phones.sort_rank`; existing legacy views sometimes calculate a separate `row_number()` rank |
| `phone_confirmed` | Missing | No source column |
| `phone_status` | Alias | `phones.phone_contact_status` |
| `wrong_number` | Derived | `phones.wrong_number_at is not null` or `phones.phone_contact_status = 'wrong_number'` |
| `opt_out` | Derived | Active `sms_suppression_list` row with `suppression_type = 'opt_out'` |
| `do_not_contact` | Alias/derived | `contact_outreach_state.dnc`, with active SMS suppression as a channel-level block |

## Email Facts

| Business field | Status | Real source |
| --- | --- | --- |
| `email_id` | Exact | `emails.email_id` |
| `email` | Exact | `emails.email` |
| `email_linkage_score_raw` | Exact | `emails.email_linkage_score_raw`; this is the primary provider linkage signal |
| `email_score_final` | Exact | `emails.email_score_final`; it is an internal final score, not provider truth |
| `email_rank` | Exact | `emails.email_rank` |
| `email_confirmed` | Missing | No source column |
| `email_status` | Missing | No source column; `emails.email_eligible` is not equivalent to a status |

## Thread And Inbox State

| Business field | Status | Real source |
| --- | --- | --- |
| `thread_key` | Exact | `inbox_thread_state.thread_key` |
| `conversation_thread_id` | Alias | `inbox_thread_state.thread_key` for inbox/message reads |
| `inbox_bucket` | Exact | `deal_thread_state.inbox_bucket` |
| `universal_status` | Exact | `deal_thread_state.universal_status` |
| `universal_stage` | Exact | `deal_thread_state.universal_stage` |
| `lead_temperature` | Exact | `deal_thread_state.lead_temperature` |
| `reply_intent` | Exact | `deal_thread_state.reply_intent` |
| `ownership_confirmed` | Derived | Latest/history `message_events.metadata ->> 'intent' = 'ownership_confirmed'`; no physical boolean source column |
| `is_pinned` | Exact | `inbox_thread_state.is_pinned` |
| `is_starred` | Exact | `inbox_thread_state.is_starred` |
| `is_archived` | Exact | `inbox_thread_state.is_archived` |
| `is_suppressed` | Exact | `inbox_thread_state.is_suppressed` |
| `last_outbound_at` | Exact | `inbox_thread_state.last_outbound_at` |
| `last_inbound_at` | Exact | `inbox_thread_state.last_inbound_at` |
| `latest_message_event_id` | Exact | `inbox_thread_state.latest_message_event_id` |
| `latest_message_body` | Exact | `inbox_thread_state.latest_message_body`, verified against latest `message_events` |
| `latest_message_at` | Exact | `inbox_thread_state.latest_message_at` |
| `message_count` | Exact | `inbox_thread_state.message_count` |
| `inbound_count` | Exact | `inbox_thread_state.inbound_count` |
| `outbound_count` | Exact | `inbox_thread_state.outbound_count` |
| `unread_count` | Exact | `deal_thread_state.unread_count` |
| `next_action` | Exact | `inbox_thread_state.next_action` |
| `next_follow_up_at` | Alias | `inbox_thread_state.follow_up_at` |

Full message history remains in `message_events` and is not aggregated into the
universal view.

## Campaign And Queue State

| Business field | Status | Real source |
| --- | --- | --- |
| `campaign_id` | Exact | `campaigns.id`; FKs also exist on `campaign_targets.campaign_id` and `send_queue.campaign_id` |
| `campaign_name` | Alias | `campaigns.name`; `campaign_targets.campaign_name` is a target snapshot |
| `campaign_target_id` | Alias | `campaign_targets.id`; queue FK is `send_queue.campaign_target_id` |
| `campaign_status` | Alias | `campaigns.status` |
| `target_status` | Exact | `campaign_targets.target_status` |
| `queue_id` | Alias | `send_queue.id` |
| `queue_status` | Exact | `send_queue.queue_status` |
| `scheduled_for` | Exact | `send_queue.scheduled_for` |
| `sender_phone` | Alias | `send_queue.from_phone_number` |
| `template_id` | Exact | `send_queue.template_id` |
| `message_variant` | Exact/limited | `message_events.message_variant`; no queue column carries this value |
| `last_queued_at` | Derived | Latest applicable `send_queue.created_at` |
| `last_sent_at` | Alias | Latest applicable `send_queue.sent_at` |
| `last_delivered_at` | Alias | Latest applicable `send_queue.delivered_at` |
| `last_failed_at` | Derived | Latest `send_queue.updated_at` where queue status is failed; there is no dedicated failure timestamp |
| `latest_failure_reason` | Alias | `send_queue.failed_reason`, with `blocked_reason` / `guard_reason` retained separately where relevant |

## Workflow And Automation State

| Business field | Status | Real source |
| --- | --- | --- |
| `assigned_workflow_id` | Alias | Latest applicable `workflow_runs.workflow_id` |
| `assigned_workflow_name` | Alias | `workflows.name` |
| `workflow_step` | Alias | `workflow_steps.step_key` / `workflow_steps.label`, selected by `workflow_runs.current_step_id` |
| `workflow_status` | Alias | `workflow_runs.status` |
| `auto_reply_status` | Exact | Latest applicable `message_events.auto_reply_status` |
| `follow_up_sequence_status` | Derived | `workflow_runs.status` for a joined `workflows.workflow_type = 'follow_up'`; no dedicated column exists |
| `ai_conversation_state` | Alias | `thread_ai_state.current_stage` |
| `ai_summary` | Exact | `thread_ai_state.ai_summary` |
| `ai_next_action` | Alias | `thread_ai_state.next_best_action` |
| `ai_last_updated_at` | Alias | `thread_ai_state.last_ai_analysis_at`, falling back to `thread_ai_state.updated_at` |

These relations exist in the live schema but were not in the original ten-table
source list. Including them in the universal view is an explicit source-scope
expansion, not a column-name substitution.

## Offer And Deal State

| Business field | Status | Real source |
| --- | --- | --- |
| `offer_status` | Missing | No trustworthy physical source column |
| `seller_asking_price` | Alias | `thread_ai_state.asking_price` |
| `offer_price` | Alias | `thread_ai_state.last_offer`; `active_negotiations.current_offer` also exists but uses a separate UUID thread model |
| `contract_status` | Missing | No trustworthy physical source column |
| `closing_status` | Missing | No trustworthy physical source column |
| `deal_status` | Missing | No trustworthy physical source column |
| `pipeline_stage` | Exact | `send_queue.pipeline_stage` on the applicable latest queue item |

## Missing Field Lock

The revised migration must not pretend these fields have populated source data:

- `calculated_age`
- `birth_year_month`
- `total_loan_amount`
- `assessment_year`
- `phone_confirmed`
- `email_confirmed`
- `email_status`
- `offer_status`
- `contract_status`
- `closing_status`
- `deal_status`

If the output contract requires these columns now, they may only be emitted as
explicitly typed `NULL` values with comments identifying the missing source.

## Leticia/Jose Linkage Check

For property `2109507191`:

- Resolved owner: `mo_8d60153f76aa86fd94728d5e`
- Owner display name: Jose L Calzada
- Prospect: `pros1_5cbfdd6944b42b81f466e353`
- Prospect name: Leticia M Calzada
- Phone row: `ph_3bd9156c203dc38d2369e7d1` /
  `+19184074839`
- Email rows:
  - `em_24306da680796360176595dc` / `jc3541712@gmail.com`
  - `em_2335fe44beb0a9a2e8519502` / `munoz.lety1@gmail.com`
  - `em_a67bd780370b6b1848c16b09` / `munozlety1@gmail.com`

The same owner/property also has a separate Courtney Graves prospect with one
phone and one email. The corrected view should therefore return six command
rows for this property/owner context, not one graph-selected row.
