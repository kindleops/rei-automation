-- ─────────────────────────────────────────────────────────────────────────────
-- Durable run locks + durable idempotency ledger.
--
-- WHY (the last two pieces of process-local correctness state):
--   Both `src/lib/domain/runs/run-locks.js` and
--   `src/lib/domain/events/idempotency-ledger.js` stored their authoritative
--   state in /tmp/real-estate-automation-runtime-state via
--   `runtime-state-store.js`. That directory is per-instance and ephemeral:
--     * a container/lambda restart loses every held lock and every claim,
--     * two instances never see each other's locks or claims at all,
--     * a webhook retry landing on a second instance re-runs the work.
--   These were the only remaining blockers to running apps/api on more than
--   one instance (and to running it on Cloudflare Containers, whose disk is
--   ephemeral by design).
--
--   The inbound path already solved exactly this problem in
--   20260802090000_inbound_claim_contract.sql. This migration generalises the
--   same proven shape to the two remaining consumers.
--
-- DESIGN NOTES:
--   * Atomicity lives in SQL, never in JavaScript. Every claim is
--     INSERT .. ON CONFLICT DO NOTHING followed by SELECT .. FOR UPDATE — the
--     two-round pattern from the inbound contract. There is no
--     SELECT-then-INSERT read-modify-write anywhere in this file.
--   * NOT advisory locks: session-scoped advisory locks die with a pooled or
--     recycled connection, which is precisely the failure mode we are removing.
--     These are ordinary rows, so they survive process death, connection loss,
--     redeploys and overlapping crons.
--   * `now()` (the database clock) is the only authority on expiry. No caller
--     may pass a "now".
--
-- BEHAVIOUR PRESERVED FROM THE JS IMPLEMENTATIONS (deliberately, so no caller
-- has to change):
--   * run lock statuses stay 'locked' / 'released'; the JS-facing `meta`
--     object keeps `scope` and `expires_at` as its key names.
--   * run lock reason strings stay 'lock_acquired', 'stale_lock_reclaimed',
--     'run_lock_active'.
--   * `meta.acquired_at` keeps its legacy meaning (time of the FIRST
--     acquisition, carried across reclaims) because existing fixtures assert
--     that shape. The durable, per-lease truth is the separate
--     `lease_acquired_at` column, which is rewritten on every acquisition.
--   * ledger statuses stay 'processing' / 'completed' / 'failed' (NOT
--     'claimed'), and the reason strings stay 'event_claimed',
--     'duplicate_event_ignored', 'event_already_processing',
--     'stale_or_failed_event_reclaimed'.
--   * ledger staleness is measured as now() - started_at > lease_ms, where
--     lease_ms is supplied per call and defaults to 600000 (10 minutes) —
--     the existing default, not a new one.
--
-- ONE DELIBERATE TIGHTENING (run locks only, explicitly requested):
--   `run_lock_release` now REQUIRES a matching lease_token. The JS version
--   wrote `status = 'released'` unconditionally, so an instance whose lease had
--   already expired and been reclaimed could release the NEW holder's lock.
--   Operator force-release is unaffected: it goes through
--   `run_lock_force_release`, which is what /api/internal/runs/release-lock
--   already calls.
--   The idempotency ledger's complete/fail are intentionally NOT fenced,
--   because the JS functions never received a claim token and fencing them
--   would change public behaviour.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. RUN LOCKS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.run_locks (
  lock_key text PRIMARY KEY,
  lease_token uuid NOT NULL,
  owner text,
  status text NOT NULL DEFAULT 'locked'
    CHECK (status IN ('locked', 'released')),
  lease_ms integer NOT NULL DEFAULT 600000,
  -- First acquisition ever seen for this key. Never rewritten.
  started_at timestamptz NOT NULL DEFAULT now(),
  -- Legacy JS meaning: first acquisition. Carried across reclaims so the
  -- `meta` object handed back to callers keeps its historical shape.
  acquired_at timestamptz NOT NULL DEFAULT now(),
  -- Per-lease truth: rewritten on EVERY successful acquisition.
  lease_acquired_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL,
  released_at timestamptz,
  reason text,
  outcome text,
  last_error text,
  acquisition_count integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.run_locks IS
  'Durable coarse runner-level locks. Replaces /tmp runtime-state files so locks survive process restart and are shared across instances. Row-level send authority remains queue_atomic_claim_send_row; this table does NOT gate individual sends.';

COMMENT ON COLUMN public.run_locks.lease_until IS
  'Lease deadline. A row whose lease_until has passed is reclaimable by any instance; the reclaim rotates lease_token so the previous holder is fenced out of heartbeat and release.';

COMMENT ON COLUMN public.run_locks.acquired_at IS
  'LEGACY SHAPE: time of the first acquisition for this key, carried across reclaims to preserve the JS meta contract. For the current lease use lease_acquired_at.';

-- Reclaim scans: "which locks are expired but still marked locked?"
CREATE INDEX IF NOT EXISTS run_locks_status_lease_idx
  ON public.run_locks (status, lease_until);

-- ── run_lock_meta ───────────────────────────────────────────────────────────
-- Renders a row into the exact `meta` object the JS callers and existing test
-- fixtures already expect (note `scope` and `expires_at`, not the column names).
CREATE OR REPLACE FUNCTION public.run_lock_meta(p_row public.run_locks)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'version', 1,
    'scope', p_row.lock_key,
    'status', p_row.status,
    'lease_token', p_row.lease_token::text,
    'owner', p_row.owner,
    'lease_ms', p_row.lease_ms,
    'started_at', p_row.started_at,
    'acquired_at', p_row.acquired_at,
    'lease_acquired_at', p_row.lease_acquired_at,
    'last_heartbeat_at', p_row.last_heartbeat_at,
    'expires_at', p_row.lease_until,
    'released_at', p_row.released_at,
    'reason', p_row.reason,
    'outcome', p_row.outcome,
    'last_error', p_row.last_error,
    'acquisition_count', p_row.acquisition_count,
    'metadata', p_row.metadata
  );
