-- Migration: Add auto-reply routing fields to sms_templates
-- These columns allow the template selector to enforce:
--   - safe_for_auto_reply: explicit opt-in before a template is live-auto-replied
--   - reply_mode: 'auto_reply' | 'manual' | 'system_only' | 'review_only'
--   - allowed_property_groups / prohibited_property_groups: property compatibility
--   - property_phrase_type: guards against wrong property type in message body
--
-- SAFE: all columns are nullable / have defaults — no existing rows broken.

ALTER TABLE sms_templates
  ADD COLUMN IF NOT EXISTS safe_for_auto_reply    BOOLEAN   DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reply_mode             TEXT      DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS allowed_property_groups TEXT[]   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prohibited_property_groups TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS property_phrase_type   TEXT      DEFAULT NULL;

-- Index for the auto-reply selector hot path:
--   WHERE is_active = true AND use_case = ? AND language IN (?, 'English')
--   AND safe_for_auto_reply = true
CREATE INDEX IF NOT EXISTS idx_sms_templates_auto_reply
  ON sms_templates (use_case, language, is_active, safe_for_auto_reply)
  WHERE is_active = true AND safe_for_auto_reply = true;

-- Audit comment
COMMENT ON COLUMN sms_templates.safe_for_auto_reply IS
  'Explicit opt-in. Only templates with safe_for_auto_reply = TRUE are eligible for live auto-reply. Defaults false — must be manually reviewed and approved.';

COMMENT ON COLUMN sms_templates.reply_mode IS
  'Routing hint: auto_reply | manual | system_only | review_only';

COMMENT ON COLUMN sms_templates.allowed_property_groups IS
  'If set, template is only eligible for these property groups (e.g. {residential, sfr}). NULL = unrestricted.';

COMMENT ON COLUMN sms_templates.prohibited_property_groups IS
  'If set, template must not be used for these property groups. NULL = unrestricted.';

COMMENT ON COLUMN sms_templates.property_phrase_type IS
  'Guards against property-type mismatch in message body (e.g. duplex, house, multifamily).';
