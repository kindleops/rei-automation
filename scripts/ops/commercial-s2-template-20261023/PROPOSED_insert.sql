-- ─── PROPOSED_insert.sql ────────────────────────────────────────────────────────────────────
-- PROPOSED DATA STEP. NOT EXECUTED. NOT A CODE CHANGE. It inserts ONE sms_templates row with
-- is_active = FALSE. Activation is a separate file (PROPOSED_activate.sql) and a separate
-- authorization. The owner approved the wording. The owner did NOT approve activation.
--
-- Owner-approved wording (2026-10-23), verbatim:
--   "Hi {{first_name}}, this is {{sender_name}} with {{company_name}}. Would you consider selling
--    your property at {{property_address}}? Reply STOP to opt out."
--
-- PLACEHOLDER MAPPING to the renderer's real variables. Auto-replies render through
-- apps/api/src/lib/sms/personalize_template.js (KNOWN_PLACEHOLDERS). An unknown token fails closed,
-- so nothing is sent:
--   {{first_name}}       -> {{seller_first_name}}  personalize_template.js has NO "first_name" key.
--                                                  Left as written, every render fails with
--                                                  missing_placeholder_values: first_name.
--   {{sender_name}}      -> {{sender_name}}        verified alias. personalize_template.js maps it to
--                                                  the thread persona's first name, the same value as
--                                                  {{agent_name}}. The feeder and render-template.js
--                                                  support it too.
--   {{company_name}}     -> NONE. NO VERIFIED COMPANY PLACEHOLDER EXISTS. No SMS renderer
--                                                  (personalize_template.js, supabase-candidate-
--                                                  feeder.js, templates/render-template.js) has a
--                                                  company / brand key, and outbound-agent-identity.js
--                                                  forbids a company-name fallback by design.
--                                                  This file therefore REFUSES (RAISE) unless the
--                                                  owner types the approved company text into
--                                                  v_company_literal below. Nothing is guessed.
--   {{property_address}} -> {{property_address}}   verified.
--
-- Row attributes:
--   use_case consider_selling | stage_code S2 | language English | reply_mode auto_reply
--   property_type_scope 'Commercial (Other)'. The asset rule (template-asset-compatibility.js
--   templateScopeKind -> 'commercial') admits exactly COMMERCIAL_GROUPS: self_storage, retail,
--   office, industrial, hotel_motel, mobile_home_park, other_commercial. allowed_property_groups =
--   those 7. prohibited_property_groups = the 6 residential groups + land. This follows the same
--   convention as the approved commercial S4 rows (PROPOSED_20261010121000_s3_s4_natural_templates.sql).
--   safe_for_auto_reply: COPIED from the active English S2 consider_selling auto-reply rows. The
--   file refuses unless they agree on one value. identity_contact_mode / stage_label: the most
--   common value in that family (reported by NOTICE).
--   success_rate / usage_count are never written (no fabricated metrics).
--
-- STOP / 10DLC: on 2026-08-17 the owner removed "Reply STOP to opt out" from all 136 templates of
-- the time, so today's S1 / S2 rows normally carry NO STOP line (preflight P5 shows the current
-- count). The owner's approved wording for this row DOES carry one, so it is kept verbatim. That is
-- not a conflict: the carrier honors STOP whatever the copy says, and the inbound classifier
-- treats STOP as absolute. Brand identification ("with <company>") is the owner's choice. The
-- numbers sit on 10DLC campaign CHM4NL2. Owner records name the brand as Everline Asset Group LLC.
-- The author did NOT verify that against the registry, so it is not filled in here.
-- No familiarity is claimed: the body introduces the sender and asks one S2 question.
--
-- Idempotent: if a row with this template_id and this exact body already exists, it does nothing.
-- Any other row with this template_id makes it refuse (template_id has no unique index).
-- Run order: preflight_READONLY.sql -> this file -> (later, separately) PROPOSED_activate.sql.
-- Rollback: rollback.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $insert$
DECLARE
  -- ── OWNER INPUT ─────────────────────────────────────────────────────────────────────────
  -- The approved company / brand text for "with {{company_name}}", e.g. the registered 10DLC
  -- brand. NULL (the default) means there is no verified company value, so the file refuses.
  v_company_literal text := NULL;
  -- ────────────────────────────────────────────────────────────────────────────────────────
  c_template_id   constant text := 'lc-s2-consider-com-en-01';
  c_owner_wording constant text := 'Hi {{first_name}}, this is {{sender_name}} with {{company_name}}. Would you consider selling your property at {{property_address}}? Reply STOP to opt out.';
  c_allowed       constant text[] := ARRAY['self_storage','retail','office','industrial','hotel_motel','mobile_home_park','other_commercial'];
  c_prohibited    constant text[] := ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus','land'];
  c_known_tokens  constant text[] := ARRAY['seller_first_name','sender_name','property_address'];
  v_body          text;
  v_tokens        text[];
  v_cols          int;
  v_safe_values   boolean[];
  v_family_n      int;
  v_identity_mode text;
  v_stage_label   text;
  v_existing      int;
  v_same          int;
