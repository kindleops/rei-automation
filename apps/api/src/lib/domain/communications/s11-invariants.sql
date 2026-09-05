-- §11 canonical invariant evaluator. READ ONLY.
--
-- Every row returned is a violation. Zero rows is the healthy state.
--
-- LEGACY IS REPORTED, NOT REPAIRED. Rows that predate §11 carry no logical
-- binding and never will; inventing lineage to make this scan look clean would
-- manufacture exactly the false identity the model exists to prevent. They are
-- surfaced under LEGACY_UNBOUND_QUEUE_ROW at severity 'info' so the count is
-- visible without being confused for a fault.
WITH
duplicate_logical_key AS (
  SELECT 'DUPLICATE_LOGICAL_KEY' AS code, 'fatal' AS severity, logical_key AS entity, count(*) AS n
  FROM public.seller_logical_communications GROUP BY logical_key HAVING count(*) > 1
),
duplicate_attempt_number AS (
  SELECT 'DUPLICATE_ATTEMPT_NUMBER', 'fatal',
         logical_communication_id::text || ':' || attempt_number::text, count(*)
  FROM public.seller_communication_attempts
  GROUP BY logical_communication_id, attempt_number HAVING count(*) > 1
),
multiple_active_attempts AS (
  SELECT 'MULTIPLE_ACTIVE_ATTEMPTS', 'fatal', logical_communication_id::text, count(*)
  FROM public.seller_communication_attempts
  WHERE completed_at IS NULL
  GROUP BY logical_communication_id HAVING count(*) > 1
),
provider_sid_multi_bind AS (
  SELECT 'PROVIDER_SID_MULTI_BIND', 'fatal', provider_message_id, count(*)
  FROM public.seller_communication_attempts
  WHERE provider_message_id IS NOT NULL
  GROUP BY provider_message_id HAVING count(*) > 1
),
ambiguous_with_retry AS (
  SELECT 'AMBIGUOUS_WITH_RETRY_AUTHORITY', 'fatal', id::text, 1
  FROM public.seller_logical_communications
  WHERE state = 'ambiguous_provider_outcome' AND retry_authority IN ('retry_allowed','retry_after')
),
may_have_been_sent_with_retry AS (
  SELECT 'MAY_HAVE_BEEN_SENT_WITH_RETRY_AUTHORITY', 'fatal', id::text, 1
  FROM public.seller_logical_communications
  WHERE delivery_possibility = 'may_have_been_sent' AND retry_authority IN ('retry_allowed','retry_after')
),
ambiguous_dispatchable_queue AS (
  SELECT 'AMBIGUOUS_WITH_DISPATCHABLE_QUEUE', 'fatal', q.id::text, 1
  FROM public.send_queue q
  JOIN public.seller_logical_communications c ON c.id = q.logical_communication_id
  WHERE c.delivery_possibility = 'may_have_been_sent'
    AND q.queue_status IN ('queued','scheduled','pending','approval')
),
no_send_dispatchable AS (
  SELECT 'NO_SEND_DISPATCHABLE', 'fatal', q.id::text, 1
  FROM public.send_queue q
  JOIN public.seller_logical_communications c ON c.id = q.logical_communication_id
  WHERE c.state = 'no_send'
    AND q.queue_status IN ('queued','scheduled','pending','approval')
),
network_started_auto_retryable AS (
  SELECT 'NETWORK_STARTED_ATTEMPT_AUTO_RETRYABLE', 'fatal', a.id::text, 1
  FROM public.seller_communication_attempts a
  JOIN public.seller_logical_communications c ON c.id = a.logical_communication_id
  WHERE a.provider_request_started_at IS NOT NULL
    AND a.completed_at IS NULL
    AND c.retry_authority IN ('retry_allowed','retry_after')
),
provider_accepted_with_retry AS (
  SELECT 'PROVIDER_ACCEPTED_WITH_RETRY_AUTHORITY', 'fatal', id::text, 1
  FROM public.seller_logical_communications
  WHERE delivery_possibility = 'provider_accepted' AND retry_authority IN ('retry_allowed','retry_after')
),
protected_sent_without_evidence AS (
  SELECT 'PROTECTED_QUEUE_SENT_WITHOUT_PROVIDER_EVIDENCE', 'fatal', q.id::text, 1
  FROM public.send_queue q
  WHERE q.logical_communication_id IS NOT NULL
    AND q.queue_status = 'sent'
    AND NOT EXISTS (
      SELECT 1 FROM public.seller_communication_attempts a
      WHERE a.logical_communication_id = q.logical_communication_id
        AND a.provider_message_id IS NOT NULL
    )
),
queue_logical_parent_mismatch AS (
  SELECT 'QUEUE_LOGICAL_PARENT_MISMATCH', 'fatal', q.id::text, 1
  FROM public.send_queue q
  WHERE q.logical_communication_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.seller_logical_communications c WHERE c.id = q.logical_communication_id)
),
monetary_offer_mismatch AS (
  SELECT 'MONETARY_COMMUNICATION_OFFER_MISMATCH', 'fatal', q.id::text, 1
  FROM public.send_queue q
  JOIN public.seller_logical_communications c ON c.id = q.logical_communication_id
  WHERE c.communication_type = 'monetary_offer'
    AND q.metadata ? 'offer_id'
    AND c.seller_offer_id IS DISTINCT FROM (q.metadata->>'offer_id')
),
attempt_without_parent AS (
  SELECT 'ATTEMPT_WITHOUT_LOGICAL_PARENT', 'fatal', a.id::text, 1
  FROM public.seller_communication_attempts a
  WHERE NOT EXISTS (SELECT 1 FROM public.seller_logical_communications c WHERE c.id = a.logical_communication_id)
),
lineage_missing AS (
  SELECT 'LOGICAL_IDENTITY_CONFLICT', 'fatal', id::text, 1
  FROM public.seller_logical_communications
  WHERE logical_key !~ '^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$'
),
legacy_unbound AS (
  SELECT 'LEGACY_UNBOUND_QUEUE_ROW', 'info', 'aggregate', count(*)
  FROM public.send_queue
  WHERE logical_communication_id IS NULL
    AND queue_status IN ('queued','scheduled','pending','approval')
  HAVING count(*) > 0
)
SELECT * FROM duplicate_logical_key
UNION ALL SELECT * FROM duplicate_attempt_number
UNION ALL SELECT * FROM multiple_active_attempts
UNION ALL SELECT * FROM provider_sid_multi_bind
UNION ALL SELECT * FROM ambiguous_with_retry
UNION ALL SELECT * FROM may_have_been_sent_with_retry
UNION ALL SELECT * FROM ambiguous_dispatchable_queue
UNION ALL SELECT * FROM no_send_dispatchable
UNION ALL SELECT * FROM network_started_auto_retryable
UNION ALL SELECT * FROM provider_accepted_with_retry
UNION ALL SELECT * FROM protected_sent_without_evidence
UNION ALL SELECT * FROM queue_logical_parent_mismatch
UNION ALL SELECT * FROM monetary_offer_mismatch
UNION ALL SELECT * FROM attempt_without_parent
UNION ALL SELECT * FROM lineage_missing
UNION ALL SELECT * FROM legacy_unbound
ORDER BY severity, code;
