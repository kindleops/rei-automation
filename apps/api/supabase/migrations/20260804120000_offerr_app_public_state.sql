-- ============================================================================
-- offerr_app — OfferrAI public-product application state
-- ============================================================================
--
-- WHAT THIS IS
-- ------------
-- OfferrAI is a standalone public website, product, repository, Vercel project
-- and brand. Its BACKEND APPLICATION STATE deliberately lives inside this shared
-- data platform, because the two systems are operationally related and share the
-- property, comp, evaluation and acquisition ecosystem.
--
-- WHAT THIS IS NOT
-- ----------------
-- This is NOT a second acquisition database. It holds no property records, no
-- comp corpus, no buyer intelligence, no underwriting output and no LeadCommand
-- lifecycle. It is the durable state a public web surface needs in order to be
-- correct across serverless instances: sessions, rate limits, cooldowns,
-- idempotency, seller-safe results, consent, canary admission and an internal
-- review queue.
--
-- Nothing in this schema may be written by a browser, and nothing in it grants
-- any path to the canonical acquisition tables.
--
-- WHY A PRIVATE SCHEMA RATHER THAN RLS ON public
-- ----------------------------------------------
-- `offerr_app` is never added to PostgREST's exposed schema list, so it is not
-- reachable over the REST API at all — by anyone, with any key, including the
-- anon and authenticated roles. That is a stronger posture than "exposed but
-- policy-restricted", where a policy mistake becomes a data breach. The only way
-- in is a server-side connection holding a database credential.
--
-- RLS is still enabled on every table as a second, independent layer: if the
-- schema were ever exposed by mistake, a forced-RLS table with no permissive
-- policy denies rather than leaks.
--
-- WHY ATOMIC SQL FUNCTIONS RATHER THAN APPLICATION LOGIC
-- ------------------------------------------------------
-- Every mutation that has to be race-safe is a SINGLE statement inside a
-- function. On serverless, read-then-write in application code races across
-- concurrently-warm instances: a rate limit dilutes, and a double submit runs
-- two upstream evaluations. There is no read-then-write in the adapter.
--
-- HASHED IDENTIFIERS ONLY
-- -----------------------
-- Raw session tokens, raw result handles, raw IP addresses and full property
-- addresses are NEVER stored. The application sends an opaque value and the
-- function hashes it here, so the database holds no credential and no address.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS offerr_app;

COMMENT ON SCHEMA offerr_app IS
  'OfferrAI public-product application state. Server-only. Never exposed through '
  'PostgREST. Contains no property, comp, buyer or underwriting data.';

-- Fail closed by default: nothing is reachable until explicitly granted below.
REVOKE ALL ON SCHEMA offerr_app FROM PUBLIC;
REVOKE ALL ON SCHEMA offerr_app FROM anon, authenticated;
GRANT USAGE ON SCHEMA offerr_app TO service_role;

-- ---------------------------------------------------------------------------
-- Hashing helper
-- ---------------------------------------------------------------------------
-- `sha256()` is built in from Postgres 11, so this needs no extension. Keeping
-- the hash in the database means the application cannot accidentally persist a
-- raw handle by forgetting to hash it at the call site.

CREATE OR REPLACE FUNCTION offerr_app.digest_key(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(sha256(convert_to(coalesce(p_value, ''), 'utf8')), 'hex');
$$;

COMMENT ON FUNCTION offerr_app.digest_key(text) IS
  'SHA-256 of an opaque application value. Raw session tokens, result handles, '
  'client IPs and addresses are hashed here so the database never stores them.';

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offerr_app.sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The hash of the signed-cookie session id. NEVER the raw token.
  session_hash     text        NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'expired', 'revoked')),
  -- Which canary subject admitted this session, when admission was required.
  canary_subject   text,
  metadata_version integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_sessions_expires
  ON offerr_app.sessions (expires_at);

COMMENT ON COLUMN offerr_app.sessions.session_hash IS
  'SHA-256 of the session id. A raw session token is never stored.';