BEGIN
  -- 1. Company placeholder: no verified renderer variable exists, so the owner must supply the text.
  IF v_company_literal IS NULL OR btrim(v_company_literal) = '' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'commercial_s2_template: REFUSED: {{company_name}} has no verified renderer variable',
      DETAIL  = 'personalize_template.js / supabase-candidate-feeder.js / render-template.js have no company or brand key; an unknown token fails every render closed. Nothing was written.',
      HINT    = 'Owner: set v_company_literal to the approved company text (e.g. the registered 10DLC brand) and re-run, or approve a renderer change that adds a verified company variable.';
  END IF;
  v_company_literal := btrim(v_company_literal);
  IF v_company_literal ~ '[{}\r\n]' OR v_company_literal ~ '[–—]' OR length(v_company_literal) > 40 THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: v_company_literal must be plain text, 1-40 chars, no braces / newlines / em or en dashes (got %)', v_company_literal;
  END IF;

  -- 2. The body: the owner's wording with only the placeholder mapping applied.
  v_body := replace(replace(c_owner_wording, '{{first_name}}', '{{seller_first_name}}'), '{{company_name}}', v_company_literal);
  SELECT array_agg(DISTINCT m[1]) INTO v_tokens FROM regexp_matches(v_body, '\{\{\s*([a-zA-Z0-9_]+)\s*\}\}', 'g') AS m;
  IF NOT (v_tokens <@ c_known_tokens) THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: body uses tokens % outside the verified set %', v_tokens, c_known_tokens;
  END IF;
  IF v_body ~ '[–—]' THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: em / en dash in the body';
  END IF;

  -- 3. Schema: every column written exists.
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sms_templates'
     AND column_name IN ('template_id','template_name','use_case','language','template_body','english_translation',
                         'variables','is_active','safe_for_auto_reply','reply_mode','identity_contact_mode',
                         'property_type_scope','allowed_property_groups','prohibited_property_groups','stage_code',
                         'stage_label','is_first_touch','is_follow_up','minimal_fallback','quarantine_state','metadata');
  IF v_cols <> 21 THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: sms_templates is missing % of the 21 columns this file writes', 21 - v_cols;
  END IF;

  -- 4. Idempotency / template_id clash.
  SELECT count(*), count(*) FILTER (WHERE template_body = v_body AND lower(use_case) = 'consider_selling'
                                      AND stage_code = 'S2' AND language = 'English'
                                      AND property_type_scope = 'Commercial (Other)')
    INTO v_existing, v_same
    FROM public.sms_templates WHERE template_id = c_template_id;
  IF v_existing = 1 AND v_same = 1 THEN
    RAISE NOTICE 'commercial_s2_template: % already present with this body; nothing to do', c_template_id;
    RETURN;
  ELSIF v_existing > 0 THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: % row(s) with template_id % exist and differ; review before re-running', v_existing, c_template_id;
  END IF;

  -- 5. The S2 family this row joins: copy safe_for_auto_reply (must be unanimous).
  SELECT count(*), array_agg(DISTINCT safe_for_auto_reply),
         mode() WITHIN GROUP (ORDER BY identity_contact_mode),
         mode() WITHIN GROUP (ORDER BY stage_label)
    INTO v_family_n, v_safe_values, v_identity_mode, v_stage_label
    FROM public.sms_templates
   WHERE lower(use_case) = 'consider_selling' AND language = 'English' AND stage_code = 'S2'
     AND is_active
     AND (reply_mode IS NULL OR lower(reply_mode) IN ('', 'auto', 'auto_reply'));
  IF v_family_n = 0 THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: no active English S2 consider_selling auto-reply row to copy attributes from';
  END IF;
  IF array_length(v_safe_values, 1) <> 1 OR v_safe_values[1] IS NULL THEN
    RAISE EXCEPTION 'commercial_s2_template: REFUSED: the S2 family disagrees on safe_for_auto_reply (%); owner decides', v_safe_values;
  END IF;
  RAISE NOTICE 'commercial_s2_template: copying from % S2 rows: safe_for_auto_reply=%, identity_contact_mode=%, stage_label=%',
    v_family_n, v_safe_values[1], v_identity_mode, v_stage_label;
  IF length(v_body) > 160 THEN
    RAISE NOTICE 'commercial_s2_template: body is % chars (more than one GSM-7 segment)', length(v_body);
  END IF;

  -- 6. Insert, INACTIVE.
  INSERT INTO public.sms_templates (
    template_id, template_name, use_case, language, template_body, english_translation, variables,
    is_active, safe_for_auto_reply, reply_mode, identity_contact_mode,
    property_type_scope, allowed_property_groups, prohibited_property_groups,
    stage_code, stage_label, is_first_touch, is_follow_up, minimal_fallback, quarantine_state, metadata
  ) VALUES (
    c_template_id,
    'consider_selling - English (Stage 2, Commercial)',
    'consider_selling', 'English', v_body, NULL, '{}'::jsonb,
    false, v_safe_values[1], 'auto_reply', v_identity_mode,
    'Commercial (Other)', c_allowed, c_prohibited,
    'S2', v_stage_label, false, false, false, 'active',
    jsonb_build_object(
      'authored_by', 'commercial_s2_template_20261023',
      'approval_status', 'wording_owner_approved_2026_10_23_activation_not_approved',
      'owner_wording', c_owner_wording,
      'placeholder_map', jsonb_build_object(
        'first_name', 'seller_first_name',
        'sender_name', 'sender_name',
        'company_name', 'owner_supplied_literal',
        'property_address', 'property_address'),
      'company_literal', v_company_literal,
      'asset_scope', 'commercial',
      'fires', 'Commercial owner confirms ownership at S1 -> S2 interest question (binding stage flow).',
      'requires_build', 'hotfix/template-scope-prod (see DEPLOY.md); activation is PROPOSED_activate.sql'
    )
  );
  RAISE NOTICE 'commercial_s2_template: inserted % (is_active = false)', c_template_id;
END
$insert$;

COMMIT;

-- POSTCHECK (read-only):
--   SELECT template_id, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups,
--          prohibited_property_groups, stage_code, stage_label, template_body
--     FROM public.sms_templates WHERE template_id = 'lc-s2-consider-com-en-01';