$$;

-- ── run_lock_acquire ────────────────────────────────────────────────────────
-- Exactly-one-winner acquisition. Steals ONLY when the existing lease has
-- expired (or was explicitly released).
CREATE OR REPLACE FUNCTION public.run_lock_acquire(
  p_lock_key text,
  p_lease_token uuid,
  p_owner text DEFAULT NULL,
  p_lease_ms integer DEFAULT 600000,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_now timestamptz := now();
  v_lease_ms integer;
  v_token uuid;
  v_row public.run_locks%ROWTYPE;
  v_inserted_key text;
  v_attempt integer;
  v_reason text;
  v_meta jsonb;
BEGIN
  v_key := trim(COALESCE(p_lock_key, ''));
  IF v_key = '' THEN
    RETURN jsonb_build_object(
      'ok', false, 'acquired', false, 'reason', 'missing_run_lock_scope');
  END IF;

  -- Mirrors the JS clamp `Math.max(Number(lease_ms) || 0, 1)`, with an upper
  -- bound so a buggy caller cannot wedge a key forever.
  v_lease_ms := LEAST(GREATEST(COALESCE(p_lease_ms, 600000), 1), 86400000);
  v_token := COALESCE(p_lease_token, gen_random_uuid());

  -- Round 1 normally settles it. Round 2 only runs in the rare interleaving
  -- where the row is deleted between our conflict and our lock.
  FOR v_attempt IN 1..2 LOOP
    INSERT INTO public.run_locks (
      lock_key, lease_token, owner, status, lease_ms,
      started_at, acquired_at, lease_acquired_at, last_heartbeat_at,
      lease_until, released_at, reason, acquisition_count, metadata
    ) VALUES (
      v_key, v_token, NULLIF(trim(COALESCE(p_owner, '')), ''), 'locked', v_lease_ms,
      v_now, v_now, v_now, v_now,
      v_now + make_interval(secs => v_lease_ms / 1000.0), NULL, 'lock_acquired', 1,
      COALESCE(p_metadata, '{}'::jsonb)
    )
    ON CONFLICT (lock_key) DO NOTHING
    RETURNING lock_key INTO v_inserted_key;

    IF v_inserted_key IS NOT NULL THEN
      SELECT * INTO v_row FROM public.run_locks WHERE lock_key = v_key;
      RETURN jsonb_build_object(
        'ok', true, 'acquired', true, 'reason', 'lock_acquired',
        'scope', v_key, 'lease_token', v_token,
        'meta', public.run_lock_meta(v_row));
    END IF;

    -- Competing acquirers serialize here and stay serialized until commit.
    SELECT * INTO v_row FROM public.run_locks
     WHERE lock_key = v_key
     FOR UPDATE;

    IF FOUND THEN
      EXIT;
    END IF;
  END LOOP;

  IF v_row.lock_key IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'acquired', false, 'reason', 'run_lock_row_unstable');
  END IF;

  -- isLeaseActive(): status='locked' AND never released AND not yet expired.
  IF v_row.status = 'locked'
     AND v_row.released_at IS NULL
     AND v_row.lease_until > v_now THEN
    RETURN jsonb_build_object(
      'ok', true, 'acquired', false, 'reason', 'run_lock_active',
      'scope', v_key,
      'meta', public.run_lock_meta(v_row));
  END IF;

  -- Reclaimable. A row still marked 'locked' means the previous holder died or
  -- overran its lease; anything else is a clean re-acquisition.
  v_reason := CASE WHEN v_row.status = 'locked'
                   THEN 'stale_lock_reclaimed'
                   ELSE 'lock_acquired' END;

  UPDATE public.run_locks
     SET lease_token = v_token,
         owner = NULLIF(trim(COALESCE(p_owner, '')), ''),
         status = 'locked',
         lease_ms = v_lease_ms,
         -- acquired_at deliberately NOT rewritten (legacy meta shape).
         lease_acquired_at = v_now,
         last_heartbeat_at = v_now,
         lease_until = v_now + make_interval(secs => v_lease_ms / 1000.0),
         released_at = NULL,
         reason = v_reason,
         outcome = NULL,
         acquisition_count = v_row.acquisition_count + 1,
         metadata = COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE lock_key = v_key
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true, 'acquired', true, 'reason', v_reason,
    'scope', v_key, 'lease_token', v_token,
    'previous_status', 'reclaimed',
    'meta', public.run_lock_meta(v_row));
