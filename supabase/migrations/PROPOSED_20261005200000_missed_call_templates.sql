-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING BEFORE APPLY.
--
-- Missed-call auto-text copy (use_case = 'missed_call'), English + Spanish,
-- persona "Alex". Owner rule 2026-10-01: every message we send is a row in
-- sms_templates so KPIs join on send_queue.template_id.
--
-- SAFE TO APPLY EARLY: every row is inserted INACTIVE (is_active = false), and
-- the system_control switch is inserted 'false'. The missed-call code selects
-- ONLY active rows, so nothing can be sent from this migration alone. After the
-- owner picks the wording, activate the chosen variant(s):
--
--   update public.sms_templates set is_active = true, updated_at = now()
--    where use_case = 'missed_call' and template_id in ('lc-missed-call-en-1','lc-missed-call-es-1');
--
-- COPY RULES the drafts follow:
--   * <= 160 GSM-7 chars for English (1 segment); Spanish is UCS-2 (accents), 2 segments.
--   * Never "Hey," / "Hi," / "Hola," with a comma: the dispatcher's blank-greeting
--     guard (process-send-queue.js BLANK_GREETING_*_RE) pauses those bodies.
--   * {{agent_name}} renders from agent_persona ('Alex'). No other placeholder:
--     the caller is often unknown, so the copy addresses nobody by name.
--   * Nothing false about who we are. Variant 1 carries the owner's "in a
--     meeting" line (OWNER DECISION: it is only true when it is true);
--     variant 2 is the neutral alternative with no claim about why we missed it.
--   * safe_for_auto_reply = false keeps these rows out of every OTHER auto-reply
--     pool; the missed-call module selects by use_case explicitly.
--
-- Idempotent: inserts only template_ids that do not exist yet (sms_templates
-- has no unique constraint on template_id, so ON CONFLICT cannot be used).

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, stage_code, stage_label,
  is_first_touch, is_follow_up, fallback_rank, variant_group_key, quarantine_state, metadata
)
select v.use_case, v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation, '{"agent_name": "persona"}'::jsonb, false, false, 'auto',
       'neutral', 'Any Residential', null, 'Missed Call',
       false, false, v.fallback_rank, 'missed_call|' || v.language, 'active',
       jsonb_build_object(
         'authored_by', 'missed_call_autotext_2026_10_05',
         'approval_status', 'proposed_pending_owner_approval',
         'variant', v.variant,
         'channel_trigger', 'inbound_voice_no_answer'
       )
from (values
  ('missed_call', 'lc-missed-call-en-1', 'Missed call — meeting (EN)', 'English', 1, 'meeting',
   'Hey it''s {{agent_name}}. Sorry I missed your call, I''m tied up in a meeting. Can you text me what''s on your mind? I''ll call you back as soon as I''m out.',
   null),
  ('missed_call', 'lc-missed-call-en-2', 'Missed call — neutral (EN)', 'English', 2, 'neutral',
   'Sorry I missed your call, this is {{agent_name}}. Feel free to text me here what''s on your mind and I''ll get back to you shortly.',
   null),
  ('missed_call', 'lc-missed-call-es-1', 'Missed call — meeting (ES)', 'Spanish', 1, 'meeting',
   'Hola soy {{agent_name}}, perdón que no contesté su llamada. Estoy en una reunión. ¿Me escribe aquí qué necesita? Le llamo al salir.',
   'Hi it''s {{agent_name}}, sorry I didn''t answer your call. I''m in a meeting. Can you text me here what you need? I''ll call you when I''m out.'),
  ('missed_call', 'lc-missed-call-es-2', 'Missed call — neutral (ES)', 'Spanish', 2, 'neutral',
   'Perdón que no contesté su llamada, soy {{agent_name}}. Escríbame aquí qué necesita y le respondo pronto.',
   'Sorry I didn''t answer your call, this is {{agent_name}}. Text me here what you need and I''ll get back to you soon.')
) as v(use_case, template_id, template_name, language, fallback_rank, variant, template_body, english_translation)
where not exists (
  select 1 from public.sms_templates t where t.template_id = v.template_id
);

-- Operator switch, default OFF. Absent and 'false' are both off.
insert into public.system_control (key, value, updated_at)
values ('missed_call_autotext_enabled', 'false', now())
on conflict (key) do nothing;

commit;

-- POSTCHECK (read-only):
--   select template_id, language, is_active, length(template_body) from public.sms_templates
--    where use_case = 'missed_call' order by template_id;          -- expect 4 rows, all inactive
--   select value from public.system_control where key = 'missed_call_autotext_enabled'; -- 'false'
