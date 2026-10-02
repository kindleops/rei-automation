-- Prefer seller-submitted identity for external intake threads in the existing
-- canonical inbox projection. The view shape and all lifecycle predicates stay
-- unchanged; imported owner/prospect identity still wins when no intake name
-- exists.

DO $$
DECLARE
  view_definition text;
  old_expression text := 'COALESCE(mo.display_name, pr.full_name, pr.first_name)';
  new_expression text := 'COALESCE(ts.seller_display_name, mo.display_name, pr.full_name, pr.first_name)';
BEGIN
  IF to_regclass('public.canonical_inbox_threads') IS NULL THEN
    RETURN;
  END IF;

  SELECT pg_get_viewdef('public.canonical_inbox_threads'::regclass, true)
    INTO view_definition;

  IF position(old_expression IN view_definition) > 0 THEN
    view_definition := replace(view_definition, old_expression, new_expression);
  END IF;

  -- Keep the existing reader shape intact while appending the external source
  -- identity. CREATE OR REPLACE VIEW permits additive columns at the end, so
  -- dependent inbox-count views do not need to be dropped or recreated.
  IF position('source_application' IN view_definition) = 0 THEN
    view_definition := replace(
      view_definition,
      E'\n   FROM inbox_thread_state ts',
      E',\n    ts.source_application AS source_application,\n    ts.source_channel AS source_channel,\n    ts.source_submission_id AS source_submission_id\n   FROM inbox_thread_state ts'
    );
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.canonical_inbox_threads '
    || 'WITH (security_invoker = true) AS ' || view_definition;
END
$$;
