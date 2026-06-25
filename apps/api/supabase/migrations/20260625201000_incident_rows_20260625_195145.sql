-- Mark 2026-06-25 19:51:45 UTC containment breach rows without altering delivery truth.

UPDATE public.send_queue
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'production_incident', true,
  'incident_type', 'unauthorized_unrestricted_dispatch_under_containment',
  'incident_recorded_at', '2026-06-25T19:55:00.000Z',
  'incident_processing_run_id', 'a470e1ab-e6a8-4517-a0b5-364775dcb954',
  'incident_canary_run_id', 'canary-live-miami-v2-2026-06-25T19-51-15-390Z',
  'incident_note', 'Five Miami rows claimed by unrestricted queue_runner while containment brakes were believed active. Scoped authorization was never consumed.',
  'suppress_automatic_follow_up', true,
  'incident_follow_up_policy', 'reply_only_no_auto_outbound'
)
WHERE id IN (
  '78c7fef7-f31d-40d3-bbe3-34068fa964ca',
  '9a792d18-83a3-4356-9ab4-fcc46ca98b6c',
  '9bc068a5-eca5-448b-a40b-40a3bb1f30de',
  'c54441eb-a9d1-4b60-902f-2baf942822d7',
  'd569d816-d50d-4d7a-bfb1-7a8c8ea2f5bb'
);