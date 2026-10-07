-- VERIFY (read-only) after PROPOSED_20261007140000_v3_sales_candidates.sql.
begin read only;
set local statement_timeout = '30s';
select count(*) as rows, max(sold_on) as newest, count(*) filter (where lane_class = 'sfr') sfr, count(*) filter (where lane_class = 'mf') mf
  from comp_private.mv_v3_sales_candidates;                                  -- newest must equal mv_map_market_sales max
select count(*) filter (where owner_linked) owner_linked, count(*) filter (where bulk_parcels_zip >= 2) multi_parcel
  from comp_private.mv_v3_sales_candidates;
-- latency (expect index scan on mv_v3_sales_candidates_geog_gist; target < 300 ms SFR 2.5 mi, < 1 s MF 10 mi)
explain (analyze, buffers) select * from public.get_v3_sales_candidates(29.66, -95.49, 2.5, (current_date - interval '24 months')::date, current_date + 1, 'sfr', 300);
explain (analyze, buffers) select * from public.get_v3_sales_candidates(44.956, -93.045, 10, (current_date - interval '36 months')::date, current_date + 1, 'mf', 300);
select * from public.get_v3_subject_geography('274574569', 44.956079, -93.044981);
rollback;
