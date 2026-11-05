-- RC 8.5.5 · eg_property_facts VERIFICATION (read-only; every statement inside BEGIN READ ONLY … ROLLBACK).
-- Run after the backfill logs 'ok':
--   node scripts/lib/prod-db-credentials.mjs psql entity_graph -v ON_ERROR_STOP=1 -f scripts/entity-graph/eg-property-facts-verify.sql
--   (the role-enforced read-only diagnostics credential, LC_RO_ENTITY_GRAPH_DB_URL_FILE)
-- Prints counts, null rates, plans and timings only (no names / phones / addresses).
\timing on
begin read only;
set local statement_timeout = '30s';

-- 1. universe: facts rows == view universe == properties; exactly one run; no orphans; the ok log row
select (select count(*) from public.eg_property_facts) as facts_rows,
       (select count(*) from public.v_entity_graph_properties) as universe_view,
       (select count(*) from public.properties) as universe_table,
       (select count(distinct refreshed_at) from public.eg_property_facts) as runs,
       (select count(*) from public.eg_property_facts f where not exists (select 1 from public.properties p where p.property_id = f.property_id)) as orphans;
select id, mode, status, started_at, finished_at, rows, finished_at - started_at as took
  from public.eg_refresh_log where name = 'eg_property_facts' order by id desc limit 3;

-- 2. null-rate per sortable column (expect sms_sort / sms_status / company_status_class ≈ 0 % null;
--    a column at 100 % null is a defect — stop and report)
select v.col, v.nulls, round(100.0 * v.nulls / nullif(t.total, 0), 1) as null_pct
  from (select count(*) as total,
               count(*) filter (where "sms_sort" is null) as "sms_sort",
               count(*) filter (where "sms_status" is null) as "sms_status",
               count(*) filter (where "last_contact_at" is null) as "last_contact_at",
               count(*) filter (where "pipeline_stage" is null) as "pipeline_stage",
               count(*) filter (where "pipeline_status" is null) as "pipeline_status",
               count(*) filter (where "conversation_stage" is null) as "conversation_stage",
               count(*) filter (where "conversation_status" is null) as "conversation_status",
               count(*) filter (where "last_message_at" is null) as "last_message_at",
               count(*) filter (where "campaign_count" is null) as "campaign_count",
               count(*) filter (where "contact_candidate_phones" is null) as "contact_candidate_phones",
               count(*) filter (where "equity_known_pct" is null) as "equity_known_pct",
               count(*) filter (where "equity_known_amount" is null) as "equity_known_amount",
               count(*) filter (where "lien_count" is null) as "lien_count",
               count(*) filter (where "filing_count" is null) as "filing_count",
               count(*) filter (where "last_sale_on" is null) as "last_sale_on",
               count(*) filter (where "distress_signal_count" is null) as "distress_signal_count",
               count(*) filter (where "asset_type" is null) as "asset_type",
               count(*) filter (where "zip_code" is null) as "zip_code",
               count(*) filter (where "owner_buyer_purchases" is null) as "owner_buyer_purchases",
               count(*) filter (where "company_status_class" is null) as "company_status_class",
               count(*) filter (where "company_dissolution_date" is null) as "company_dissolution_date",
               count(*) filter (where "company_incorporation_date" is null) as "company_incorporation_date",
               count(*) filter (where "person_age" is null) as "person_age",
               count(*) filter (where "owner_priority_score" is null) as "owner_priority_score",
               count(*) filter (where "property_address_full" is null) as "property_address_full",
               count(*) filter (where "market" is null) as "market",
               count(*) filter (where "estimated_value" is null) as "estimated_value",
               count(*) filter (where "units_count" is null) as "units_count",
               count(*) filter (where "owner_name" is null) as "owner_name",
               count(*) filter (where "year_built" is null) as "year_built",
               count(*) filter (where "building_square_feet" is null) as "building_square_feet",
               count(*) filter (where "total_bedrooms" is null) as "total_bedrooms",
               count(*) filter (where "total_baths" is null) as "total_baths",
               count(*) filter (where "lot_square_feet" is null) as "lot_square_feet",
               count(*) filter (where "property_address_county_name" is null) as "property_address_county_name",
               count(*) filter (where "property_address_city" is null) as "property_address_city",
               count(*) filter (where "property_address_state" is null) as "property_address_state",
               count(*) filter (where "property_type" is null) as "property_type",
               count(*) filter (where "rec_mortgage_count" is null) as "rec_mortgage_count",
               count(*) filter (where "rec_mortgage_balance" is null) as "rec_mortgage_balance",
               count(*) filter (where "rec_first_rate" is null) as "rec_first_rate",
               count(*) filter (where "rec_first_lender" is null) as "rec_first_lender",
               count(*) filter (where "rec_last_sale_date" is null) as "rec_last_sale_date",
               count(*) filter (where "ownership_years" is null) as "ownership_years",
               count(*) filter (where "total_loan_balance" is null) as "total_loan_balance",
               count(*) filter (where "sale_date" is null) as "sale_date"
          from public.eg_property_facts) t
 cross join lateral (values
   ('sms_sort', t."sms_sort"),
   ('sms_status', t."sms_status"),
   ('last_contact_at', t."last_contact_at"),
   ('pipeline_stage', t."pipeline_stage"),
   ('pipeline_status', t."pipeline_status"),
   ('conversation_stage', t."conversation_stage"),
   ('conversation_status', t."conversation_status"),
   ('last_message_at', t."last_message_at"),
   ('campaign_count', t."campaign_count"),
   ('contact_candidate_phones', t."contact_candidate_phones"),
   ('equity_known_pct', t."equity_known_pct"),
   ('equity_known_amount', t."equity_known_amount"),
   ('lien_count', t."lien_count"),
   ('filing_count', t."filing_count"),
   ('last_sale_on', t."last_sale_on"),
   ('distress_signal_count', t."distress_signal_count"),
   ('asset_type', t."asset_type"),
   ('zip_code', t."zip_code"),
   ('owner_buyer_purchases', t."owner_buyer_purchases"),
   ('company_status_class', t."company_status_class"),
   ('company_dissolution_date', t."company_dissolution_date"),
   ('company_incorporation_date', t."company_incorporation_date"),
   ('person_age', t."person_age"),
   ('owner_priority_score', t."owner_priority_score"),
   ('property_address_full', t."property_address_full"),
   ('market', t."market"),
   ('estimated_value', t."estimated_value"),
   ('units_count', t."units_count"),
   ('owner_name', t."owner_name"),
   ('year_built', t."year_built"),
   ('building_square_feet', t."building_square_feet"),
   ('total_bedrooms', t."total_bedrooms"),
   ('total_baths', t."total_baths"),
   ('lot_square_feet', t."lot_square_feet"),
   ('property_address_county_name', t."property_address_county_name"),
   ('property_address_city', t."property_address_city"),
   ('property_address_state', t."property_address_state"),
   ('property_type', t."property_type"),
   ('rec_mortgage_count', t."rec_mortgage_count"),
   ('rec_mortgage_balance', t."rec_mortgage_balance"),
   ('rec_first_rate', t."rec_first_rate"),
   ('rec_first_lender', t."rec_first_lender"),
   ('rec_last_sale_date', t."rec_last_sale_date"),
   ('ownership_years', t."ownership_years"),
   ('total_loan_balance', t."total_loan_balance"),
   ('sale_date', t."sale_date")
 ) v(col, nulls)
 order by null_pct desc, v.col;

