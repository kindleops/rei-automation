-- PROPOSED — NOT APPLIED. DEFECT FIX (owner 2026-10-06, item 4a).
--
-- The two live comp_anchor rows (lc-comp-anchor-en-1 / -es-1) are active AND
-- safe_for_auto_reply and render {{offer_price}}, but comp_anchor is not in
-- MONETARY_OFFER_USE_CASES, so an auto-reply could send a dollar amount with
-- NO persisted record. With SELLER_AUTOPILOT_V2 on, every money template is
-- logged to negotiation_quotes before the send (and blocked if it cannot be).
-- With the flag OFF that guard does not run, so the auto-send path is closed
-- here at the data layer. The rows stay active for operator (manual) use.
-- Rollback: set safe_for_auto_reply = true for the same ids.
begin;
set local lock_timeout = '5s';
update public.sms_templates
   set safe_for_auto_reply = false, updated_at = now()
 where use_case = 'comp_anchor' and template_id in ('lc-comp-anchor-en-1', 'lc-comp-anchor-es-1');
commit;
-- POSTCHECK: select template_id, is_active, safe_for_auto_reply from public.sms_templates where use_case = 'comp_anchor';
