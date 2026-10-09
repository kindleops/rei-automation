-- Rollback for PROPOSED_20261009190000_eg_overview_snapshot.sql (drops only the snapshot table; the Overview
-- then computes the unfiltered universe per request — exact, slower on a cold cache).
begin;
drop table if exists public.eg_overview_snapshot;
commit;