END;
$$;

-- ── run_lock_heartbeat ──────────────────────────────────────────────────────
-- Fenced lease extension. Only the current holder may extend, and an already
-- expired lease may NOT be extended (another instance may claim it at any
-- moment, so extending would resurrect a zombie).
CREATE OR REPLACE FUNCTION public.run_lock_heartbeat(
  p_lock_key text,
  p_lease_token uuid,
  p_lease_ms integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_now timestamptz := now();
  v_row public.run_locks%ROWTYPE;
  v_lease_ms integer;
BEGIN
  v_key := trim(COALESCE(p_lock_key, ''));
  IF v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'refreshed', false,
      'reason', 'missing_run_lock_scope');
  END IF;
  IF p_lease_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refreshed', false,
      'reason', 'run_lock_lease_token_required');
  END IF;

  SELECT * INTO v_row FROM public.run_locks
   WHERE lock_key = v_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'refreshed', false,
      'reason', 'run_lock_not_found', 'scope', v_key);
  END IF;

  IF v_row.lease_token <> p_lease_token THEN
    RETURN jsonb_build_object('ok', true, 'refreshed', false,
      'reason', 'run_lock_lease_token_mismatch', 'scope', v_key,
      'meta', public.run_lock_meta(v_row));
  END IF;

  IF v_row.status <> 'locked' OR v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'refreshed', false,
      'reason', 'run_lock_already_released', 'scope', v_key,
      'meta', public.run_lock_meta(v_row));
  END IF;

  IF v_row.lease_until <= v_now THEN
    RETURN jsonb_build_object('ok', true, 'refreshed', false,
      'reason', 'run_lock_lease_expired', 'scope', v_key,
      'meta', public.run_lock_meta(v_row));
  END IF;

  v_lease_ms := LEAST(GREATEST(COALESCE(p_lease_ms, v_row.lease_ms), 1), 86400000);

  UPDATE public.run_locks
     SET last_heartbeat_at = v_now,
         lease_ms = v_lease_ms,
         lease_until = v_now + make_interval(secs => v_lease_ms / 1000.0),
         updated_at = v_now
   WHERE lock_key = v_key
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'refreshed', true,
    'reason', 'run_lock_heartbeat', 'scope', v_key,
    'meta', public.run_lock_meta(v_row));
