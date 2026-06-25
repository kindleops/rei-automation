-- Record unauthorized canary dispatch incidents without altering delivered state.

UPDATE public.send_queue
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'production_incident', true,
  'incident_type', 'unauthorized_canary_dispatch',
  'incident_recorded_at', now(),
  'incident_canary_run_id', 'canary-live-retry-2026-06-25',
  'incident_processing_run_id', '329dbf7e-a43c-4faf-be74-e4a4a742e692',
  'incident_note', 'Unauthorized dispatch during unrestricted cron while global brakes were briefly cleared'
)
WHERE id IN (
  '85d824ad-2226-46ff-b6e0-f059ead8ca95',
  '340db091-8ff1-4ca6-a0fa-731b2b04dc3d'
)
AND queue_status IN ('sent', 'delivered');