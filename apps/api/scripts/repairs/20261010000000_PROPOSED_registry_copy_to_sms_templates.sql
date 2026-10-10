-- PROPOSED — NOT APPLIED. Owner approval required before any row is activated.
-- hotfix-8.5.4-s3 (P0 2026-10-09): "We never use a hard-coded template. Ever.
-- All templates must be in Supabase."
--
-- Every row below is copy that automation USED TO send from the code registry
-- (apps/api/src/lib/domain/templates/local-template-registry.js), now refused at
-- selection and at the final send guard (template_not_in_supabase), plus the
-- commercial S3 asking-price question (no asset-compatible approved S3 row exists
-- for retail / commercial today; scope of occ_seller_asking_price_* NOT widened).
--
-- Rows are inserted INACTIVE and NOT safe_for_auto_reply. Each insert is skipped
-- when an ACTIVE row for the same use_case + language already exists (the
-- registry copy is only needed where the catalogue has a gap). Wording is the
-- registry wording VERBATIM (some lines contain a long dash, which the SMS copy
-- rules forbid — edit before approving).
--
-- To approve a row: UPDATE sms_templates SET is_active = true, safe_for_auto_reply = true
--   WHERE template_id = '<id>';  (owner only)
BEGIN;

-- seller_asking_price / English / S3  (from owner wording 2026-10-09 (S3 asking price, commercial assets))
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-seller-asking-price-commercial-en-v1', 'seller_asking_price', 'English', 'S3', 'Got it. Do you have an asking price in mind for the property?', false, false, 'auto_reply', 'Commercial (Other)', ARRAY['self_storage','retail','office','industrial','hotel_motel','mobile_home_park','other_commercial']::text[], 'PROPOSED seller_asking_price (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'owner wording 2026-10-09 (S3 asking price, commercial assets)')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-seller-asking-price-commercial-en-v1')
  AND true;

-- seller_asking_price / Spanish / S3  (from owner wording 2026-10-09 (S3 asking price, commercial assets) — Spanish needs native review)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-seller-asking-price-commercial-es-v1', 'seller_asking_price', 'Spanish', 'S3', 'Entendido. ¿Tiene un precio en mente para la propiedad?', false, false, 'auto_reply', 'Commercial (Other)', ARRAY['self_storage','retail','office','industrial','hotel_motel','mobile_home_park','other_commercial']::text[], 'PROPOSED seller_asking_price (Spanish)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'owner wording 2026-10-09 (S3 asking price, commercial assets) — Spanish needs native review')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-seller-asking-price-commercial-es-v1')
  AND true;

-- novation_probe / English / S5  (from local-template:novation_probe:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-novation_probe-v1', 'novation_probe', 'English', 'S5', 'If a straight cash number is the gap on {{property_address}}, would you be open to a novation-style option if it could net you more?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED novation_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:novation_probe:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-novation_probe-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'novation_probe' AND t.language = 'English' AND t.is_active);

-- novation_probe / English / S5  (from local-template:novation_probe:v2)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-novation_probe-v2', 'novation_probe', 'English', 'S5', 'If retail price is what matters most on {{property_address}}, would you want to hear a novation route that may improve your net?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED novation_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:novation_probe:v2')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-novation_probe-v2')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'novation_probe' AND t.language = 'English' AND t.is_active);

-- condition_probe / English / S4  (from local-template:condition_probe:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-condition_probe-v1', 'condition_probe', 'English', 'S4', 'Thanks for the details on {{property_address}}. How would you describe the overall condition — move-in ready, needs some updating, or bigger repairs?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED condition_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:condition_probe:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-condition_probe-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'condition_probe' AND t.language = 'English' AND t.is_active);

-- condition_probe / English / S4  (from local-template:condition_probe:v2)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-condition_probe-v2', 'condition_probe', 'English', 'S4', 'Got it. Anything on {{property_address}} that would need attention — roof, HVAC, plumbing, or is it in solid shape?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED condition_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:condition_probe:v2')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-condition_probe-v2')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'condition_probe' AND t.language = 'English' AND t.is_active);

-- occupancy_probe / English / S4  (from local-template:occupancy_probe:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-occupancy_probe-v1', 'occupancy_probe', 'English', 'S4', 'Is {{property_address}} currently vacant, owner-occupied, or rented out?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED occupancy_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:occupancy_probe:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-occupancy_probe-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'occupancy_probe' AND t.language = 'English' AND t.is_active);

