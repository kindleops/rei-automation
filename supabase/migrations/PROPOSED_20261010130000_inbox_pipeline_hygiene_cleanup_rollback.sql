-- ROLLBACK for PROPOSED_20261010130000_inbox_pipeline_hygiene_cleanup.sql
-- Restores every column the cleanup wrote, from the durable backups. Rows a
-- seller has replied on since (last_inbound_at moved) are NOT restored: the live
-- reply is newer truth. History rows are kept (audit trail) and a reversal row
-- is added.
BEGIN;
SET LOCAL statement_timeout = '30s';
UPDATE inbox_thread_state s SET
    inbox_bucket = b.inbox_bucket, previous_inbox_bucket = b.previous_inbox_bucket,
    last_intent = b.last_intent, disposition = b.disposition, is_hot_lead = b.is_hot_lead,
    follow_up_at = b.follow_up_at, reason_codes = b.reason_codes,
    is_archived = b.is_archived, archived_at = b.archived_at, archive_scope = b.archive_scope, archive_reason = b.archive_reason,
    updated_by = 'hygiene_20261010_rollback'
  FROM public._hyg20261010_inbox_backup b
 WHERE b.id = s.id AND s.last_inbound_at IS NOT DISTINCT FROM b.last_inbound_at;
INSERT INTO acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key)
  SELECT o.id, 'status_changed', 'opportunity_status', o.opportunity_status, b.opportunity_status, 'rollback', 'hygiene_20261010_rollback', 'hygiene_20261010_rollback', 'hygiene_20261010_rollback:status:' || o.id
    FROM acquisition_opportunities o JOIN public._hyg20261010_opp_backup b ON b.id = o.id
   WHERE o.opportunity_status IS DISTINCT FROM b.opportunity_status AND o.last_updated_source = 'hygiene_20261010';
UPDATE acquisition_opportunities o SET
    opportunity_status = b.opportunity_status, acquisition_stage = b.acquisition_stage,
    stage_entered_at = b.stage_entered_at, last_updated_source = b.last_updated_source,
    last_updated_by = b.last_updated_by, updated_at = now()
  FROM public._hyg20261010_opp_backup b
 WHERE b.id = o.id AND o.last_updated_source = 'hygiene_20261010';
SELECT (SELECT count(*) FROM public._hyg20261010_inbox_backup) AS inbox_backed_up,
       (SELECT count(*) FROM public._hyg20261010_opp_backup) AS opp_backed_up;
ROLLBACK; -- change to COMMIT after review
