-- ROLLBACK for PROPOSED_20261007140000_v3_sales_candidates.sql. All objects are new (nothing is replaced), so rollback is a drop.
-- After rollback the display readers fall back to get_comp_candidates_for_subject automatically
-- (canonical-corpus-reads.js: reason 'canonical_rpc_not_applied') and show "Comps current through <pool date>".
begin;
set local lock_timeout = '5s';
drop function if exists public.get_v3_subject_geography(text, float8, float8);
drop function if exists public.get_v3_sales_candidates(float8, float8, float8, date, date, text, int);
drop materialized view if exists comp_private.mv_v3_sales_candidates;
commit;
