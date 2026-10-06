-- PROPOSED rollback for PROPOSED_20261006150000_negotiation_shadow.sql
begin;
drop table if exists public.negotiation_shadow;
commit;