END;
$$;

-- ── run_lock_release ────────────────────────────────────────────────────────
-- Fenced release. A holder whose lease expired and was reclaimed by another
-- instance CANNOT release the new holder's lock.
CREATE OR REPLACE FUNCTION public.run_lock_release(
  p_lock_key text,
  p_lease_token uuid,
  p_outcome text DEFAULT 'completed',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_now timestamptz := now();
  v_row public.run_locks%ROWTYPE;
BEGIN
  v_key := trim(COALESCE(p_lock_key, ''));
  IF v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'released', false,
      'reason', 'missing_run_lock_record_item_id');
  END IF;
  IF p_lease_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'released', false,
      'reason', 'run_lock_lease_token_required', 'scope', v_key);
  END IF;

  SELECT * INTO v_row FROM public.run_locks
   WHERE lock_key = v_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'released', false,
      'reason', 'run_lock_not_found', 'scope', v_key);
  END IF;

  -- Preserved from the JS guard: releasing an already-released lock is a
  -- no-op success, not an error.
  IF v_row.status = 'released' AND v_row.lease_token = p_lease_token THEN
    RETURN jsonb_build_object('ok', true, 'released', true,
      'reason', 'already_released', 'scope', v_key);
  END IF;

  IF v_row.lease_token <> p_lease_token THEN
    RETURN jsonb_build_object('ok', true, 'released', false,
      'reason', 'run_lock_lease_token_mismatch', 'scope', v_key,
      'holder_lease_token', v_row.lease_token::text,
      'meta', public.run_lock_meta(v_row));
  END IF;

  UPDATE public.run_locks
     SET status = 'released',
         released_at = v_now,
         outcome = NULLIF(trim(COALESCE(p_outcome, '')), ''),
         last_error = NULLIF(trim(COALESCE(p_error, '')), ''),
         metadata = COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE lock_key = v_key
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'released', true,
    'reason', 'run_lock_released', 'scope', v_key,
    'outcome', v_row.outcome,
    'meta', public.run_lock_meta(v_row));
END;
$$;

-- ── run_lock_force_release ──────────────────────────────────────────────────
-- Operator escape hatch. Unconditional by design: this is what
-- /api/internal/runs/release-lock (and its /api/internal/run-locks/release
-- alias) already call, and it must work without knowing the lease token.
CREATE OR REPLACE FUNCTION public.run_lock_force_release(
  p_lock_key text,
  p_reason text DEFAULT 'force_released_stale'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_now timestamptz := now();
  v_row public.run_locks%ROWTYPE;
  v_was_active boolean;
BEGIN
  v_key := trim(COALESCE(p_lock_key, ''));
  IF v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'released', false,
      'reason', 'missing_run_lock_scope');
  END IF;

  SELECT * INTO v_row FROM public.run_locks
   WHERE lock_key = v_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'released', false,
      'reason', 'no_lock_record_found', 'scope', v_key);
  END IF;

  v_was_active := (v_row.status = 'locked'
                   AND v_row.released_at IS NULL
                   AND v_row.lease_until > v_now);

  UPDATE public.run_locks
     SET status = 'released',
         released_at = v_now,
         outcome = p_reason,
         last_error = 'Force-released: ' || p_reason,
         updated_at = v_now
   WHERE lock_key = v_key;

  RETURN jsonb_build_object('ok', true, 'released', true,
    'reason', p_reason, 'scope', v_key,
    'was_active', v_was_active,
    'previous_expires_at', v_row.lease_until,
    'previous_owner', v_row.owner,
    'previous_acquired_at', v_row.acquired_at);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. IDEMPOTENCY LEDGER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Consumers (all webhook entrypoints): TextGrid inbound, TextGrid delivery,
