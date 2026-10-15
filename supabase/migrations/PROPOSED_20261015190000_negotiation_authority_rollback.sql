-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261015190000_negotiation_authority.sql.
-- Drops exactly what the migration created (ledger + envelope data is discarded;
-- nothing outside these three tables references them).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015190000_negotiation_authority_rollback.sql
-- DISPOSABLE DATABASE for testing (node scripts/db/run-migration-test.mjs --id negotiation_authority).
drop table if exists public.negotiation_offer_events;
drop table if exists public.negotiation_envelope_revocations;
drop table if exists public.negotiation_envelopes;
drop function if exists public.negotiation_offer_event_insert_guard();
drop function if exists public.negotiation_envelope_insert_guard();
drop function if exists public.negotiation_immutable_guard();
