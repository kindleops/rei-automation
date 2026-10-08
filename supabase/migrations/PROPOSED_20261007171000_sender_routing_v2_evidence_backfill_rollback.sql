-- ROLLBACK for PROPOSED_20261007171000_sender_routing_v2_evidence_backfill.sql
-- Reverts ONLY the rows that file changed (metadata.evidence_backfill marker), restoring the
-- prior registration_status / inbound_verified_at / sms_webhook_status it recorded.
-- Run before (or instead of) turning Sender Routing 2.0 off is NOT required: with v2 off nothing reads these fields.
BEGIN;
UPDATE public.textgrid_numbers tn
SET
  registration_status = CASE WHEN (tn.metadata->'evidence_backfill'->>'set_registered')::boolean
                             THEN tn.metadata->'evidence_backfill'->>'prior_registration_status'
                             ELSE tn.registration_status END,
  metadata = CASE WHEN (tn.metadata->'evidence_backfill'->>'set_inbound')::boolean
               THEN (tn.metadata - 'inbound_verified_at' - 'inbound_verified_by' - 'sms_webhook_status' - 'evidence_backfill')
                    || jsonb_strip_nulls(jsonb_build_object(
                         'inbound_verified_at', tn.metadata->'evidence_backfill'->>'prior_inbound_verified_at',
                         'sms_webhook_status', tn.metadata->'evidence_backfill'->>'prior_sms_webhook_status'))
               ELSE tn.metadata - 'evidence_backfill' END
WHERE tn.metadata ? 'evidence_backfill';
COMMIT;
