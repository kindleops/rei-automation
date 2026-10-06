-- ROLLBACK for PROPOSED_20261006120000_negotiation_quotes.sql (only while empty or after export).
begin;
drop table if exists public.negotiation_quotes;
commit;