-- repair_clarification / English / S4  (from local-template:repair_clarification:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-repair_clarification-v1', 'repair_clarification', 'English', 'S4', 'Appreciate that. On the repairs you mentioned for {{property_address}} — roughly how extensive are they? Even a ballpark helps me be accurate.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED repair_clarification (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:repair_clarification:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-repair_clarification-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'repair_clarification' AND t.language = 'English' AND t.is_active);

-- flexibility_probe / English / S5  (from local-template:flexibility_probe:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-flexibility_probe-v1', 'flexibility_probe', 'English', 'S5', 'Understood on the number for {{property_address}}. If we handled everything as-is with no repairs on your end and covered the customary closing costs, is there any flexibility there?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED flexibility_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:flexibility_probe:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-flexibility_probe-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'flexibility_probe' AND t.language = 'English' AND t.is_active);

-- best_price_request / English / S5  (from local-template:best_price_request:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-best_price_request-v1', 'best_price_request', 'English', 'S5', 'I want to make sure I''m working with your real number on {{property_address}} — what''s the best price you''d be comfortable with if we kept everything simple and as-is?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED best_price_request (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:best_price_request:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-best_price_request-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'best_price_request' AND t.language = 'English' AND t.is_active);

-- expectation_reset / English / S5  (from local-template:expectation_reset:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-expectation_reset-v1', 'expectation_reset', 'English', 'S5', 'I hear you on {{property_address}}. To be straight with you, that number is above where we could responsibly land as a direct purchase with no repairs or fees on your side. If anything changes on price or timing, I''d still like to make this work.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED expectation_reset (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:expectation_reset:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-expectation_reset-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'expectation_reset' AND t.language = 'English' AND t.is_active);

-- comp_anchor / English / S5  (from local-template:comp_anchor:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-comp_anchor-v1', 'comp_anchor', 'English', 'S5', 'For context on {{property_address}}: {{comp_anchor_statement}} That''s a big part of how I have to look at the numbers. Does that change anything on your end?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED comp_anchor (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:comp_anchor:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-comp_anchor-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'comp_anchor' AND t.language = 'English' AND t.is_active);

-- repair_anchor / English / S5  (from local-template:repair_anchor:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-repair_anchor-v1', 'repair_anchor', 'English', 'S5', 'Factoring in the work {{property_address}} needs, I have to budget the repairs before resale. That''s what drives my number — I''m not discounting it arbitrarily.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED repair_anchor (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:repair_anchor:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-repair_anchor-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'repair_anchor' AND t.language = 'English' AND t.is_active);

-- initial_offer / English / S5  (from local-template:initial_offer:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-initial_offer-v1', 'initial_offer', 'English', 'S5', 'Based on everything you''ve shared about {{property_address}}, I can purchase it directly, as-is, for {{offer_price}} — no repairs on your end, and we handle the customary closing costs. Would that work for you?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED initial_offer (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:initial_offer:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-initial_offer-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'initial_offer' AND t.language = 'English' AND t.is_active);

-- conditional_offer / English / S5  (from local-template:conditional_offer:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-conditional_offer-v1', 'conditional_offer', 'English', 'S5', 'Here''s where I can be on {{property_address}}: {{offer_price}}, buying directly and as-is, with no repairs needed before closing. If the condition checks out the way you described, I can stand on that number.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED conditional_offer (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:conditional_offer:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-conditional_offer-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'conditional_offer' AND t.language = 'English' AND t.is_active);

-- counter_offer / English / S5  (from local-template:counter_offer:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-counter_offer-v1', 'counter_offer', 'English', 'S5', 'I appreciate you working with me on {{property_address}}. I can come up to {{offer_price}} — as-is, no repairs on your side, and we work around your preferred timing. Can we make that work?', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED counter_offer (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:counter_offer:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-counter_offer-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'counter_offer' AND t.language = 'English' AND t.is_active);

-- final_offer / English / S5  (from local-template:final_offer:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-final_offer-v1', 'final_offer', 'English', 'S5', 'I want to be upfront with you on {{property_address}}: {{offer_price}} is the very top of what I can do as a direct as-is purchase. If that works, I''m ready to move forward on your timeline. If not, no hard feelings — I''d rather be honest than waste your time.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED final_offer (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:final_offer:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-final_offer-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'final_offer' AND t.language = 'English' AND t.is_active);

-- accept_terms / English / S6  (from local-template:accept_terms:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-accept_terms-v1', 'accept_terms', 'English', 'S6', 'That works — {{offer_price}} for {{property_address}}, purchased directly and as-is, no repairs on your end, and we handle the customary closing costs. To get the paperwork right, I just need a few details from you.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED accept_terms (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:accept_terms:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-accept_terms-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'accept_terms' AND t.language = 'English' AND t.is_active);

-- request_signer_email / English / S6  (from local-template:request_signer_email:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-request_signer_email-v1', 'request_signer_email', 'English', 'S6', 'Great, {{seller_first_name}}. What is the best email for you? I will send the purchase agreement for {{property_address}} there for your electronic signature.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED request_signer_email (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:request_signer_email:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-request_signer_email-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'request_signer_email' AND t.language = 'English' AND t.is_active);

-- contract_sent_notice / English / S6  (from local-template:contract_sent_notice:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-contract_sent_notice-v1', 'contract_sent_notice', 'English', 'S6', 'The purchase agreement for {{property_address}} is on its way to your email for electronic signature. Let me know if it does not show up and I will resend it.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED contract_sent_notice (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:contract_sent_notice:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-contract_sent_notice-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'contract_sent_notice' AND t.language = 'English' AND t.is_active);

-- contract_signed_confirmation / English / S7  (from local-template:contract_signed_confirmation:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-contract_signed_confirmation-v1', 'contract_signed_confirmation', 'English', 'S7', 'Thank you {{seller_first_name}}, the agreement for {{property_address}} is fully signed. Next we open title and I will keep you posted at each step.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED contract_signed_confirmation (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:contract_signed_confirmation:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-contract_signed_confirmation-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'contract_signed_confirmation' AND t.language = 'English' AND t.is_active);

-- title_opened_update / English / S8  (from local-template:title_opened_update:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-title_opened_update-v1', 'title_opened_update', 'English', 'S8', 'Quick update on {{property_address}}: title is open and the file is moving. Nothing is needed from you right now.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED title_opened_update (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:title_opened_update:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-title_opened_update-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'title_opened_update' AND t.language = 'English' AND t.is_active);

-- closing_scheduled_update / English / S9  (from local-template:closing_scheduled_update:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-closing_scheduled_update-v1', 'closing_scheduled_update', 'English', 'S9', 'Good news on {{property_address}}: closing is scheduled. I will confirm the exact time and place with you before the day.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED closing_scheduled_update (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:closing_scheduled_update:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-closing_scheduled_update-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'closing_scheduled_update' AND t.language = 'English' AND t.is_active);

-- seller_finance_probe / English / S5  (from local-template:seller_finance_probe:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-seller_finance_probe-v1', 'seller_finance_probe', 'English', 'S5', 'One thought on {{property_address}}: if getting closer to your number matters more than getting everything at closing, would you be open to receiving part of it as monthly payments? It can often get you a better total price.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED seller_finance_probe (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:seller_finance_probe:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-seller_finance_probe-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'seller_finance_probe' AND t.language = 'English' AND t.is_active);

-- future_nurture / English / S5  (from local-template:future_nurture:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-future_nurture-v1', 'future_nurture', 'English', 'S5', 'Totally understand — sounds like we''re not lined up on {{property_address}} right now. I''ll check back down the road; if your plans or price change sooner, I''m easy to reach at this number.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED future_nurture (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:future_nurture:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-future_nurture-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'future_nurture' AND t.language = 'English' AND t.is_active);

-- contract_information_request / English / S6  (from local-template:contract_information_request:v1)
INSERT INTO sms_templates (template_id, use_case, language, stage_code, template_body, is_active, safe_for_auto_reply, reply_mode, property_type_scope, allowed_property_groups, template_name, metadata)
SELECT 'proposed-contract_information_request-v1', 'contract_information_request', 'English', 'S6', 'Great — to draw up the agreement for {{property_address}} I need: everyone who''s on the title, the best email for documents, whether anyone lives there now, and your preferred closing timing. Whenever you''re ready.', false, false, 'auto_reply', 'Any Residential', ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']::text[], 'PROPOSED contract_information_request (English)',
       jsonb_build_object('proposed_by', 'hotfix-8.5.4-s3', 'proposed_at', '2026-10-10', 'owner_approval', 'pending', 'origin', 'local-template:contract_information_request:v1')
WHERE NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.template_id = 'proposed-contract_information_request-v1')
  AND NOT EXISTS (SELECT 1 FROM sms_templates t WHERE t.use_case = 'contract_information_request' AND t.language = 'English' AND t.is_active);

-- Safe clarifiers (coverage-net FALLBACK_MATRIX, apps/api/src/lib/domain/seller-flow/coverage-net/safe-fallback.js:218-291)
-- are code copy too. They are NOT proposed here: activating them also needs a code
-- change (selection by sms_templates row instead of suggested_text). Owner decision.
ROLLBACK; -- PROPOSAL ONLY: replace with COMMIT after owner approval.