-- DocuSign, buyer response, title response, closing response.
--
-- The claim below is the ONLY thing standing between a provider retry and a
-- second execution of seller automation. It must be a single atomic database
-- act, which is why it is INSERT .. ON CONFLICT DO NOTHING and never
-- SELECT-then-INSERT.

CREATE TABLE IF NOT EXISTS public.idempotency_ledger (
  scope text NOT NULL,
  key text NOT NULL,
  claim_token uuid,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  summary text,
  payload_hash text,
  attempts integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  last_error text,
  skip_content_fields boolean NOT NULL DEFAULT false,
  -- Arbitrary caller metadata. Merged over the base fields when the JS `meta`
  -- object is rebuilt, reproducing the old `{...existing, ...metadata}` spread.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Retention deadline honoured by the existing daily
  -- /api/internal/inbound/ledger-retention-purge cron (30 days).
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

COMMENT ON TABLE public.idempotency_ledger IS
  'Durable mark-before-work event ledger. Replaces /tmp runtime-state files so a provider retry landing on a different instance (or after a restart) is recognised as a duplicate. The (scope, key) primary key is what makes the claim atomic.';

COMMENT ON COLUMN public.idempotency_ledger.started_at IS
  'Claim time. Staleness is now() - started_at > lease_ms, where lease_ms is supplied per call (default 600000 = 10 minutes, matching the prior JS default).';

-- Retention purge scan.
CREATE INDEX IF NOT EXISTS idempotency_ledger_retain_until_idx
  ON public.idempotency_ledger (retain_until);

-- Stale-claim scans.
CREATE INDEX IF NOT EXISTS idempotency_ledger_status_started_idx
  ON public.idempotency_ledger (status, started_at);

-- ── idempotency_meta ────────────────────────────────────────────────────────
-- Rebuilds the `meta` object in the shape the JS callers already receive:
-- caller metadata first, then the authoritative fixed fields on top (exactly
-- the precedence of the old `{...existing, ...metadata, scope, key, ...}`).
CREATE OR REPLACE FUNCTION public.idempotency_meta(p_row public.idempotency_ledger)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_row.metadata, '{}'::jsonb) || jsonb_build_object(
    'scope', p_row.scope,
    'key', p_row.key,
    'summary', p_row.summary,
    'status', p_row.status,
    'payload_hash', p_row.payload_hash,
    'attempts', p_row.attempts,
    'started_at', p_row.started_at,
    'completed_at', p_row.completed_at,
    'failed_at', p_row.failed_at,
    'last_error', p_row.last_error,
    'claim_token', p_row.claim_token::text
  );
$$;

