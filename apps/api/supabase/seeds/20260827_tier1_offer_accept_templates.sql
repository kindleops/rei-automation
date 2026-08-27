-- Tier 1 template closure: accept_terms / initial_offer / final_offer (EN + ES)
-- Adds the three auto-reply-safe templates the negotiation router already emits
-- (INITIAL_OFFER, FINAL_AUTHORIZED_OFFER, ACCEPT_SELLER_TERMS) but the catalog
-- lacked, so those strategies no longer fail closed to human review.
--
-- Offer generation stays fully autonomous: {{offer_price}} is filled from
-- persisted ADE/negotiation authority (no manual approval). accept_terms
-- intentionally omits {{offer_price}} so the acceptance confirmation can never
-- fail closed on a missing amount; it binds to the property + the terms_accepted
-- negotiation state and continues the existing autonomous closing path.
--
-- SMS style rule: zero em dashes (guarded permanently by the send-path sanitizer
-- and tests/critical/no-em-dash-sms.test.mjs).
--
-- Idempotent: keyed on template_id.

insert into sms_templates
  (id, template_id, use_case, stage_code, stage_label, language, is_active, safe_for_auto_reply, property_type_scope, identity_contact_mode, template_body)
select gen_random_uuid(), v.template_id, v.use_case, v.stage_code, v.stage_label, v.language, true, true, 'Any Residential', 'neutral', v.template_body
from (values
  ('lc-initial-offer-en-1', 'initial_offer', 'S5',  'Offer',          'English',
   'Based on what I know about {{property_address}}, I could do {{offer_price}} as-is, closing on your timeline. Would that work for you?'),
  ('lc-initial-offer-es-1', 'initial_offer', 'S5',  'Offer',          'Spanish',
   'Según lo que sé de {{property_address}}, podría ofrecer {{offer_price}} en su estado actual, cerrando cuando a usted le convenga. ¿Le funcionaría?'),
  ('lc-final-offer-en-1',   'final_offer',   'S5F', 'Final Offer',    'English',
   'I want to be straight with you. The strongest I can do on {{property_address}} is {{offer_price}} as-is, closing on your timeline. Does that work?'),
  ('lc-final-offer-es-1',   'final_offer',   'S5F', 'Final Offer',    'Spanish',
   'Quiero ser directo con usted. Lo máximo que puedo ofrecer por {{property_address}} es {{offer_price}} en su estado actual, cerrando cuando usted quiera. ¿Le funciona?'),
  ('lc-accept-terms-en-1',  'accept_terms',  'S6',  'Terms Accepted', 'English',
   'That is great to hear. Let''s move forward on {{property_address}}. I will get a simple one page agreement ready. What is the best full name and email to send it to?'),
  ('lc-accept-terms-es-1',  'accept_terms',  'S6',  'Terms Accepted', 'Spanish',
   'Me alegra mucho escuchar eso. Avancemos con {{property_address}}. Prepararé un acuerdo sencillo de una página. ¿Cuál es el mejor nombre completo y correo electrónico para enviárselo?')
) as v(template_id, use_case, stage_code, stage_label, language, template_body)
where not exists (
  select 1 from sms_templates t where t.template_id = v.template_id
);
