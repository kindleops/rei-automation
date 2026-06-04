-- Optional, environment-guarded webhook trigger (B1).
--
-- The message_events -> Podio sync trigger calls supabase_functions.http_request(),
-- which only exists when Supabase Database Webhooks are enabled (managed schema
-- "supabase_functions"). It was removed from the schema baseline so a fresh
-- replay on a bare branch (no webhooks) does not fail.
--
-- This migration installs the trigger when the platform function is available
-- and is a logged no-op otherwise (exception-guarded), keeping replay-from-zero
-- at 0 failed statements. Idempotent (CREATE OR REPLACE TRIGGER; PG14+).

DO $$
BEGIN
  EXECUTE $ddl$
    CREATE OR REPLACE TRIGGER "message_events_to_podio_sync"
    AFTER INSERT ON "public"."message_events"
    FOR EACH ROW
    EXECUTE FUNCTION "supabase_functions"."http_request"(
      'https://real-estate-automation-three.vercel.app/api/internal/events/sync-podio',
      'POST',
      '{"Content-type":"application/json"}',
      '{}',
      '5000'
    )
  $ddl$;
  RAISE NOTICE 'Installed message_events_to_podio_sync webhook trigger.';
EXCEPTION
  WHEN undefined_function OR undefined_object OR invalid_schema_name OR undefined_table THEN
    RAISE NOTICE 'supabase_functions webhook unavailable; skipped message_events_to_podio_sync (enable Database Webhooks to install).';
END $$;
