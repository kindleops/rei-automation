-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSED -- NOT APPLIED. APPLY (ends in ROLLBACK -- change the last line to COMMIT after review)
-- Inbox + Pipeline hygiene, owner P0 2026-10-10 ("I don't need bullshit in New
-- Replies, Needs Review or Priority ... half the pipeline items are misplaced").
-- Generated 2026-10-10T10:19:53.473Z from the read-only prod audit
-- (job dir tmp/inbox-hygiene-20261010/audit.json; prod = 8.5.3 88997ca7).
--
-- RULES CARRIED (owner policy, verified in code -- see the hotfix report):
--   * Archive is VISIBILITY ONLY. The quiet archive sets is_archived +
--     archive_scope='quiet_hostility'; follow-ups and nurture keep running
--     (prerequisite: hotfix cherry-pick of 87192efc, which removes the
--     is_archived eligibility block from no-response-followup on prod).
--   * Never suppress for insults; never suppress "not interested". This file
--     writes NO is_suppressed, NO sms_suppression_list, NO send_queue row.
--     Compliance verdicts (wrong number / opt-out on a not-yet-suppressed
--     thread) are LISTED only -- they go through the canonical suppression path.
--   * Not interested -> nurture: disposition not_interested, bucket follow_up,
--     follow_up_at +30d from the reply when none is set (the writer's own rule).
--   * Absurd ask -> PRICE GAP: bucket follow_up + reason code
--     price_far_above_value + intent asking_price_implausible. Never Priority.
--   * Pipeline = projection: stage moves only DOWN to what the events support
--     (no offer event -> never Offer; no ask -> never Asking Price). Statuses:
--     contact-blocked -> suppressed / dead (mirrors the thread's permission
--     state); declines, ownership-only, unclear and stale (> 45 d) -> nurture
--     (follow-ups keep running); a deal with a SENT offer stays live unless the
--     seller declined. 4 "possible false suppression" deals are left for a person.
--   * Rows are touched only when unchanged since the audit (guards below).
--
-- PRECONDITIONS (owner GO for each): prod out of auto mode for writes; run in
-- ONE transaction; read the verification selects before COMMIT.
--
-- COUNTS (planned):
--   inbox    hot_flag_only:clear_hot                  5
--   inbox    new_replies:canonical_path               1
--   inbox    new_replies:keep                         6
--   inbox    new_replies:nurture                      4
--   inbox    new_replies:promote_priority             2
--   inbox    new_replies:quiet_archive                5
--   inbox    new_replies:unclear_cold                 13
--   inbox    priority:keep                            1
--   inbox    priority:price_gap                       2
--   pipeline status active->dead (already_sold)                                  2
--   pipeline status active->dead (hostile_or_troll)                              8
--   pipeline status active->dead (not_owner)                                     4
--   pipeline status active->dead (wrong_number)                                  11
--   pipeline status active->nurture (absurd_ask)                                 8
--   pipeline status active->nurture (latent_interest)                            2
--   pipeline status active->nurture (no_seller_reply)                            3
--   pipeline status active->nurture (no_signal_acknowledgement)                  1
--   pipeline status active->nurture (no_signal_unclear)                          6
--   pipeline status active->nurture (not_interested)                             27
--   pipeline status active->nurture (ownership_confirmed)                        31
--   pipeline status active->nurture (stale)                                      98
--   pipeline status active->nurture (who_is_this_answered_by_automation)         3
--   pipeline status active->suppressed (opt_out)                                 56
--   pipeline status nurture->suppressed (opt_out)                                1
--   pipeline stage  asking_price->offer_interest (asking_price_stage_without_ask) 13
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

-- 0. The plan (data, from the 2026-10-10 read-only audit) ---------------------
CREATE TEMP TABLE _hyg_inbox_plan (thread_state_id uuid PRIMARY KEY, action text NOT NULL, new_bucket text, new_intent text, new_disposition text, reason text, exp_bucket text, exp_last_inbound_at timestamptz);
INSERT INTO _hyg_inbox_plan VALUES
  ('9d07fb75-9205-4a72-b052-3dbc0270bac0'::uuid, 'promote_priority', 'priority', 'asks_offer', NULL, 'asks_offer_no_ask', 'new_replies', '2026-10-07T18:54:27.251+00:00'::timestamptz),
  ('a1faafda-977b-4cce-9bc6-9d4892c8e1d2'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-09T14:26:46.816+00:00'::timestamptz),
  ('ef758baf-d0fc-4360-9ef1-b875f063f84c'::uuid, 'price_gap', 'follow_up', 'asking_price_implausible', NULL, 'price_far_above_value', 'priority', '2026-10-07T20:44:13.209+00:00'::timestamptz),
  ('6c281101-da9d-4246-bb8a-ce1dbd93c3f6'::uuid, 'quiet_archive', NULL, 'hostile_or_legal', NULL, 'hostile_quiet', 'new_replies', '2026-10-09T15:25:13.613+00:00'::timestamptz),
  ('2e1fe7ff-796d-4e88-a07a-ccbfe4cb19a5'::uuid, 'unclear_cold', 'cold', 'who_is_this', NULL, 'who_is_this_answered_by_automation', 'new_replies', '2026-10-08T05:39:59.517+00:00'::timestamptz),
  ('596a9368-6ef8-40f8-97cb-fcc46e6672d3'::uuid, 'promote_priority', 'priority', 'seller_interested', NULL, 'seller_interested_no_ask', 'new_replies', '2026-10-08T18:59:01.593+00:00'::timestamptz),
  ('43183e4b-82a5-49af-b674-64034f34d81f'::uuid, 'quiet_archive', NULL, 'hostile_or_legal', NULL, 'hostile_quiet', 'new_replies', '2026-10-07T22:27:17.42+00:00'::timestamptz),
  ('5bf752db-1a24-4500-a17a-9baf7452470a'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-07T18:04:42.706+00:00'::timestamptz),
  ('7d9abc14-6573-4679-b593-2a218db1f07d'::uuid, 'quiet_archive', NULL, 'hostile_or_legal', NULL, 'hostile_quiet', 'new_replies', '2026-10-09T12:33:07.013+00:00'::timestamptz),
  ('f58f8bef-4164-463c-aad5-eecf24c951e8'::uuid, 'clear_hot', NULL, NULL, NULL, NULL, NULL, '2026-07-01T08:10:04.696+00:00'::timestamptz),
  ('93c25891-15ab-431c-a4a8-213c2346bcff'::uuid, 'unclear_cold', 'cold', 'who_is_this', NULL, 'stale', 'new_replies', '2026-07-01T09:21:46.02+00:00'::timestamptz),
  ('1371ffa7-8c97-4bdb-b939-820509c21870'::uuid, 'clear_hot', NULL, NULL, NULL, NULL, 'suppressed', '2026-09-10T13:11:10.007+00:00'::timestamptz),
  ('f45ff0f1-1808-4df5-8544-8a0bfbfd3c72'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-07T19:26:40.88+00:00'::timestamptz),
  ('5da89e7e-76fd-4938-988e-6c98bd899ee1'::uuid, 'nurture', 'follow_up', 'not_interested', 'not_interested', 'not_interested', 'new_replies', '2026-10-07T21:03:20.642+00:00'::timestamptz),
  ('77dc84fb-cdac-49a1-b930-76e309454f3e'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-07T19:47:19.799+00:00'::timestamptz),
  ('0dab1a24-4db2-4d53-897a-260cc5c0f351'::uuid, 'nurture', 'follow_up', 'not_interested', 'not_interested', 'not_interested', 'new_replies', '2026-10-07T21:11:53.134+00:00'::timestamptz),
  ('a775d94b-ed8e-45fa-8867-342514153a33'::uuid, 'nurture', 'follow_up', 'not_interested', 'not_interested', 'not_interested', 'new_replies', '2026-10-07T22:00:16.64+00:00'::timestamptz),
  ('e603f144-8439-4cdb-9f29-8d69f019a396'::uuid, 'unclear_cold', 'cold', 'who_is_this', NULL, 'who_is_this_answered_by_automation', 'new_replies', '2026-10-07T22:51:40.315+00:00'::timestamptz),
  ('379dd05d-2b90-4a7f-9b09-ec28311149bf'::uuid, 'unclear_cold', 'cold', 'who_is_this', NULL, 'who_is_this_answered_by_automation', 'new_replies', '2026-10-09T14:47:31.374+00:00'::timestamptz),
  ('94d3ef6a-25e1-4f4b-8015-a4dd5ff93d83'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-07T14:31:22.425+00:00'::timestamptz),
  ('99615424-4406-40a3-b3ed-26bc01e2b5a6'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-08T19:10:08.191+00:00'::timestamptz),
  ('0df54182-c5f9-46bb-9020-d86e7464a2a8'::uuid, 'unclear_cold', 'cold', 'language_switch', NULL, 'no_signal_language_switch', 'new_replies', '2026-10-07T17:45:45.991+00:00'::timestamptz),
  ('eb469dc2-2830-408a-92c2-32062be87f7b'::uuid, 'quiet_archive', NULL, 'hostile_or_legal', NULL, 'hostile_quiet', 'new_replies', '2026-10-07T18:40:58.96+00:00'::timestamptz),
  ('0e05f7de-a46d-44c8-889b-9f0ec7fb2655'::uuid, 'price_gap', 'follow_up', 'asking_price_implausible', NULL, 'price_far_above_value', 'priority', '2026-10-07T14:56:29.093+00:00'::timestamptz),
  ('d3b1a66a-9555-42ef-b7af-5e5b26fbdcf7'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-09T22:08:52.91+00:00'::timestamptz),
  ('1ef1d9dd-0aec-42fd-b786-ce9ef66b5359'::uuid, 'nurture', 'follow_up', 'not_interested', 'not_interested', 'not_interested', 'new_replies', '2026-10-09T23:40:38.466+00:00'::timestamptz),
  ('f99c5b9b-252b-4a3b-a5d7-d7412efa385c'::uuid, 'unclear_cold', 'cold', NULL, NULL, 'no_signal_unclear', 'new_replies', '2026-10-10T05:05:15.694+00:00'::timestamptz),
  ('b5f9f6fe-84ae-4153-99f1-965f5be8cff5'::uuid, 'quiet_archive', NULL, 'hostile_or_legal', NULL, 'hostile_quiet', 'new_replies', '2026-10-09T12:49:35.707+00:00'::timestamptz),
  ('882cbba1-eb0c-4406-b830-3f3b92af5b98'::uuid, 'clear_hot', NULL, NULL, NULL, NULL, NULL, '2026-07-01T08:23:01.762+00:00'::timestamptz),
  ('2b855d1c-dc32-4729-ac42-ada3467fecbb'::uuid, 'clear_hot', NULL, NULL, NULL, NULL, NULL, '2026-07-01T09:47:26.598+00:00'::timestamptz),
  ('5b821cba-ef9f-4d0f-a003-e94edba33003'::uuid, 'clear_hot', NULL, NULL, NULL, NULL, NULL, NULL);

CREATE TEMP TABLE _hyg_opp_plan (opportunity_id uuid PRIMARY KEY, new_status text, new_stage text, audit_class text, stage_issue text, exp_status text, exp_stage text);
INSERT INTO _hyg_opp_plan VALUES
  ('54caaf8e-bf0e-41e4-99ec-2a4e652b8ad5'::uuid, 'dead', 'offer_interest', 'hostile_or_troll', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('eff18767-8e9a-4e3e-aba1-b18db26f5375'::uuid, 'suppressed', 'offer_interest', 'opt_out', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('2b3c261d-f3dd-494a-a60c-3437cbdf39b8'::uuid, 'nurture', 'offer_interest', 'not_interested', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('9ef9b123-b623-4104-a788-701b21f93b74'::uuid, NULL, 'offer_interest', 'asks_offer_no_ask', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('32b6140c-38a2-4b8d-9ae5-c453dba8ab97'::uuid, 'nurture', 'offer_interest', 'latent_interest', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('017df192-98d2-4060-8dc0-d6ca014acfd7'::uuid, NULL, 'offer_interest', 'condition_disclosed', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('6bc08074-143a-4634-8e34-bd1868d4c204'::uuid, NULL, 'offer_interest', 'suppressed_positive_latest_flag', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('ece165dc-cc95-4adc-a31f-f7f031220257'::uuid, 'suppressed', 'offer_interest', 'opt_out', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('986182c4-cac7-4479-8e16-e199dc698291'::uuid, NULL, 'offer_interest', 'seller_interested_no_ask', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('591e01ca-5a7b-4fc9-94a6-d160d49d0933'::uuid, NULL, 'offer_interest', 'seller_interested_no_ask', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('deb97b3a-1f8a-4478-a8b4-529f603dd786'::uuid, NULL, 'offer_interest', 'asks_offer_no_ask', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('083abf28-d554-4ddd-b6c9-ac15b0bfa5bb'::uuid, NULL, 'offer_interest', 'asks_offer_no_ask', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('fc519cf2-ae18-4c4d-aca1-0aaa5812a4b4'::uuid, NULL, 'offer_interest', 'condition_disclosed', 'asking_price_stage_without_ask', 'active', 'asking_price'),
  ('2a62900f-b42c-46fa-b0ae-f8e8517bf975'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('1e9bcb16-394f-4553-a55d-714fc31c9933'::uuid, 'nurture', NULL, 'no_seller_reply', NULL, 'active', 'offer_interest'),
  ('bd5bae82-4d72-45b5-a408-32f437a5fe04'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('1cba4978-6567-4713-bdd6-b09c781661e0'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('fa3d83fe-3d3b-45cd-b329-0bd1de339d69'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('d1487800-cb1d-45af-b517-38ae4bd5be31'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('ab98d959-826a-4f97-a61a-01d77c51b8c1'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('7b0006b7-35e2-4b6f-a8d8-348734dec6aa'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('b7400995-4b15-40ad-9191-af0500e23046'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('268f86b6-4a96-4889-9e10-f655cce3f9b0'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('0dcd5f5e-588d-4223-acc0-4a6ec3c4a824'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('7a4991b2-6182-47c4-a872-22ea000cb0c7'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('e33702d2-0f65-4675-ab4f-57daa3806585'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('83ecdab0-a51d-4b16-9219-e2ea9b3adb8e'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('78f0c9f3-2813-480a-8712-c26174307f64'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('75192499-8969-4f48-a7eb-63624811120c'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('e0cab140-8cc3-401f-a9e9-9cc29a6ca04c'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('4cd85283-661e-43d1-b8c5-cf9bd6025b5a'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('d007226e-2b76-47b9-96e9-c2e0da507231'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'offer_interest'),
  ('99c25d9d-7bc0-4506-b84c-f03bd40ceba4'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('3c72a060-3a32-402e-835e-f9e3859230d0'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'offer_interest'),
  ('1be0ea31-214a-4148-b216-68dabc8a7b86'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('c6a2b5bf-80b7-481b-a318-e09deab2bd53'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('9b4d3d14-bd62-4cd4-9e68-8d1046a6c97f'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3fb4896c-2faa-4095-8fd5-6b661cede168'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('1c964573-8f37-4dbd-b227-acf7df713c67'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('b20508c3-1086-4f73-b597-d33a4ab0de3a'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('a09e8ebc-8e9b-4dad-8bc6-f1123011d343'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('5bcee7d7-e7e6-4368-b7c5-4be414d69486'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('c4b00bf3-18b3-41d8-a9f2-f8178dbef58a'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('a07b0e9b-04da-4033-88d0-7f3dab9bb65c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('d8e930e7-f054-46ca-ade8-b2857ada03ea'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('b1dad5a4-f4f8-455b-87d6-5c415359afbc'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('be7fd784-e153-4ef6-a7b7-678085845879'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('ecb602ec-381f-4969-8cb4-3a1a8664560c'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('6c355445-7f14-4265-a8e9-97f43ecc7c2b'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('f0e14ad8-d138-4ef2-8bc5-ff29e677fa22'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('7c87ffe5-3383-4eb6-996a-b0659577c3bc'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('a918641d-8558-4f73-a4f6-ee717886e048'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('d35c4d13-bee4-4df0-89ad-3a9590a58309'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('5e1af264-905e-47b9-a019-6adf45ada5a8'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('f00a0e04-aaa1-49b5-bd20-9f57fc408da9'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('e740c6d8-3286-42f2-9f1d-a0ca405a7d8f'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('5214b59c-4cdc-4c4b-855a-4752a355a97c'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('10fa1e40-5576-440a-b4d7-e06e5736167d'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('aad26566-95af-43e7-b62d-687102299df8'::uuid, 'dead', NULL, 'already_sold', NULL, 'active', 'offer_interest'),
  ('1ce06515-19cc-4e4c-b0f4-5e72eddd1da1'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('4bd49072-db48-4567-98ab-0339c8d1d1d3'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('c813369e-eddb-4912-8025-fcad348444d9'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('b502c996-2444-4da2-bbc1-8ef16d832710'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('23701d1b-8486-4234-9abb-e02577606b83'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('ac48005a-efbb-49e8-b984-82592b751054'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('a6bd3f20-6e51-4ddd-8cd2-e3c3afde977d'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('421a24a3-3ca8-4a44-9168-438d85466afa'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('94a9bdd5-9d3d-4aca-a26e-2ced4523b81b'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('5fc2cd62-8bdb-4175-9c5d-77b4547e46f8'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('351550bc-10db-4c9b-b957-a736747501c8'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('407f649d-9b82-42fd-9367-76f02a196c11'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('0d47ba23-eec4-4749-b325-08216b42ba26'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('7c7e57f4-6836-4269-a493-cb54a8d44a11'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('8306dd47-3dc6-4d29-8519-30873e4f8b3b'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('f76344ae-7b4f-45d8-8162-2455ac6acd33'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('4c6b9ab1-67b3-4913-b6f4-015cbe38c419'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('0969b607-6427-40fe-b912-db6de197517c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('ff40e0e0-4157-4126-81c3-b425ace1deaa'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('c8d8e9ec-a44d-4444-9e76-5b01ddcfb263'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('45ae9d4e-facb-4e19-b0ad-dec3365e1f8f'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('629e3317-6c89-4151-9b6e-2239f6259b4c'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('4d67f0e2-be2d-4e3a-b344-7d7886c959c0'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('c02cabb2-f36a-4ccd-8031-17205b05f12e'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('35c85d4a-2c1a-40e2-b224-971ed1db5bb1'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('a0404ef8-70cc-4251-9b0a-333f1a031b43'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('f3b032ec-2125-48ac-b1f7-a6477cc11ccb'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('0e31e2ed-9add-4329-af63-b0fe71cf81c7'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'offer_interest'),
  ('c9656807-35c1-4d59-8e4f-6d9c843ab592'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('b1461563-1f01-4d50-a88e-63d908b1e322'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('dfa5772d-2f83-4f59-b27c-81131cc9293c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('bf745e5f-0dc7-4073-8cd8-f07c4697d5c3'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('55604a28-42ad-49cf-bf13-dca211ed6ac9'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('d1af5c2f-5752-4695-812f-084435a0dac5'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('137200e9-68d0-460f-a9d9-70cd65b265e4'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('b190ce75-9bba-4956-bb46-45765b0fa612'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('87092c26-7014-49a7-94d2-45421e671961'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('93c51487-ff86-41c8-b2f4-0f7516430ad0'::uuid, 'dead', NULL, 'not_owner', NULL, 'active', 'offer_interest'),
  ('cadfdf66-f0aa-43a9-b2b3-abab078ccd96'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3d8612ce-060c-423a-8731-ba89d0c5b1e3'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('f96172dd-4244-448b-9993-84f6e40e6679'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('b910b6bf-7818-445c-bc6a-a7eb4ee9b8fc'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('6dafdc60-43b2-40c6-acd0-b0e2c9158fc5'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3cac7dfa-6c7e-47c9-b298-aa7b6d7139bb'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('cb793341-3805-402e-a191-3da857a93abe'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('06622317-45ab-4222-986d-d5bf92243842'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('167e1540-a83e-46e6-86a5-e30e3868a81c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3183b473-5cac-4edf-a98a-00593e2c19c2'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('e2905c16-5edf-487a-a08b-b616315a40c3'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('6b688e0a-3cca-4506-9894-3c8fc57337e6'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('f1638689-6cfe-44a3-9765-84ec4129158b'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('00ab2e1c-1de8-4863-9762-3ee9aeab141c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('32f54de5-92e4-4581-97c7-b01ab92b9376'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('f811275e-df65-4728-9f35-848fc9fc945f'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('3abedf70-b96a-4cd6-8a97-9a654a129972'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('807760bf-e629-4bf0-8162-033808881381'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('201e27fe-2986-4881-a5a5-25432a6d33c7'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('d70b7476-b0c4-484e-8b8b-f249eb114da6'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('579277fb-40c6-4c2c-bf64-401ce926bda9'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('c075a1c1-691d-42fe-bf06-d695ac258c33'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('6986bbb6-7256-496a-9360-800e91920ecc'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('cdbc9a64-b80c-4c08-a70e-1d355b54526e'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('196f4c12-1eb2-473b-bb36-cdded72055c7'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('f88d6262-da5e-4d8e-8163-b9cf91dd6fad'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('1c78a5ee-1784-4f94-af91-86535d0f138f'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('cd8e09ce-a485-4674-8c0e-3bd474421de9'::uuid, 'dead', NULL, 'already_sold', NULL, 'active', 'offer_interest'),
  ('b7acc412-d5fc-4412-84b7-4bf76ca31737'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('6fe66fde-dd85-43df-ae13-85cea6307ec2'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('126590f4-0b6f-4743-8976-3c075c8b5627'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('814d7809-9b22-46a8-b64e-27973265f4f7'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('78b1bf33-6813-4b42-a31d-bb4794aa4759'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('2654359e-77ed-4aa6-bc27-c0b5d88a5fb7'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('ab74d8c6-66e5-4a84-885b-91e0f23f97ba'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('1ae5b9de-8802-45a5-b7fb-65f1ffa8b184'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('7e586c99-088b-4b77-865e-e382ee86ff1f'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('52792bf4-ff51-49ce-bdd3-8d93a9cdc802'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('d283e85b-7189-457a-8b50-87117c16197c'::uuid, 'dead', NULL, 'not_owner', NULL, 'active', 'offer_interest'),
  ('de66c54f-063d-4a81-8113-419681b63046'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('18e627f8-e397-4c80-84d6-d6825f09cf27'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('d0aad34e-5a29-4166-91eb-e989cb3965b5'::uuid, 'nurture', NULL, 'no_signal_unclear', NULL, 'active', 'offer_interest'),
  ('b5ad155c-11b6-484b-95ff-3b9932da27b5'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('607987b3-0437-4291-a316-e887d80c615c'::uuid, 'nurture', NULL, 'who_is_this_answered_by_automation', NULL, 'active', 'offer_interest'),
  ('3a36f0bc-3254-44a2-a4a5-0e9b6c676593'::uuid, 'dead', NULL, 'not_owner', NULL, 'active', 'offer_interest'),
  ('2c9d5136-2165-4c16-a5d3-0e2dbe4dfdfe'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('0e61c369-dd82-4668-aeb6-429e94a784ac'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('a160614f-8854-4a42-b257-de2f1c80bb02'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3f98c207-644b-4369-994d-63fc83f64c56'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('d2a866b2-ba49-4895-85ac-26daa9ee30b3'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('15b387ac-dc53-48f9-9d68-4e1a34c39728'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('03a8fe44-b358-402e-8149-d5d58347a35b'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('5f191dc7-9319-4ab0-b575-80eaa97b55cb'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('96ce40c9-3267-4537-8e3a-0c563a79fc72'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('d195521a-8a3b-44e4-b169-4d01164a54ef'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('bd2e91cd-df66-401a-bad0-7ea945cd320a'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('4e16d072-21a3-44ed-9a1e-607d9edb3876'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('e6f9c13d-7aa3-40f8-8de8-72ad3e900183'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('17528fe8-3fa0-4d9c-9f62-c314e5b626c6'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('3b90f3f6-7a23-4f66-8afb-34bc11cff1ff'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('db770194-d737-4d7e-ba64-ec961e4147aa'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('96e4b705-20f7-4731-b2c2-c7cef9021ffb'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('99556aca-9e73-4257-8297-0a49b9b4ef32'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('8be45a55-fc84-4dd8-b0e2-473c24e9b4ba'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('08fd5cb5-7e1d-4992-8787-8f6c980a67dd'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('537d5fcf-d81a-4005-9b80-21b2741c1aee'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('10d4ed36-e9e3-4d7b-8a5c-7cca2ccd911c'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('a2dca29d-af1f-4f80-9808-77fc60eb0e66'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('d4754f3a-5e1f-48a5-af58-af2e33f76374'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'offer_interest'),
  ('0d86afcf-181f-4d6a-b474-b944aee07c21'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('922d6ec3-3d2e-43eb-b1d3-173f31860155'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('0716c7cb-1947-4f40-b220-1dd610418399'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('dad2cde1-6f5d-4340-8051-c3ca07732fc2'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('7b2cda8f-7a92-4074-9435-4a16e6916f2b'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('bf70585e-eb78-4995-ab53-00df01eea4a6'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('d140c614-a387-4a91-9b1a-75ed5f918f27'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('12dbed64-3156-4d14-8e25-05d124ec7740'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('8f75b93e-9fe4-4470-8671-7227bc43ad4f'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('4ca8c7ed-7f64-459d-a53d-e57c3ff41788'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('5ce69182-9553-4053-ad78-9a0214f5a532'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('e4a5d3b6-e731-47f3-8f9c-ffbeae814b07'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('7b1fb1c5-eecd-4ada-889c-41f40a9afc5d'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('ce135104-8aa9-432a-a6f1-cf384de79ab7'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('8fe626e9-86e8-4ce3-be5d-4f5fb22c7ff4'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('0853b5ff-a690-4b09-8818-feb85cc77d2f'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('97159dc5-e5b0-44e5-9723-8ffb4e0d4443'::uuid, 'nurture', NULL, 'no_seller_reply', NULL, 'active', 'offer_interest'),
  ('7445069c-a7d1-4974-8840-441185997475'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('0f54fdc1-ba67-43a7-9a44-084991755b52'::uuid, 'nurture', NULL, 'no_seller_reply', NULL, 'active', 'offer_interest'),
  ('aa3d2dca-9611-4edc-99a7-039eccba2fdb'::uuid, 'nurture', NULL, 'no_signal_unclear', NULL, 'active', 'offer_interest'),
  ('f66149ac-cc93-446e-8e84-45d1f08abe58'::uuid, 'nurture', NULL, 'latent_interest', NULL, 'active', 'offer_interest'),
  ('21ead090-1bd5-4d89-88c0-af82babb655f'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('f01e511b-a611-429e-b6bf-9a9f7c560778'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('6a907cb0-fd2f-46ac-a941-2dc1e1e094c7'::uuid, 'dead', NULL, 'hostile_or_troll', NULL, 'active', 'offer_interest'),
  ('92be08b3-d6f9-4442-86aa-5f01765bc909'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('a8b6f418-f3a3-426d-829c-a9a25f87e069'::uuid, 'nurture', NULL, 'who_is_this_answered_by_automation', NULL, 'active', 'offer_interest'),
  ('d8f7f30f-48aa-4372-ad03-1110b080c4c5'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('a9361b23-66c0-4f34-bff1-bc8a5cc13796'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('5a82efaf-4ffb-457a-b8eb-3bb94dfaf69f'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('34af7ac0-f236-4dc0-90e3-ef628175ca31'::uuid, 'nurture', NULL, 'who_is_this_answered_by_automation', NULL, 'active', 'offer_interest'),
  ('6e6e559d-e2b2-4d4a-a651-3f75909a3a82'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('f9eb92fa-0b36-44b7-b344-c05230ea48e6'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('cd5a81f8-59ee-4da7-abe6-c2aa44df34ea'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('603ab48f-5c34-4acb-94ec-00024725fc3a'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('4e697792-dd9d-4b08-b48c-b448744bc2ea'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('b87746f1-f231-4bd3-a792-50f6832ccb50'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('3d2a0a61-7cce-4f58-95f2-dd5aa14f835e'::uuid, 'nurture', NULL, 'no_signal_acknowledgement', NULL, 'active', 'offer_interest'),
  ('ad1169ee-3e04-48fb-bb7e-bb95d3f98437'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('45a5febb-3dbf-4198-9bdb-3901a794b86b'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('eaa494c4-af23-4bb8-90eb-7fe67678fd55'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('1da95655-1323-4194-bf15-7ca0e8ade8bb'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('4aa72df8-81ec-41db-b670-ce58ce8bf188'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('efed9918-c7eb-40ab-ba89-6e48bcd61c3f'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('c0851dee-2ee9-4e20-ac89-c3de165264c8'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('fd9dd740-001e-49fc-8975-2388de51f4b6'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('d93a0176-fb1e-44bd-8bdb-b7e106a12d8b'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('bc8b7e3e-ede5-47c1-99f9-e7577b275686'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('acfccd83-0adc-4c1b-b4f4-9df95da996e6'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('b8d21d8a-ea6f-4e53-a06a-3e70a6c6a0f8'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('1f4e064c-080a-488d-bae9-0d9ce544c87c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('b4698a0e-5475-4cfa-b212-3dce3c2105c7'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('861c21cd-409b-4b69-a26e-20f8a02cbadf'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('4fc4540f-a762-4590-86e7-e8e27721cbb0'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('4e46283e-b7c0-4c85-9a2d-8fb00ef2692c'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('a88d26f7-3932-49e3-ab39-0f679b121762'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('8b339b30-e11e-4914-a680-fb2efc961c99'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('fb57c974-21dc-4598-a57c-95a1dc66f1bc'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('0d43521a-be75-4423-b034-c53a26ef33de'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('74a4d457-d2dc-4048-ae8b-09bfe4b1b1b1'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('5fe7d5b3-f4e2-4710-8e34-dc8e17730608'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'offer_interest'),
  ('adab296b-1b48-446c-b973-1b66e0b19d1a'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('e6ac47cf-c4a0-4684-8a95-2abe4448242b'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3d14ae43-2df0-46b4-9f61-bf7632b47af4'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('a92b017a-45c7-4f7d-92d3-d0821f2889c0'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('10e34d6c-cfec-4068-a821-fba7eebc0510'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('3851e9c1-0438-4719-8194-00be990ccf17'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('30e4e346-d3a0-4db5-9fdc-331ec479d04b'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('f2d2fb6e-6b9f-469b-9a98-e54b45eac8e4'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('cd201d50-9413-4fd3-89ee-6427354df0ef'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('73672599-5bb6-4b33-bf5b-423a511a0348'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('85b99c5e-6937-4358-993c-34ee7edc5175'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('5a386e19-0a86-4718-81c4-ea19a1a850ec'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('8d3659fe-24df-4593-8e9e-bf25dbb9b60e'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('2bbafe05-f186-46a6-b740-e8ac34dd1d15'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('7c0122c3-f538-4070-95a4-0847e49b22fa'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('82bea056-60c8-42d5-b886-5e02bf3e510c'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('b8d8c0d7-a843-4f3e-8472-372e71076872'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('db146a5d-6125-43b2-890e-2461006f7488'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('35f6abe6-f057-4612-9c57-d3f575f9f591'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('3f1e9acc-8762-4632-933e-1e6ccc54bdb4'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('ab02316f-b6d3-4c57-8b60-e9cbab114b4f'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('413ff8e2-b36b-48d7-8d5c-01bffc216196'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('9e979c7f-05bd-4cd4-8adf-4765ca4e56d9'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('a2af9a3a-6f60-41aa-8015-ba6061cc0c7a'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('fca05bfe-0681-45d9-b95f-566cb9e29fdd'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('848f4d1b-1130-4390-8d3c-b1abc264a64f'::uuid, 'nurture', NULL, 'no_signal_unclear', NULL, 'active', 'offer_interest'),
  ('4fba96e5-e35c-462e-9786-fae1ea43b2e7'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'offer_interest'),
  ('62084ce2-7c19-48b3-a42f-eb29ea1dcad1'::uuid, 'nurture', NULL, 'ownership_confirmed', NULL, 'active', 'offer_interest'),
  ('aaf6e8b7-1fef-490b-bf9c-6767fcdac4e7'::uuid, 'nurture', NULL, 'stale', NULL, 'active', 'offer_interest'),
  ('7bebb64d-1ec7-4546-8fb4-7f4c927334fa'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'active', 'offer_interest'),
  ('7d2c78be-a428-4e14-9c66-0559ea14bb66'::uuid, 'suppressed', NULL, 'opt_out', NULL, 'nurture', 'offer_interest'),
  ('5a85f4f8-9ac5-4b9e-89a9-ef8cc81183f2'::uuid, 'dead', NULL, 'wrong_number', NULL, 'active', 'ownership_confirmation'),
  ('e35aa250-d2b1-4553-965b-d9b0c18ee47a'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'ownership_confirmation'),
  ('28cf1c11-429c-457b-9035-b8bd2e2000e8'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'ownership_confirmation'),
  ('d450ec80-aec7-4b6e-94c0-b069950c83f8'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'ownership_confirmation'),
  ('a0911141-17f4-4c16-8613-8ce7d9714f16'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'ownership_confirmation'),
  ('8fe441f9-374b-43dd-8c7c-d3314ea72567'::uuid, 'nurture', NULL, 'no_signal_unclear', NULL, 'active', 'ownership_confirmation'),
  ('884eff2c-b1b4-416b-98e7-268b767bc2ac'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'ownership_confirmation'),
  ('e03da78c-190a-4b25-bd22-88ba6e791fd8'::uuid, 'nurture', NULL, 'absurd_ask', NULL, 'active', 'ownership_confirmation'),
  ('1fe41a0b-e19c-40c3-9f1c-b1be54cf2fd7'::uuid, 'nurture', NULL, 'no_signal_unclear', NULL, 'active', 'property_condition'),
  ('84de5b0f-719f-4c45-86c6-6140df085f46'::uuid, 'nurture', NULL, 'not_interested', NULL, 'active', 'property_condition'),
  ('21177b37-c852-435c-8999-d0efa9e3907d'::uuid, 'dead', NULL, 'not_owner', NULL, 'active', 'property_condition'),
  ('5f14a710-117f-44f7-9dbd-ccc5658e0b74'::uuid, 'nurture', NULL, 'no_signal_unclear', NULL, 'active', 'property_condition');

-- Guards: a row is touched only if it still looks exactly like the audit saw it
-- (no newer seller reply, same bucket / status / stage). Anything that moved
-- since is skipped and shows up in the skipped counts below.
CREATE TEMP VIEW _hyg_inbox_go AS
  SELECT p.*, s.id AS sid FROM _hyg_inbox_plan p JOIN inbox_thread_state s ON s.id = p.thread_state_id
   WHERE s.inbox_bucket IS NOT DISTINCT FROM p.exp_bucket
     AND s.last_inbound_at IS NOT DISTINCT FROM p.exp_last_inbound_at;
CREATE TEMP VIEW _hyg_opp_go AS
  SELECT p.*, o.id AS oid FROM _hyg_opp_plan p JOIN acquisition_opportunities o ON o.id = p.opportunity_id
   WHERE o.opportunity_status IS NOT DISTINCT FROM p.exp_status
     AND o.acquisition_stage IS NOT DISTINCT FROM p.exp_stage;

-- 1. Backups (durable; the rollback file restores from these) -----------------
CREATE TABLE IF NOT EXISTS public._hyg20261010_inbox_backup AS
  SELECT s.* FROM inbox_thread_state s WHERE false;
INSERT INTO public._hyg20261010_inbox_backup
  SELECT s.* FROM inbox_thread_state s JOIN _hyg_inbox_go g ON g.sid = s.id;
CREATE TABLE IF NOT EXISTS public._hyg20261010_opp_backup AS
  SELECT o.* FROM acquisition_opportunities o WHERE false;
INSERT INTO public._hyg20261010_opp_backup
  SELECT o.* FROM acquisition_opportunities o JOIN _hyg_opp_go g ON g.oid = o.id;

-- 2. Inbox ---------------------------------------------------------------------
-- 2a. Price gap (absurd ask -> nurture sub-bucket, never Priority)
UPDATE inbox_thread_state s SET
    previous_inbox_bucket = s.inbox_bucket,
    inbox_bucket = 'follow_up',
    last_intent = 'asking_price_implausible',
    is_hot_lead = false,
    reason_codes = (SELECT jsonb_agg(DISTINCT e) FROM jsonb_array_elements(coalesce(s.reason_codes, '[]'::jsonb) || '["price_far_above_value"]'::jsonb) e),
    updated_by = 'hygiene_20261010'
  FROM _hyg_inbox_go g WHERE g.sid = s.id AND g.action = 'price_gap';
-- 2b. Not interested -> nurture (never suppressed, never archived)
UPDATE inbox_thread_state s SET
    previous_inbox_bucket = s.inbox_bucket,
    inbox_bucket = 'follow_up',
    disposition = 'not_interested',
    last_intent = 'not_interested',
    is_hot_lead = false,
    follow_up_at = coalesce(s.follow_up_at, coalesce(s.last_inbound_at, now()) + interval '30 days'),
    updated_by = 'hygiene_20261010'
  FROM _hyg_inbox_go g WHERE g.sid = s.id AND g.action = 'nurture';
-- 2c. Insult / troll -> quiet archive (visibility only; NOT suppressed; the next reply un-archives)
UPDATE inbox_thread_state s SET
    is_archived = true,
    archived_at = coalesce(s.archived_at, now()),
    archive_scope = 'quiet_hostility',
    archive_reason = 'hygiene_20261010:hostile_quiet',
    last_intent = coalesce(g.new_intent, s.last_intent),
    is_hot_lead = false,
    updated_by = 'hygiene_20261010'
  FROM _hyg_inbox_go g WHERE g.sid = s.id AND g.action = 'quiet_archive';
-- 2d. No-signal / who-is-this / stale replies -> out of New Replies (stored cold;
--     the round-9 view shows them in the non-alerting Unclear lane once applied)
UPDATE inbox_thread_state s SET
    previous_inbox_bucket = s.inbox_bucket,
    inbox_bucket = 'cold',
    last_intent = coalesce(g.new_intent, s.last_intent),
    is_hot_lead = false,
    updated_by = 'hygiene_20261010'
  FROM _hyg_inbox_go g WHERE g.sid = s.id AND g.action = 'unclear_cold';
-- 2e. Genuine interest the old classifier read as unclear -> Priority
UPDATE inbox_thread_state s SET
    previous_inbox_bucket = s.inbox_bucket,
    inbox_bucket = 'priority',
    last_intent = g.new_intent,
    updated_by = 'hygiene_20261010'
  FROM _hyg_inbox_go g WHERE g.sid = s.id AND g.action = 'promote_priority';
-- 2f. HOT flag on a non-actionable thread (not interested / wrong number / opt-out / blank)
UPDATE inbox_thread_state s SET is_hot_lead = false, updated_by = 'hygiene_20261010'
  FROM _hyg_inbox_go g WHERE g.sid = s.id AND g.action = 'clear_hot';

-- 3. Pipeline ------------------------------------------------------------------
INSERT INTO acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
  SELECT g.oid, 'status_changed', 'opportunity_status', g.exp_status, g.new_status, g.audit_class, 'hygiene_20261010', 'hygiene_20261010', 'hygiene_20261010:status:' || g.oid, jsonb_build_object('audit_class', g.audit_class)
    FROM _hyg_opp_go g WHERE g.new_status IS NOT NULL
  UNION ALL
  SELECT g.oid, 'stage_changed', 'acquisition_stage', g.exp_stage, g.new_stage, g.stage_issue, 'hygiene_20261010', 'hygiene_20261010', 'hygiene_20261010:stage:' || g.oid, jsonb_build_object('stage_issue', g.stage_issue, 'rule', 'pipeline_is_projection')
    FROM _hyg_opp_go g WHERE g.new_stage IS NOT NULL;
UPDATE acquisition_opportunities o SET
    opportunity_status = coalesce(g.new_status, o.opportunity_status),
    acquisition_stage = coalesce(g.new_stage, o.acquisition_stage),
    stage_entered_at = CASE WHEN g.new_stage IS NOT NULL THEN now() ELSE o.stage_entered_at END,
    last_updated_source = 'hygiene_20261010',
    last_updated_by = 'hygiene_20261010',
    updated_at = now()
  FROM _hyg_opp_go g WHERE g.oid = o.id;

-- 4. Verification (read before COMMIT) ------------------------------------------
SELECT 'inbox ' || action AS change, count(*) FROM _hyg_inbox_go GROUP BY 1
UNION ALL SELECT 'inbox SKIPPED (moved since audit)', (SELECT count(*) FROM _hyg_inbox_plan) - (SELECT count(*) FROM _hyg_inbox_go)
UNION ALL SELECT 'pipeline status -> ' || new_status, count(*) FROM _hyg_opp_go WHERE new_status IS NOT NULL GROUP BY 1
UNION ALL SELECT 'pipeline stage -> ' || new_stage, count(*) FROM _hyg_opp_go WHERE new_stage IS NOT NULL GROUP BY 1
UNION ALL SELECT 'pipeline SKIPPED (moved since audit)', (SELECT count(*) FROM _hyg_opp_plan) - (SELECT count(*) FROM _hyg_opp_go)
ORDER BY 1;
SELECT priority, new_replies, needs_review, follow_up, cold FROM v_inbox_bucket_counts;
-- must be 0: a suppression written by this file
SELECT count(*) AS must_be_zero_new_suppressions FROM inbox_thread_state s JOIN _hyg_inbox_go g ON g.sid = s.id
  JOIN public._hyg20261010_inbox_backup b ON b.id = s.id WHERE s.is_suppressed IS DISTINCT FROM b.is_suppressed;

ROLLBACK; -- change to COMMIT after review