-- 3. SMS eligibility distribution (counts only)
select sms_eligible, sms_status, count(*) from public.eg_property_facts group by 1, 2 order by 3 desc limit 20;

-- 4. FULL-UNIVERSE sort by SMS eligible, both directions — the exact shape tablePage() issues.
--    PASS = "Index Scan using egpf_sms_sort_k" (Backward for desc), no Sort node, Execution Time < 50 ms.
explain (analyze, buffers, costs off)
select "property_id", "sms_sort" as k from public.eg_property_facts where "sms_sort" is not null order by "sms_sort" asc, "property_id" asc limit 51;
explain (analyze, buffers, costs off)
select "property_id", "sms_sort" as k from public.eg_property_facts where "sms_sort" is not null order by "sms_sort" desc, "property_id" desc limit 51;
-- the exact total the page reports
explain (analyze, buffers, costs off) select count(*)::bigint as n from public.eg_property_facts;

-- 5. header-filter shapes: categorical chip + sort, and a token (GIN) chip
explain (analyze, buffers, costs off)
select "property_id" from public.eg_property_facts where "company_status_class" = 'dissolved' and "last_contact_at" is not null order by "last_contact_at" desc, "property_id" desc limit 51;
explain (analyze, buffers, costs off)
select count(*) from public.eg_property_facts where "signal_labels" && array['Probate']::text[];

-- 6. size
select pg_size_pretty(pg_relation_size('public.eg_property_facts')) as heap,
       pg_size_pretty(pg_indexes_size('public.eg_property_facts')) as indexes,
       pg_size_pretty(pg_total_relation_size('public.eg_property_facts')) as total;
rollback;
