\pset pager off
select coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)                     as gateway_self_check,
       to_regclass('action_gateway.lead_annotations') is not null                                                 as link_29,
       to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is not null                             as link_31,
       (select count(*) from action_gateway.capability_grants where standing_seller_facing and revoked_at is null) = 0 as no_standing_grants,
       action_gateway.agent_text_refusal() = 'AGENT_TEXT_KILL_SWITCH_OFF'                                        as agent_text_off;
