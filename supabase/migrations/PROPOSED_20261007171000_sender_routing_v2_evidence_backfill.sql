-- PROPOSED — NOT APPLIED. Sender Routing 2.0: evidence-based registration + inbound backfill (DATA ONLY).
--
-- Why: the v2 eligibility (sender-routing-policy.js evaluateSenderEligibility, and the SQL
-- pick in PROPOSED_20261007170000) requires registration_status = 'registered' AND a verified
-- inbound webhook (metadata.inbound_verified_at or sms_webhook_status = 'verified'). In prod
-- (2026-10-07) only Indianapolis and Tampa carry those fields, so turning v2 on without this
-- backfill would make almost every number ineligible and STOP sending.
--
-- Rule (evidence, computed AT APPLY TIME from the ledgers, never from a paste):
--   registered        the number has DELIVERED traffic (send_queue.delivered_at) — every one of the
--                     owner's TextGrid numbers is on 10DLC campaign CHM4NL2 (TextGrid API GET
--                     2026-10-07, 19/19), and a delivery proves the carrier path works.
--   inbound verified  delivered traffic AND at least one inbound SMS (message_events inbound to the
--                     number): inbound_verified_at = the FIRST inbound, sms_webhook_status = 'verified'.
--   delivered but never received -> registered only (webhook stays unverified; v2 skips it).
--   no delivered traffic        -> untouched (Chicago +18722547122 stays unverified until its
--                                  first inbound; then re-run this file — it is idempotent).
-- Existing values are never overwritten (owner-recorded proofs on Indianapolis / Tampa stay).
-- status, daily_limit, health and the blocklist are NOT touched. Nothing is paused.
--
-- Evidence on 2026-10-07 (read-only; delivered total / campaign, inbound, first inbound):
--   Atlanta 0588 1289/260 in 183 (04-27) · Atlanta 6385 191/191 in 19 (10-07) · Atlanta 6402 251/251 in 40 (10-07)
--   Charlotte 9889 709/0 in 116 (04-23) · Charlotte 5818 1/0 in 1 (06-11) · Dallas 1600 1646/1026 in 283
--   Houston 8577 896/420 in 155 · Jacksonville 4448 11/0 in 10 (08-13) · LA 9881 3555/699 in 518
--   LA 4544 2/1 in 0 -> registered, webhook UNVERIFIED · Miami 2999 1002/354 in 165 (cooling: still ineligible)
--   Miami 5670 31/0 in 31 · Minneapolis 0495 1648/190 in 309 · 2382 295/291 in 38 · 2623 419/408 in 54
--   St. Louis 8488 674/672 in 91 (first inbound 13:14Z = owner proof) · Tampa 7553 496/490 in 64 (already set)
--   Indianapolis 4612 0 delivered, in 2 (owner proof 10-03, already set) · Chicago 7122 0/0 in 0 -> untouched
--   Miami 4780 retired -> untouched
-- Delivered-but-not-campaign numbers (Charlotte 9889, Jacksonville 4448, Miami 5670) are included on
-- purpose: requiring CAMPAIGN deliveries would drop Charlotte's and Jacksonville's own numbers.
--
-- Apply AFTER the routing tables + seed, BEFORE the coverage function (see the 170000 header).
-- No BEGIN/COMMIT inside (psql --single-transaction / apply_migration; the pretest \ir's it).
-- Rollback: PROPOSED_20261007171000_sender_routing_v2_evidence_backfill_rollback.sql (uses the
-- metadata.evidence_backfill marker this file writes; only rows it changed are reverted).

WITH
-- evidence:begin (coverage-sql-parity.mjs embeds this block verbatim for the read-only preview)
evidence AS (
  SELECT
    tn.id,
    tn.phone_number,
    (SELECT count(*) FROM public.send_queue sq WHERE sq.from_phone_number = tn.phone_number AND sq.delivered_at IS NOT NULL) AS delivered,
    (SELECT min(me.created_at) FROM public.message_events me WHERE me.to_phone_number = tn.phone_number AND me.direction = 'inbound') AS first_inbound
  FROM public.textgrid_numbers tn
  WHERE lower(trim(COALESCE(tn.metadata->>'lifecycle_state', ''))) <> 'retired'
),
-- evidence:end
patch AS (
  SELECT
    e.id,
    e.delivered,
    e.first_inbound,
    (e.delivered > 0 AND lower(trim(COALESCE(tn.registration_status, ''))) <> 'registered') AS set_registered,
    (e.delivered > 0 AND e.first_inbound IS NOT NULL
      AND NULLIF(trim(COALESCE(tn.metadata->>'inbound_verified_at', '')), '') IS NULL) AS set_inbound
  FROM evidence e JOIN public.textgrid_numbers tn ON tn.id = e.id
)
UPDATE public.textgrid_numbers tn
SET
  registration_status = CASE WHEN p.set_registered THEN 'registered' ELSE tn.registration_status END,
  metadata = COALESCE(tn.metadata, '{}'::jsonb)
    || CASE WHEN p.set_inbound THEN jsonb_build_object(
         'inbound_verified_at', to_char(p.first_inbound AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'inbound_verified_by', 'evidence_backfill_20261007',
         'sms_webhook_status', 'verified') ELSE '{}'::jsonb END
    || jsonb_build_object('evidence_backfill', jsonb_build_object(
         'at', now(), 'rule', 'delivered>0 => registered (CHM4NL2); delivered>0 and inbound => inbound verified',
         'delivered', p.delivered, 'first_inbound', p.first_inbound,
         'set_registered', p.set_registered, 'set_inbound', p.set_inbound,
         'prior_registration_status', tn.registration_status,
         'prior_inbound_verified_at', tn.metadata->>'inbound_verified_at',
         'prior_sms_webhook_status', tn.metadata->>'sms_webhook_status'))
FROM patch p
WHERE p.id = tn.id
  AND (p.set_registered OR p.set_inbound);
