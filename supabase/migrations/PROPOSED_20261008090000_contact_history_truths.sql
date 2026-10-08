-- =============================================================================
-- ONE contact-history truth: property / person / phone / current-best-contact.
-- STATUS: PROPOSED · NOT APPLIED · needs owner approval (owner out of auto mode).
-- Report: ~/.claude/jobs/c39b0175/tmp/hot-sellers/P2_identity_contact_report.md
-- JS twin (same definitions, keep in sync): apps/api/src/lib/domain/campaigns/contact-history-truths.js (v2)
--
-- WHY. campaign_target_graph.never_contacted / touch_count / pending_prior_touch are
-- PHONE-level on the row's CURRENT canonical_e164 (campaign_target_graph_enrich_rows,
-- me/sq CTEs keyed ON e164). Measured 2026-10-08 (extracts 03:12Z): 6,987 properties
-- read never_contacted=true although the ledger shows outreach:
--   B 2,315 graph has no phone · C1 1,179 owner texted on another of HIS numbers ·
--   C2 281 another person's number · C3 1,849 texted number not in seller.owner_phone
--   (legacy feeder / public.phones) · D 50 failed attempts only · E 560 owner's phone
--   texted about another property · F 753 master_owner_id touch only.
-- 0 rows where the graph phone itself was texted and missed (no format/staleness bug).
-- campaign_id is NOT a cause: the graph never keys on it (93% of the B/C sends are legacy-feeder rows, no campaign_id).
--
-- WHAT. Supersedes the refresh in PROPOSED_20261005161000_ctg_property_ever_contacted
-- (apply THIS INSTEAD of 161000; same three property_* columns, v2 ledger) and implements
-- OPTION_B §3 (prior person keys) with the person and pair truths added.
--   §1 columns on campaign_target_graph (projection only)
--   §2 public.contact_history_truths(graph_ids)  — THE definition (STABLE, read-only, bounded)
--   §3 public.refresh_campaign_target_graph_contact_truths(after, limit) — keyset, diff-only writer
-- queue_eligible / queue_block_reason / never_contacted are NOT changed. Eligibility moves
-- only in the app, behind CAMPAIGN_CONTACT_TRUTHS (off → shadow → on):
--   Composer/Build never_contacted_only  (campaign-automation-service.js, freshOpenerVerdict)
--   enqueue retext hold                  (enqueue-campaign-target-one.js, CAMPAIGN_PROPERTY_TOUCH_HOLD)
--   graph build                          (this projection, refreshed after enrich)
-- Dry run 2026-10-08 (queue_eligible 93,097 rows in the 03:12Z extract; live 92,947 at 04:47Z):
--   retext_hold → 1,649 opener-ineligible (prior recipient unknown 1,141 · same person new
--   phone 425 · candidate person unknown 77 · phone ownership unproven 6); 2 released as a
--   proven different person; person reached about another property on a new phone 220
--   (separate reason, shadow first). 3,764 phone-touched >30 d rows are unchanged (follow-up lane).
--
-- APPLY ORDER (off-peak, owner present):
--   0. _pretest.sql (read-only).
--   1. _index.sql via execute_sql (CONCURRENTLY, no transaction).
--   2. THIS FILE via apply_migration (one transaction; lock_timeout 5s; ADD COLUMN with
--      constant defaults is metadata-only).
--   3. Backfill: SELECT public.refresh_campaign_target_graph_contact_truths(NULL, 2000);
--      then repeat with the returned 'next' until done=true (~10–15 calls).
--   4. Schedule (owner): pg_cron '*/10' calling the same function from NULL (one pass per tick).
--   5. _pretest.sql POSTCHECK. Then add the four columns to the graph select list in
--      campaign-automation-service.js (GRAPH_CANDIDATE_COLUMNS, ~l.3537) — NOT before step 2
--      (an unknown column fails the whole PostgREST query) — and set CAMPAIGN_CONTACT_TRUTHS=shadow.
-- Rollback: _rollback.sql
-- =============================================================================

SET LOCAL lock_timeout = '5s';

-- §1 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.campaign_target_graph
  ADD COLUMN IF NOT EXISTS property_ever_contacted       boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS property_last_outbound_at     timestamptz,
  ADD COLUMN IF NOT EXISTS property_outbound_count       integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS person_ever_contacted         boolean,              -- NULL = person unknown, never false
  ADD COLUMN IF NOT EXISTS person_last_contact_at        timestamptz,
  ADD COLUMN IF NOT EXISTS current_best_contact_touched  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS property_prior_person_keys    text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS property_prior_person_unknown boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retext_hold                   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retext_hold_why               text,
  ADD COLUMN IF NOT EXISTS contact_truths_at             timestamptz;