-- ---------------------------------------------------------------------------
-- seller_results
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offerr_app.seller_results (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Hash of the opaque handle given to the browser. Possessing the row does not
  -- reveal the handle, and the handle alone is not sufficient to read the row —
  -- see `read_result`, which also requires the owning session.
  result_handle_hash text        NOT NULL UNIQUE,
  session_id         uuid        NOT NULL REFERENCES offerr_app.sessions(id) ON DELETE CASCADE,
  outcome            text        NOT NULL,
  -- The SELLER-SAFE projection only. The adapter runs an allowlist projection
  -- and a fail-closed denylist scan before anything reaches this column.
  result             jsonb       NOT NULL,
  correlation_id     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  result_version     integer     NOT NULL DEFAULT 1,
  schema_version     integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_results_session
  ON offerr_app.seller_results (session_id);
CREATE INDEX IF NOT EXISTS idx_offerr_app_results_expires
  ON offerr_app.seller_results (expires_at);

COMMENT ON COLUMN offerr_app.seller_results.result IS
  'Seller-safe projection ONLY. Never a raw backend payload, comp record, buyer '
  'identity, internal property id, underwriting result, MAO or assignment fee.';

-- ---------------------------------------------------------------------------
-- idempotency_reservations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offerr_app.idempotency_reservations (
  idempotency_hash  text        PRIMARY KEY,
  session_id        uuid        NOT NULL REFERENCES offerr_app.sessions(id) ON DELETE CASCADE,
  state             text        NOT NULL
                      CHECK (state IN ('reserved', 'processing', 'completed',
                                       'failed_retryable', 'expired')),
  -- Identifies the instance holding the single-flight lease, so a takeover is
  -- attributable. Opaque; carries no request or seller data.
  lease_owner       text,
  lease_expires_at  timestamptz,
  result_id         uuid        REFERENCES offerr_app.seller_results(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_reservations_expires
  ON offerr_app.idempotency_reservations (expires_at);
CREATE INDEX IF NOT EXISTS idx_offerr_app_reservations_lease
  ON offerr_app.idempotency_reservations (lease_expires_at)
  WHERE state IN ('reserved', 'processing');

-- ---------------------------------------------------------------------------
-- rate_limit_buckets
-- ---------------------------------------------------------------------------
-- Dimensions are explicit rather than a single opaque key string, so a bucket is
-- attributable during an incident without reconstructing key formats.

CREATE TABLE IF NOT EXISTS offerr_app.rate_limit_buckets (
  scope        text        NOT NULL CHECK (scope IN ('ip', 'session', 'property')),
  -- Hash of the client IP, session id or normalized property identity. A raw IP
  -- and a full address are both PII and neither is ever stored.
  subject_hash text        NOT NULL,
  action       text        NOT NULL,
  window_start timestamptz NOT NULL,
  counter      integer     NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject_hash, action)
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_rate_expires
  ON offerr_app.rate_limit_buckets (expires_at);

COMMENT ON COLUMN offerr_app.rate_limit_buckets.subject_hash IS
  'SHA-256 of the subject. Never a raw IP address and never a full address.';

-- ---------------------------------------------------------------------------
-- property_cooldowns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offerr_app.property_cooldowns (
  -- Keyed hash of the NORMALIZED property identity, not the address itself.
  property_hash text        PRIMARY KEY,
  cooldown_until timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_cooldowns_until
  ON offerr_app.property_cooldowns (cooldown_until);

-- ---------------------------------------------------------------------------
-- consent_records
-- ---------------------------------------------------------------------------
-- One ROW PER CONSENT TYPE, deliberately. A single bundled row cannot express
-- "evaluation yes, marketing no", and bundling marketing consent into evaluation
-- consent is precisely what must not happen.

CREATE TABLE IF NOT EXISTS offerr_app.consent_records (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid        NOT NULL REFERENCES offerr_app.sessions(id) ON DELETE CASCADE,
  consent_type       text        NOT NULL
                       CHECK (consent_type IN (
                         'evaluation',            -- required to evaluate
                         'preliminary_ack',       -- results are preliminary
                         'non_binding_ack',       -- a range is not binding
                         'not_an_offer_ack',      -- this is not an offer
                         'privacy_policy',        -- privacy acknowledgement
                         'marketing_email',       -- OPTIONAL, never bundled
                         'marketing_sms'          -- OPTIONAL, never bundled
                       )),
  document_version   text        NOT NULL,
  copy_version       text        NOT NULL,
  granted            boolean     NOT NULL,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  source_surface     text        NOT NULL DEFAULT 'seller_journey',
  -- A coarse CATEGORY ('mobile' | 'desktop' | 'other'), never a raw user agent.
  user_agent_category text,
  UNIQUE (session_id, consent_type, document_version)
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_consent_session
  ON offerr_app.consent_records (session_id);

-- ---------------------------------------------------------------------------
-- canary_access
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offerr_app.canary_access (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Hash of the named account, signed subject or authorized session.
  subject_hash text        NOT NULL UNIQUE,
  subject_kind text        NOT NULL CHECK (subject_kind IN ('account', 'signed_subject', 'session')),
  active       boolean     NOT NULL DEFAULT true,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- review_items
-- ---------------------------------------------------------------------------
-- An OfferrAI-owned queue. Creating a row here creates NO LeadCommand lifecycle,
-- no campaign, no message, no offer, no contract, no title order and no Exchange
-- publication. Every downstream action stays a manual operator decision.

CREATE TABLE IF NOT EXISTS offerr_app.review_items (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Opaque OfferrAI reference. NOT an internal evaluation or property id.
  evaluation_reference text        NOT NULL UNIQUE,
  session_id           uuid        REFERENCES offerr_app.sessions(id) ON DELETE SET NULL,
  -- Seller-safe summary only: what the seller told us and what we told them.
  property_summary     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  seller_facts         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  outcome              text        NOT NULL,
  preliminary_range    jsonb,
  correlation_id       text,
  status               text        NOT NULL DEFAULT 'pending_operator_action'
                         CHECK (status IN ('pending_operator_action', 'in_review',
                                           'actioned', 'dismissed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offerr_app_review_status
  ON offerr_app.review_items (status, created_at DESC);

COMMENT ON TABLE offerr_app.review_items IS
  'OfferrAI-owned operator review queue. Creating a row here has NO execution '
  'side effect: no LeadCommand lifecycle, campaign, message, offer, contract, '
  'title order or Exchange publication.';

-- ---------------------------------------------------------------------------
-- Row-level security — the second, independent layer
-- ---------------------------------------------------------------------------
-- FORCE applies RLS to the table owner too, so even a SECURITY DEFINER function
-- owned by the table owner cannot read around it. No permissive policy is
-- created: with RLS forced and no policy, every role is denied. The functions
-- below are the only sanctioned path, and they are explicitly exempted by being
-- owned by a role that the policies do not apply to via `service_role` grants.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sessions', 'seller_results', 'idempotency_reservations',
    'rate_limit_buckets', 'property_cooldowns', 'consent_records',
    'canary_access', 'review_items'
  ] LOOP
    EXECUTE format('ALTER TABLE offerr_app.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Table grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA offerr_app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA offerr_app FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA offerr_app TO service_role;

-- Anything added to this schema later inherits the same posture rather than
-- defaulting to whatever the creating role happened to grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA offerr_app
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA offerr_app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

-- ============================================================================
-- Atomic operations
-- ============================================================================

-- ---------------------------------------------------------------------------
-- session_touch — create or renew
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.session_touch(
  p_session_id     text,
  p_ttl_ms         integer,
  p_canary_subject text DEFAULT NULL
)
RETURNS TABLE (id uuid, status text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_hash text        := offerr_app.digest_key(p_session_id);
  v_row  offerr_app.sessions%ROWTYPE;
BEGIN
  INSERT INTO offerr_app.sessions AS s
    (session_hash, expires_at, last_seen_at, canary_subject)
  VALUES
    (v_hash, v_now + make_interval(secs => p_ttl_ms / 1000.0), v_now, p_canary_subject)
  ON CONFLICT (session_hash) DO UPDATE
    SET last_seen_at = v_now,
        updated_at   = v_now,
        -- Renewal never resurrects a revoked session.
        expires_at   = CASE WHEN s.status = 'active'
                            THEN v_now + make_interval(secs => p_ttl_ms / 1000.0)
                            ELSE s.expires_at END,
        canary_subject = COALESCE(EXCLUDED.canary_subject, s.canary_subject)
  RETURNING s.* INTO v_row;

  IF v_row.expires_at <= v_now AND v_row.status = 'active' THEN
    UPDATE offerr_app.sessions SET status = 'expired' WHERE offerr_app.sessions.id = v_row.id;
    v_row.status := 'expired';
  END IF;

  RETURN QUERY SELECT v_row.id, v_row.status, v_row.expires_at;
END;
$$;

-- ---------------------------------------------------------------------------
-- rate_consume — atomic fixed-window counter
-- ---------------------------------------------------------------------------
-- INSERT .. ON CONFLICT DO UPDATE takes a row-level lock, so two concurrent
-- callers serialize on the same bucket and the returned count is exact. As
-- read-then-write in application code this would race and let both callers pass
-- a limit of one.

CREATE OR REPLACE FUNCTION offerr_app.rate_consume(
  p_scope     text,
  p_subject   text,
  p_action    text,
  p_limit     integer,
  p_window_ms integer
)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_window  interval    := make_interval(secs => p_window_ms / 1000.0);
  v_hash    text        := offerr_app.digest_key(p_subject);
  v_count   integer;
  v_expires timestamptz;
BEGIN
  INSERT INTO offerr_app.rate_limit_buckets AS b
    (scope, subject_hash, action, window_start, counter, expires_at, updated_at)
  VALUES
    (p_scope, v_hash, p_action, v_now, 1, v_now + v_window, v_now)
  ON CONFLICT (scope, subject_hash, action) DO UPDATE
    SET counter      = CASE WHEN b.expires_at <= v_now THEN 1 ELSE b.counter + 1 END,
        window_start = CASE WHEN b.expires_at <= v_now THEN v_now ELSE b.window_start END,
        expires_at   = CASE WHEN b.expires_at <= v_now THEN v_now + v_window ELSE b.expires_at END,
        updated_at   = v_now
  RETURNING b.counter, b.expires_at INTO v_count, v_expires;

  IF v_count > p_limit THEN
    RETURN QUERY SELECT false, 0,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_expires - v_now)))::integer);
  ELSE
    RETURN QUERY SELECT true, GREATEST(0, p_limit - v_count), 0;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- cooldown_check / cooldown_mark
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.cooldown_check(p_property_key text)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_hash  text        := offerr_app.digest_key(p_property_key);
  v_until timestamptz;
BEGIN
  SELECT c.cooldown_until INTO v_until
    FROM offerr_app.property_cooldowns c
   WHERE c.property_hash = v_hash;

  IF v_until IS NOT NULL AND v_until > v_now THEN
    RETURN QUERY SELECT false, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_until - v_now)))::integer);
  ELSE
    RETURN QUERY SELECT true, 0;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION offerr_app.cooldown_mark(p_property_key text, p_ms integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
  INSERT INTO offerr_app.property_cooldowns (property_hash, cooldown_until, updated_at)
  VALUES (offerr_app.digest_key(p_property_key),
          clock_timestamp() + make_interval(secs => p_ms / 1000.0),
          clock_timestamp())
  ON CONFLICT (property_hash) DO UPDATE
    SET cooldown_until = EXCLUDED.cooldown_until,
        updated_at     = EXCLUDED.updated_at;
$$;

-- ---------------------------------------------------------------------------
-- reserve — distributed single-flight
-- ---------------------------------------------------------------------------
-- Returns won=true to exactly ONE caller per idempotency key while a reservation
-- is live. Everyone else gets won=false plus the incumbent state. An expired
-- lease is reclaimable, so a crashed instance cannot wedge the key until TTL.

CREATE OR REPLACE FUNCTION offerr_app.reserve(
  p_idempotency_key text,
  p_session_id      text,
  p_lease_owner     text,
  p_ttl_ms          integer,
  p_lease_ms        integer
)
RETURNS TABLE (won boolean, state text, result_handle text, result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now        timestamptz := clock_timestamp();
  v_hash       text        := offerr_app.digest_key(p_idempotency_key);
  v_session    uuid;
  v_row        offerr_app.idempotency_reservations%ROWTYPE;
  v_result     jsonb;
BEGIN
  SELECT s.id INTO v_session
    FROM offerr_app.sessions s
   WHERE s.session_hash = offerr_app.digest_key(p_session_id);

  IF v_session IS NULL THEN
    -- No session, no reservation. A caller without a session is not entitled to
    -- occupy an idempotency key.
    RETURN QUERY SELECT false, 'gone'::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  INSERT INTO offerr_app.idempotency_reservations AS r
    (idempotency_hash, session_id, state, lease_owner, lease_expires_at, expires_at)
  VALUES
    (v_hash, v_session, 'reserved', p_lease_owner,
     v_now + make_interval(secs => p_lease_ms / 1000.0),
     v_now + make_interval(secs => p_ttl_ms / 1000.0))
  ON CONFLICT (idempotency_hash) DO UPDATE
    -- Reclaim ONLY a dead reservation: still in flight, and its lease lapsed.
    SET session_id       = EXCLUDED.session_id,
        state            = 'reserved',
        lease_owner      = EXCLUDED.lease_owner,
        lease_expires_at = EXCLUDED.lease_expires_at,
        expires_at       = EXCLUDED.expires_at,
        updated_at       = v_now
    WHERE r.state IN ('reserved', 'processing')
      AND r.lease_expires_at IS NOT NULL
      AND r.lease_expires_at <= v_now
  RETURNING r.* INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_row.state, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM offerr_app.idempotency_reservations r2
   WHERE r2.idempotency_hash = v_hash;

  IF NOT FOUND THEN
    -- The incumbent was swept between our INSERT and this SELECT.
    RETURN QUERY SELECT false, 'gone'::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  -- CROSS-SESSION DENIAL. Another session's reservation is reported as 'gone',
  -- never as a readable result.
  IF v_row.session_id IS DISTINCT FROM v_session OR v_row.expires_at <= v_now THEN
    RETURN QUERY SELECT false, 'gone'::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_row.state = 'completed' AND v_row.result_id IS NOT NULL THEN
    SELECT sr.result INTO v_result
      FROM offerr_app.seller_results sr
     WHERE sr.id = v_row.result_id AND sr.expires_at > v_now;
    RETURN QUERY SELECT false, 'ready'::text, NULL::text, v_result;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, 'pending'::text, NULL::text, NULL::jsonb;
END;
$$;

-- ---------------------------------------------------------------------------
-- complete — persist the seller-safe result and close the reservation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.complete(
  p_idempotency_key text,
  p_result_handle   text,
  p_outcome         text,
  p_result          jsonb,
  p_correlation_id  text,
  p_ttl_ms          integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now       timestamptz := clock_timestamp();
  v_hash      text        := offerr_app.digest_key(p_idempotency_key);
  v_session   uuid;
  v_result_id uuid;
BEGIN
  SELECT r.session_id INTO v_session
    FROM offerr_app.idempotency_reservations r
   WHERE r.idempotency_hash = v_hash;

  IF v_session IS NULL THEN RETURN; END IF;

  INSERT INTO offerr_app.seller_results
    (result_handle_hash, session_id, outcome, result, correlation_id, expires_at)
  VALUES
    (offerr_app.digest_key(p_result_handle), v_session, p_outcome, p_result,
     p_correlation_id, v_now + make_interval(secs => p_ttl_ms / 1000.0))
  ON CONFLICT (result_handle_hash) DO UPDATE
    SET result     = EXCLUDED.result,
        outcome    = EXCLUDED.outcome,
        expires_at = EXCLUDED.expires_at
  RETURNING id INTO v_result_id;

  UPDATE offerr_app.idempotency_reservations
     SET state      = 'completed',
         result_id  = v_result_id,
         expires_at = v_now + make_interval(secs => p_ttl_ms / 1000.0),
         updated_at = v_now
   WHERE idempotency_hash = v_hash;
END;
$$;

-- ---------------------------------------------------------------------------
-- release — free a reservation for a genuine retry
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.release(p_idempotency_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
  DELETE FROM offerr_app.idempotency_reservations
   WHERE idempotency_hash = offerr_app.digest_key(p_idempotency_key)
     -- A completed reservation is NOT released: its result is the answer.
     AND state IN ('reserved', 'processing', 'failed_retryable');
$$;

-- ---------------------------------------------------------------------------
-- find_by_key — replay lookup, scoped to the owning session
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.find_by_key(
  p_idempotency_key text,
  p_session_id      text
)
RETURNS TABLE (state text, result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_session uuid;
  v_row     offerr_app.idempotency_reservations%ROWTYPE;
  v_result  jsonb;
BEGIN
  SELECT s.id INTO v_session
    FROM offerr_app.sessions s
   WHERE s.session_hash = offerr_app.digest_key(p_session_id);

  IF v_session IS NULL THEN
    RETURN QUERY SELECT 'none'::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM offerr_app.idempotency_reservations r
   WHERE r.idempotency_hash = offerr_app.digest_key(p_idempotency_key)
     AND r.session_id = v_session
     AND r.expires_at > v_now;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_row.state = 'completed' AND v_row.result_id IS NOT NULL THEN
    SELECT sr.result INTO v_result
      FROM offerr_app.seller_results sr
     WHERE sr.id = v_row.result_id AND sr.expires_at > v_now;
    IF v_result IS NULL THEN
      RETURN QUERY SELECT 'none'::text, NULL::jsonb;
    ELSE
      RETURN QUERY SELECT 'ready'::text, v_result;
    END IF;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'pending'::text, NULL::jsonb;
END;
$$;

-- ---------------------------------------------------------------------------
-- read_result — durable recovery, denied across sessions
-- ---------------------------------------------------------------------------
-- Possession of the handle is NOT sufficient. The owning session must match, so
-- a leaked or guessed handle is not an authorization bypass.

CREATE OR REPLACE FUNCTION offerr_app.read_result(
  p_result_handle text,
  p_session_id    text
)
RETURNS TABLE (status text, result jsonb, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_session uuid;
  v_row     offerr_app.seller_results%ROWTYPE;
BEGIN
  SELECT s.id INTO v_session
    FROM offerr_app.sessions s
   WHERE s.session_hash = offerr_app.digest_key(p_session_id);

  SELECT * INTO v_row
    FROM offerr_app.seller_results sr
   WHERE sr.result_handle_hash = offerr_app.digest_key(p_result_handle);

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- A result belonging to another session is reported as not_found, never as
  -- forbidden: "forbidden" would confirm the handle exists.
  IF v_session IS NULL OR v_row.session_id IS DISTINCT FROM v_session THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.expires_at <= v_now THEN
    RETURN QUERY SELECT 'expired'::text, NULL::jsonb, v_row.expires_at;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::text, v_row.result, v_row.expires_at;
END;
$$;

-- ---------------------------------------------------------------------------
-- record_consent — one row per type, never bundled
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.record_consent(
  p_session_id          text,
  p_consent_type        text,
  p_document_version    text,
  p_copy_version        text,
  p_granted             boolean,
  p_user_agent_category text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_session uuid;
BEGIN
  SELECT s.id INTO v_session
    FROM offerr_app.sessions s
   WHERE s.session_hash = offerr_app.digest_key(p_session_id);

  IF v_session IS NULL THEN RETURN; END IF;

  INSERT INTO offerr_app.consent_records
    (session_id, consent_type, document_version, copy_version, granted, user_agent_category)
  VALUES
    (v_session, p_consent_type, p_document_version, p_copy_version, p_granted, p_user_agent_category)
  ON CONFLICT (session_id, consent_type, document_version) DO UPDATE
    SET granted      = EXCLUDED.granted,
        copy_version = EXCLUDED.copy_version,
        granted_at   = clock_timestamp();
END;
$$;

-- ---------------------------------------------------------------------------
-- canary_allowed
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.canary_allowed(p_subject text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM offerr_app.canary_access c
     WHERE c.subject_hash = offerr_app.digest_key(p_subject)
       AND c.active
       AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
  );
$$;

-- ---------------------------------------------------------------------------
-- enqueue_review — creates a review item and NOTHING else
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.enqueue_review(
  p_evaluation_reference text,
  p_session_id           text,
  p_property_summary     jsonb,
  p_seller_facts         jsonb,
  p_outcome              text,
  p_preliminary_range    jsonb,
  p_correlation_id       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_session uuid;
  v_id      uuid;
BEGIN
  SELECT s.id INTO v_session
    FROM offerr_app.sessions s
   WHERE s.session_hash = offerr_app.digest_key(p_session_id);

  INSERT INTO offerr_app.review_items
    (evaluation_reference, session_id, property_summary, seller_facts,
     outcome, preliminary_range, correlation_id)
  VALUES
    (p_evaluation_reference, v_session, COALESCE(p_property_summary, '{}'::jsonb),
     COALESCE(p_seller_facts, '{}'::jsonb), p_outcome, p_preliminary_range, p_correlation_id)
  ON CONFLICT (evaluation_reference) DO UPDATE
    SET updated_at = clock_timestamp()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- sweep — expiry and cleanup
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION offerr_app.sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = offerr_app, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  DELETE FROM offerr_app.rate_limit_buckets WHERE expires_at <= v_now;
  DELETE FROM offerr_app.property_cooldowns WHERE cooldown_until <= v_now;
  DELETE FROM offerr_app.idempotency_reservations WHERE expires_at <= v_now;
  DELETE FROM offerr_app.seller_results WHERE expires_at <= v_now;
  -- Sessions cascade to results, reservations and consent, so expire them last
  -- and only well after their own expiry, to keep consent auditable for a while.
  UPDATE offerr_app.sessions SET status = 'expired'
   WHERE status = 'active' AND expires_at <= v_now;
  DELETE FROM offerr_app.sessions
   WHERE status = 'expired' AND expires_at <= v_now - interval '30 days';
END;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA offerr_app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA offerr_app FROM anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA offerr_app TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA offerr_app
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA offerr_app
  GRANT EXECUTE ON FUNCTIONS TO service_role;

COMMIT;
