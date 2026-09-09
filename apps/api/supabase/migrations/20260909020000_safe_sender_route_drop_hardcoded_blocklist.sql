-- Remove the HARDCODED sender blocklist from resolve_campaign_safe_sender_route.
--
-- WHY
-- The function (20260606041905) seeds blocked_values with two literal numbers
-- (Atlanta ••0588, Dallas ••1600) and UNIONs system_control.sms_blocked_sender_numbers.
-- The JS twin (sms-health-guard.js DEFAULT_BLOCKED_SENDER_NUMBERS) carried the same
-- two literals. Both entered via ff571386, an explicitly unreviewed "WIP integration
-- checkpoint" whose own doc called them "emergency defaults ... to be moved into
-- managed system-control values once stable". Provenance review 2026-09-09 found the
-- trigger was a fleet-wide, time-boxed carrier spam wave (2026-05-25..06-07) that had
-- ended before the block reached production; both numbers recovered to fleet baseline
-- and are the ONLY registry senders for their markets. The durable authorities are the
-- sender registry (textgrid_numbers.status) and the operator-managed
-- system_control.sms_blocked_sender_numbers list -- which this function KEEPS.
--
-- HOW
-- Rewrite by substitution from pg_get_functiondef() so no other line can drift;
-- refuse to patch a body that is not the one this migration was written against;
-- assert the system_control UNION survives; idempotent if already applied.

DO $migration$
DECLARE
  v_def      text;
  v_new_def  text;
  v_old constant text :=
'      VALUES
        (''+14704920588''::text),
        (''+14693131600''::text)
    ) AS blocked(phone_number)';
  v_new constant text :=
'      -- No hardcoded numbers: blocks are operator-managed
      -- (system_control.sms_blocked_sender_numbers) and registry status.
      SELECT NULL::text WHERE false
    ) AS blocked(phone_number)';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_campaign_safe_sender_route';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'resolve_campaign_safe_sender_route not found';
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    IF position('SELECT NULL::text WHERE false' IN v_def) > 0 THEN
      RAISE NOTICE 'already applied; nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'expected hardcoded blocklist not found; refusing to patch';
  END IF;

  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one hardcoded blocklist occurrence';
  END IF;

  v_new_def := replace(v_def, v_old, v_new);

  -- The operator-managed list must survive the rewrite.
  IF position('sms_blocked_sender_numbers' IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'system_control blocklist UNION missing after rewrite; aborting';
  END IF;
  -- And no literal may remain.
  IF position('14704920588' IN v_new_def) > 0 OR position('14693131600' IN v_new_def) > 0 THEN
    RAISE EXCEPTION 'hardcoded number still present after rewrite; aborting';
  END IF;

  EXECUTE v_new_def;
END
$migration$;