-- ── idempotency_begin ───────────────────────────────────────────────────────
-- Mark-before-work atomic claim.
--
-- Outcomes (preserved verbatim from the JS implementation):
--   event_claimed                  — no prior row; caller MUST process.
--   stale_or_failed_event_reclaimed— prior row was failed, or was processing
--                                    with an expired lease; caller MUST process.
--   duplicate_event_ignored        — prior row completed; caller MUST NOT process.
--   event_already_processing       — another worker holds an unexpired claim;
--                                    caller MUST NOT process.
CREATE OR REPLACE FUNCTION public.idempotency_begin(
  p_scope text,
  p_key text,
  p_claim_token uuid,
  p_summary text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_lease_ms integer DEFAULT 600000,
  p_payload_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_scope text;
  v_key text;
  v_now timestamptz := now();
  v_lease_ms integer;
  v_token uuid;
  v_row public.idempotency_ledger%ROWTYPE;
  v_inserted_scope text;
  v_attempt integer;
  v_stale boolean;
BEGIN
  v_scope := trim(COALESCE(p_scope, ''));
  v_key := trim(COALESCE(p_key, ''));

  IF v_scope = '' OR v_key = '' THEN
    RETURN jsonb_build_object(
      'ok', false, 'duplicate', false,
      'reason', 'missing_idempotency_scope_or_key');
  END IF;

  v_lease_ms := LEAST(GREATEST(COALESCE(p_lease_ms, 600000), 1), 86400000);
  v_token := COALESCE(p_claim_token, gen_random_uuid());

  FOR v_attempt IN 1..2 LOOP
    INSERT INTO public.idempotency_ledger (
      scope, key, claim_token, status, summary, payload_hash,
      attempts, started_at, metadata
    ) VALUES (
      v_scope, v_key, v_token, 'processing',
      NULLIF(trim(COALESCE(p_summary, '')), ''),
      NULLIF(trim(COALESCE(p_payload_hash, '')), ''),
      1, v_now, COALESCE(p_metadata, '{}'::jsonb)
    )
    ON CONFLICT (scope, key) DO NOTHING
    RETURNING scope INTO v_inserted_scope;

    IF v_inserted_scope IS NOT NULL THEN
      SELECT * INTO v_row FROM public.idempotency_ledger
       WHERE scope = v_scope AND key = v_key;
      RETURN jsonb_build_object(
        'ok', true, 'duplicate', false, 'reason', 'event_claimed',
        'scope', v_scope, 'key', v_key, 'claim_token', v_token::text,
        'meta', public.idempotency_meta(v_row));
    END IF;

    -- Concurrent claimants serialize here until the winner commits.
    SELECT * INTO v_row FROM public.idempotency_ledger
     WHERE scope = v_scope AND key = v_key
     FOR UPDATE;

    IF FOUND THEN
      EXIT;
    END IF;
    -- Row purged between conflict and lock: retry the insert.
  END LOOP;

  IF v_row.key IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'duplicate', false, 'reason', 'idempotency_row_unstable');
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true, 'reason', 'duplicate_event_ignored',
      'scope', v_scope, 'key', v_key,
      'meta', public.idempotency_meta(v_row));
  END IF;

  -- isProcessingLeaseStale(): stale when started_at is unusable, or when
  -- now() - started_at exceeds the caller-supplied lease.
  v_stale := (v_row.started_at IS NULL)
             OR (v_now - v_row.started_at > make_interval(secs => v_lease_ms / 1000.0));

  IF v_row.status = 'processing' AND NOT v_stale THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true, 'reason', 'event_already_processing',
      'scope', v_scope, 'key', v_key,
      'meta', public.idempotency_meta(v_row));
  END IF;

  -- Reclaimable: failed, or processing past its lease. Rotating claim_token
  -- is what fences the previous holder out.
  UPDATE public.idempotency_ledger
     SET claim_token = v_token,
         status = 'processing',
         summary = NULLIF(trim(COALESCE(p_summary, '')), ''),
         payload_hash = COALESCE(
           NULLIF(trim(COALESCE(p_payload_hash, '')), ''), payload_hash),
         attempts = v_row.attempts + 1,
         started_at = v_now,
         completed_at = NULL,
         failed_at = NULL,
         last_error = NULL,
         metadata = COALESCE(v_row.metadata, '{}'::jsonb)
                    || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE scope = v_scope AND key = v_key
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'reason', 'stale_or_failed_event_reclaimed',
    'scope', v_scope, 'key', v_key, 'claim_token', v_token::text,
    'previous_status', 'reclaimed',
    'meta', public.idempotency_meta(v_row));
END;
$$;

