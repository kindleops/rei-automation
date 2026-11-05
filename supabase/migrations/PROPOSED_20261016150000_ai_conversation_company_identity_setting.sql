-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.21 part A (Phase 4) — the CONFIGURED COMPANY IDENTITY the AI conversation
-- writer may state (apps/api/src/lib/domain/conversation-ai/company-identity.js).
--
--   system_control['ai_conversation_company_identity'] = ''   (EMPTY = "do not mention company
--   details": the AI names no company, gives no website, never says it is or is not with a
--   company, and a seller who asks which company this is goes to a person)
--
-- The owner sets approved values later, by hand, as JSON:
--   {"name": "<approved company name>", "website": "https://…", "website_verified": true}
-- A website is used only with website_verified = true. Absent key ≡ empty value (the code fails
-- closed to "not configured" either way); this row only makes the setting visible.
-- Idempotent: ON CONFLICT DO NOTHING never overwrites an owner-set value.
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql
-- Rollback: PROPOSED_20261016150000_ai_conversation_company_identity_setting_rollback.sql
-- Test: DISPOSABLE DATABASE ONLY —
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ai_conversation_company_identity_setting
-- ════════════════════════════════════════════════════════════════════════════
insert into public.system_control (key, value)
values ('ai_conversation_company_identity', '')
on conflict (key) do nothing;