COMMENT ON COLUMN public.campaign_target_graph.property_ever_contacted IS 'contact_history_truths.v2 PROPERTY: any send about this property_id, any phone (send_queue sent/in-flight ∪ message_events outbound, failures excluded).';
COMMENT ON COLUMN public.campaign_target_graph.person_ever_contacted IS 'contact_history_truths.v2 PERSON: any send to seller_person_key (resolved recipient, or to one of the person''s own plaintext owner_phone numbers), any property. NULL when the row has no person key.';
COMMENT ON COLUMN public.campaign_target_graph.current_best_contact_touched IS 'contact_history_truths.v2 PAIR: canonical_e164 was texted and the recipient was this person or unknown. PHONE history stays in never_contacted.';
COMMENT ON COLUMN public.campaign_target_graph.retext_hold IS 'contact_history_truths.v2 RETEXT (openers only): property touched, this phone not, and the new number is not proven to be a different person. Read by the app only behind CAMPAIGN_CONTACT_TRUTHS / CAMPAIGN_PROPERTY_TOUCH_HOLD.';

-- §2 ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contact_history_truths(p_graph_ids text[])
RETURNS TABLE (
  graph_id text,
  property_ever_contacted boolean, property_last_outbound_at timestamptz, property_outbound_count integer,
  person_ever_contacted boolean, person_last_contact_at timestamptz,
  phone_contacted boolean, current_best_contact_touched boolean,
  property_prior_person_keys text[], property_prior_person_unknown boolean,
  retext_hold boolean, retext_hold_why text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH g AS (
    SELECT g.graph_id, g.property_id, NULLIF(g.seller_person_key, '') AS k,
           NULLIF(right(regexp_replace(COALESCE(g.canonical_e164, ''), '\D', '', 'g'), 10), '') AS e
    FROM public.campaign_target_graph g
    WHERE g.graph_id = ANY (p_graph_ids)
    LIMIT 2000                                   -- bounded, like enrich_rows
  ),
  kph AS (                                       -- each candidate person's OWN plaintext numbers
    SELECT DISTINCT op.individual_key AS k, right(op.phone_value, 10) AS ph
    FROM seller.owner_phone op
    WHERE op.individual_key IN (SELECT k FROM g WHERE k IS NOT NULL)
      AND NOT COALESCE(op.is_encrypted, false) AND op.phone_value ~ '^[0-9]{10}$'
  ),
  alias AS (                                     -- duplicate person records: share a plaintext number with K
    SELECT DISTINCT kph.k, op2.individual_key AS a
    FROM kph JOIN seller.owner_phone op2 ON op2.phone_value = kph.ph AND NOT COALESCE(op2.is_encrypted, false)
  ),
  sc_ph AS (SELECT e AS ph FROM g WHERE e IS NOT NULL UNION SELECT ph FROM kph),
  ledger AS (                                    -- ONE ledger: what "a touch" means everywhere
    SELECT s.property_id, right(regexp_replace(COALESCE(s.to_phone_number, ''), '\D', '', 'g'), 10) AS ph,
           NULLIF(s.prospect_id, '') AS prospect_id, COALESCE(s.sent_at, s.scheduled_for, s.created_at) AS at, 'sq'::text AS src
    FROM public.send_queue s
    WHERE (s.sent_at IS NOT NULL
           OR lower(COALESCE(s.queue_status, '')) IN ('sent','delivered','queued','scheduled','sending','processing','claimed','pending','retry'))
      AND (s.property_id IN (SELECT property_id FROM g)
           OR s.to_phone_number IN (SELECT ph FROM sc_ph UNION ALL SELECT '+1' || ph FROM sc_ph)
           OR s.prospect_id IN (SELECT k FROM g WHERE k IS NOT NULL))
    UNION ALL
    SELECT m.property_id, right(regexp_replace(COALESCE(m.to_phone_number, ''), '\D', '', 'g'), 10),
           NULLIF(m.prospect_id, ''), COALESCE(m.event_timestamp, m.sent_at, m.created_at), 'me'
    FROM public.message_events m
    WHERE m.direction ILIKE 'out%' AND COALESCE(m.event_type, '') NOT ILIKE '%fail%' AND NOT COALESCE(m.is_final_failure, false)
      AND (m.property_id IN (SELECT property_id FROM g)
           OR m.to_phone_number IN (SELECT '+1' || ph FROM sc_ph))
  ),
  lprop AS (SELECT DISTINCT property_id FROM ledger WHERE property_id IS NOT NULL),
  linked AS (                                    -- persons linked to each touched property (never master_owner_id)
    SELECT lp.property_id, x.k
    FROM lprop lp
    LEFT JOIN seller.property_owner_resolution_v1 r ON r.property_id = lp.property_id
    LEFT JOIN seller.property_entity_contact_v1 ec ON ec.property_id = lp.property_id
    CROSS JOIN LATERAL unnest(array_remove(ARRAY[r.individual_key, r.co_owner_individual_key, ec.selected_person_key], NULL)) AS x(k)
  ),
  lr AS (                                        -- recipient person per send: (a) person key on the send, (b) unique linked owner of the number, (c) unknown
    SELECT l.*,
      COALESCE(
        (SELECT o.individual_key FROM seller.owner o WHERE o.individual_key = l.prospect_id),
        (SELECT min(op.individual_key)
           FROM linked lk JOIN seller.owner_phone op ON op.individual_key = lk.k
          WHERE lk.property_id = l.property_id AND op.phone_value = l.ph AND NOT COALESCE(op.is_encrypted, false)
         HAVING count(DISTINCT op.individual_key) = 1)
      ) AS recipient
    FROM ledger l
  ),
  gl AS (                                       -- candidate row × every ledger send that can bear on it
    SELECT g.graph_id, g.property_id AS gp, g.k, g.e, lr.property_id AS lp, lr.ph, lr.src, lr.at, lr.recipient,
           EXISTS (SELECT 1 FROM kph WHERE kph.k = g.k AND kph.ph = lr.ph) AS to_kphone
    FROM g
    LEFT JOIN lr ON lr.property_id = g.property_id OR lr.ph = g.e
                 OR (g.k IS NOT NULL AND (lr.recipient = g.k OR EXISTS (SELECT 1 FROM kph WHERE kph.k = g.k AND kph.ph = lr.ph)))
  ),
  t AS (
    SELECT graph_id, gp AS property_id, k, e,
      count(*) FILTER (WHERE lp = gp AND src = 'sq')                                  AS p_sq,
      count(*) FILTER (WHERE lp = gp AND src = 'me')                                  AS p_me,
      max(at) FILTER (WHERE lp = gp)                                                  AS p_last,
      count(*) FILTER (WHERE ph = e)                                                  AS ph_n,
      count(*) FILTER (WHERE ph = e AND (k IS NULL OR recipient IS NULL OR recipient = k)) AS pair_n,
      count(*) FILTER (WHERE k IS NOT NULL AND (recipient = k OR to_kphone))          AS k_n,
      max(at) FILTER (WHERE k IS NOT NULL AND (recipient = k OR to_kphone))           AS k_last,
      COALESCE(array_agg(DISTINCT recipient) FILTER (WHERE lp = gp AND recipient IS NOT NULL), '{}') AS prior_keys,
      COALESCE(bool_or(recipient IS NULL) FILTER (WHERE lp = gp), false)              AS prior_unknown
    FROM gl
    GROUP BY graph_id, gp, k, e
  ),
  t2 AS (
    SELECT t.*,
      EXISTS (SELECT 1 FROM unnest(t.prior_keys) AS pk(k2)
               WHERE pk.k2 = t.k OR pk.k2 IN (SELECT al.a FROM alias al WHERE al.k = t.k)) AS same,
      EXISTS (SELECT 1 FROM kph WHERE kph.k = t.k AND kph.ph = t.e)                  AS owned
    FROM t
  ),
  t3 AS (
    SELECT t2.*, (t2.p_sq + t2.p_me) > 0 AS touched,
      (t2.k IS NOT NULL AND NOT t2.prior_unknown AND cardinality(t2.prior_keys) > 0 AND NOT t2.same AND t2.owned) AS different
    FROM t2
  )
  SELECT t3.graph_id,
    t3.touched, t3.p_last, GREATEST(t3.p_sq, t3.p_me)::integer,             -- the two ledgers describe the same sends → max, not sum
    CASE WHEN t3.k IS NULL THEN NULL ELSE t3.k_n > 0 END, t3.k_last,
    t3.ph_n > 0, t3.pair_n > 0,
    t3.prior_keys, t3.prior_unknown,
    (t3.touched AND t3.ph_n = 0 AND NOT t3.different),
    CASE WHEN NOT t3.touched OR t3.ph_n > 0 THEN NULL
         WHEN t3.different THEN 'released_known_different_person'
         WHEN t3.k IS NULL THEN 'candidate_person_unknown'
         WHEN t3.prior_unknown THEN 'prior_recipient_unknown'
         WHEN t3.same THEN 'same_person_new_phone'
         WHEN NOT t3.owned THEN 'phone_ownership_unproven'
         ELSE 'different_number_is_not_proof' END
  FROM t3;
$function$;

REVOKE ALL ON FUNCTION public.contact_history_truths(text[]) FROM PUBLIC, anon, authenticated;

-- §3 ─────────────────────────────────────────────────────────────────────────
-- Keyset pass over the graph rows the ledger can affect (+ rows currently flagged), at most
-- p_limit per call, writing only rows whose values change. Resumable: pass back 'next'.
CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_contact_truths(p_after text DEFAULT NULL, p_limit integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 2000);
  v_ids text[];
  v_rows integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('campaign_target_graph_projection')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;

  WITH sent_ph AS (
    SELECT DISTINCT right(regexp_replace(COALESCE(to_phone_number, ''), '\D', '', 'g'), 10) AS ph
    FROM public.send_queue WHERE sent_at IS NOT NULL OR lower(COALESCE(queue_status, '')) IN ('sent','delivered','queued','scheduled','sending','processing','claimed','pending','retry')
    UNION
    SELECT DISTINCT right(regexp_replace(COALESCE(to_phone_number, ''), '\D', '', 'g'), 10)
    FROM public.message_events WHERE direction ILIKE 'out%'
  ),
  cand AS (
    SELECT g.graph_id FROM public.campaign_target_graph g
     WHERE g.property_id IN (SELECT property_id FROM public.send_queue WHERE property_id IS NOT NULL
                             UNION SELECT property_id FROM public.message_events WHERE property_id IS NOT NULL AND direction ILIKE 'out%')
    UNION
    SELECT g.graph_id FROM public.campaign_target_graph g WHERE g.canonical_e164 IN (SELECT ph FROM sent_ph)
    UNION
    SELECT g.graph_id FROM public.campaign_target_graph g
     WHERE g.seller_person_key IN (SELECT op.individual_key FROM seller.owner_phone op
                                    WHERE op.phone_value IN (SELECT ph FROM sent_ph) AND NOT COALESCE(op.is_encrypted, false))
    UNION
    SELECT g.graph_id FROM public.campaign_target_graph g
     WHERE g.property_ever_contacted OR g.person_ever_contacted OR g.current_best_contact_touched OR g.retext_hold
  )
  SELECT array_agg(graph_id ORDER BY graph_id) INTO v_ids
  FROM (SELECT graph_id FROM cand WHERE p_after IS NULL OR graph_id > p_after ORDER BY graph_id LIMIT v_limit) b;

  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('rows', 0, 'done', true, 'ms', floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer);
  END IF;

  WITH tr AS (SELECT * FROM public.contact_history_truths(v_ids)),
  upd AS (
    UPDATE public.campaign_target_graph g SET
      property_ever_contacted       = tr.property_ever_contacted,
      property_last_outbound_at     = tr.property_last_outbound_at,
      property_outbound_count       = tr.property_outbound_count,
      person_ever_contacted         = tr.person_ever_contacted,
      person_last_contact_at        = tr.person_last_contact_at,
      current_best_contact_touched  = tr.current_best_contact_touched,
      property_prior_person_keys    = tr.property_prior_person_keys,
      property_prior_person_unknown = tr.property_prior_person_unknown,
      retext_hold                   = tr.retext_hold,
      retext_hold_why               = tr.retext_hold_why,
      contact_truths_at             = now()
    FROM tr
    WHERE g.graph_id = tr.graph_id
      AND (g.property_ever_contacted, g.property_last_outbound_at, g.property_outbound_count, g.person_ever_contacted,
           g.person_last_contact_at, g.current_best_contact_touched, g.property_prior_person_keys,
           g.property_prior_person_unknown, g.retext_hold, g.retext_hold_why)
          IS DISTINCT FROM
          (tr.property_ever_contacted, tr.property_last_outbound_at, tr.property_outbound_count, tr.person_ever_contacted,
           tr.person_last_contact_at, tr.current_best_contact_touched, tr.property_prior_person_keys,
           tr.property_prior_person_unknown, tr.retext_hold, tr.retext_hold_why)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_rows FROM upd;

  RETURN jsonb_build_object(
    'rows', v_rows, 'scanned', cardinality(v_ids), 'next', v_ids[cardinality(v_ids)],
    'done', cardinality(v_ids) < v_limit,
    'ms', floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer);
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_contact_truths(text, integer) FROM PUBLIC, anon, authenticated;