-- ── idempotency_complete ────────────────────────────────────────────────────
-- NOT fenced on claim_token, deliberately: completeIdempotentProcessing never
-- received one, and adding a fence here would change public behaviour. The
-- reclaim path (idempotency_begin) is where double execution is actually
-- prevented.
CREATE OR REPLACE FUNCTION public.idempotency_complete(
  p_scope text,
  p_key text,
  p_summary text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_skip_content_fields boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_scope text;
  v_key text;
  v_now timestamptz := now();
  v_row public.idempotency_ledger%ROWTYPE;
BEGIN
  v_scope := trim(COALESCE(p_scope, ''));
  v_key := trim(COALESCE(p_key, ''));
  IF v_scope = '' OR v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_record_item_id');
  END IF;

  UPDATE public.idempotency_ledger
     SET status = 'completed',
         completed_at = v_now,
         summary = NULLIF(trim(COALESCE(p_summary, '')), ''),
         claim_token = NULL,
         skip_content_fields = COALESCE(p_skip_content_fields, false),
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE scope = v_scope AND key = v_key
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- The JS version wrote unconditionally, creating the row if absent.
    INSERT INTO public.idempotency_ledger (
      scope, key, status, summary, completed_at,
      skip_content_fields, metadata, started_at
    ) VALUES (
      v_scope, v_key, 'completed',
      NULLIF(trim(COALESCE(p_summary, '')), ''), v_now,
      COALESCE(p_skip_content_fields, false),
      COALESCE(p_metadata, '{}'::jsonb), v_now
    )
    ON CONFLICT (scope, key) DO UPDATE
      SET status = 'completed', completed_at = v_now, claim_token = NULL,
          updated_at = v_now
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'reason', 'idempotency_record_completed',
    'scope', v_scope, 'key', v_key,
    'meta', public.idempotency_meta(v_row));
END;
$$;

-- ── idempotency_fail ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idempotency_fail(
  p_scope text,
  p_key text,
  p_error text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_skip_content_fields boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_scope text;
  v_key text;
  v_now timestamptz := now();
  v_error text;
  v_row public.idempotency_ledger%ROWTYPE;
BEGIN
  v_scope := trim(COALESCE(p_scope, ''));
  v_key := trim(COALESCE(p_key, ''));
  IF v_scope = '' OR v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_record_item_id');
  END IF;

  v_error := COALESCE(NULLIF(trim(COALESCE(p_error, '')), ''), 'unknown_error');

  UPDATE public.idempotency_ledger
     SET status = 'failed',
         failed_at = v_now,
         last_error = v_error,
         claim_token = NULL,
         skip_content_fields = COALESCE(p_skip_content_fields, false),
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE scope = v_scope AND key = v_key
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    INSERT INTO public.idempotency_ledger (
      scope, key, status, failed_at, last_error,
      skip_content_fields, metadata, started_at
    ) VALUES (
      v_scope, v_key, 'failed', v_now, v_error,
      COALESCE(p_skip_content_fields, false),
      COALESCE(p_metadata, '{}'::jsonb), v_now
    )
    ON CONFLICT (scope, key) DO UPDATE
      SET status = 'failed', failed_at = v_now, last_error = v_error,
          claim_token = NULL, updated_at = v_now
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'reason', 'idempotency_record_failed',
    'scope', v_scope, 'key', v_key,
    'error_message', v_error,
    'meta', public.idempotency_meta(v_row));
END;
$$;

-- ── idempotency_purge_expired ───────────────────────────────────────────────
-- Retention. Only terminal rows are ever purged: an in-flight claim is never
-- deleted out from under its holder.
CREATE OR REPLACE FUNCTION public.idempotency_purge_expired(
  p_limit integer DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT scope, key
      FROM public.idempotency_ledger
     WHERE retain_until <= now()
       AND status IN ('completed', 'failed')
     ORDER BY retain_until
     LIMIT GREATEST(COALESCE(p_limit, 5000), 1)
  )
  DELETE FROM public.idempotency_ledger l
   USING doomed d
   WHERE l.scope = d.scope AND l.key = d.key;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'deleted_count', v_deleted);
END;
$$;

-- ── run_lock_purge_expired ──────────────────────────────────────────────────
-- Housekeeping only. Released locks older than 7 days carry no authority.
CREATE OR REPLACE FUNCTION public.run_lock_purge_expired(
  p_limit integer DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT lock_key
      FROM public.run_locks
     WHERE status = 'released'
       AND released_at IS NOT NULL
       AND released_at < now() - interval '7 days'
     ORDER BY released_at
     LIMIT GREATEST(COALESCE(p_limit, 5000), 1)
  )
  DELETE FROM public.run_locks l
   USING doomed d
   WHERE l.lock_key = d.lock_key;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'deleted_count', v_deleted);
END;
$$;
