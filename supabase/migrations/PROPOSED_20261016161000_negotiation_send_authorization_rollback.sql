-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016161000_negotiation_send_authorization.sql.
-- Drops exactly what the migration created (send authorization data is discarded; nothing references it).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016161000_negotiation_send_authorization_rollback.sql
drop table if exists public.negotiation_send_authorization_revocations;
drop table if exists public.negotiation_send_authorizations;
drop function if exists public.negotiation_send_authorization_insert_guard();
