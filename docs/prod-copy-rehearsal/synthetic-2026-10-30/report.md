# Production-copy rehearsal — SYNTHETIC proof 2026-10-30 (no production data)

Database `lc_prodcopy_synth_20261030` on `postgres://postgres@127.0.0.1:54341/postgres` (PostgreSQL 17.11 (Ubuntu 17.11-1.pgdg24.04+2), server address 127.0.0.1). Tool `prod-copy-rehearsal/1`. Generated 2026-10-30T05:20:21.615Z.

| Step | Status | Duration | Key result |
|---|---|---|---|
| validate-backup | PASS | 124 ms | custom, 1.1 MB, sha256 `417eed1ed41ea088…`, 1445 TOC entries, 88 with data |
| restore | PASS | 2174 ms | restore 1954 ms; pg_restore errors 1 {"expected_stub_schema_exists":1}; ACL pass 379 entries, 0 errors |
| prereqs | PASS | 349 ms | required all true; switches OFF |
| migrate | PASS | 12149 ms | rollback fingerprint identical; re-apply identical; V-A/V-B/V-OFF ok |
| census | PASS | 1922 ms | leads 12; threads 9; eligible 2 / blocked 4 / unknown 3 |
| hidden-gold | PASS | 1412 ms | analysed 8; ranked 5; contactable 1; unknown 2 (never contactable) |

## Backup

- File `synthetic-20261030.dump`, format `custom`, sha256 `417eed1ed41ea0885855f85a32c7ef2dcfbd4fe7ea96869cf9eac7793b661f5d`, read with pg_restore (PostgreSQL) 17.11 (Ubuntu 17.11-1.pgdg24.04+2).
- Archive header: dbname lc_prodcopy_synth_src_20261030; TOC Entries 1449; Compression gzip; Dump Version 1.16-0; Format CUSTOM; Dumped from database version 17.11 (Ubuntu 17.11-1.pgdg24.04+2); Dumped by pg_dump version 17.11 (Ubuntu 17.11-1.pgdg24.04+2).
- TOC: 1445 entries; by type {"SCHEMA":4,"COMMENT":82,"ACL":377,"EXTENSION":1,"FUNCTION":225,"TABLE":88,"SEQUENCE":9,"SEQUENCE OWNED BY":1,"VIEW":6,"MATERIALIZED VIEW":2,"DEFAULT":1,"TABLE DATA":88,"SEQUENCE SET":9,"CONSTRAINT":119,"CHECK CONSTRAINT":1,"INDEX":110,"TRIGGER":77,"FK CONSTRAINT":54,"ROW SECURITY":69,"POLICY":117,"DEFAULT ACL":3,"MATERIALIZED VIEW DATA":2}.
- Key tables with data: {"public.properties":true,"public.eg_property_facts":true,"public.inbox_thread_state":true,"public.message_events":true,"public.campaign_target_graph":true,"public.sms_suppression_list":true,"public.phones":true}.

## Restore

- Options --no-owner --no-privileges; excluded schemas auth, storage, vault, pgsodium, pgsodium_masks, realtime, _realtime, supabase_functions, supabase_migrations, net, graphql, _analytics, pgbouncer; auth stub created; roles created on the local server: none.
- Data restore 1665 ms (exit 1, 1 error(s) {"expected_stub_schema_exists":1}); ACL pass 379 entries in 176 ms, 0 error(s) {}; total 1954 ms; database 14.4 MB.

| Key table | Rows |
|---|---|
| public.properties | 12 |
| public.eg_property_facts | 12 |
| public.inbox_thread_state | 9 |
| public.message_events | 22 |
| public.campaigns | 0 |
| public.campaign_targets | 0 |
| public.campaign_target_graph | 11 |
| public.send_queue | 0 |
| public.sms_suppression_list | 2 |
| public.phones | 10 |
| public.master_owners | 11 |
| public.prospects | 3 |
| public.contact_property_resolution | 7 |
| public.acquisition_opportunities | 3 |
| public.seller_offers | 2 |
| public.followup_intents | 1 |
| public.property_acquisition_scores | 2 |
| public.ai_generated_messages | 0 |
| public.automation_holds | 1 |
| public.automation_suppressions | 0 |
| public.system_control | 2 |
| agent.ops_work_item | 0 |
| action_gateway.capability_grants | 0 |
| action_gateway.action_intents | 0 |
| action_gateway.seller_action_receipts | 0 |

## Prerequisites (§1)

Verbatim §1 query (sha256 `c3d2e47b3aec7e0c…`): {"ledger":true,"link_26":true,"link_27":true,"link_28":true,"link_28_send_authority":true,"link_29":false,"link_31":false,"link_31_check":null,"gateway_self_check":true,"relations":true}.

- Required before the sequence: {"ledger":true,"link_26":true,"link_27":true,"link_28":true,"link_28_send_authority":true,"gateway_self_check":true,"relations":true}
- Must not be applied yet (the sequence applies them): {"link_29":false,"link_31":false,"link_31_check":false}
- Reader links: {"reader_1_0":true,"reader_1_1_conversation_intel":false,"reader_1_2_corpus_census":false,"reader_1_3_acquisition_reads":false}
- Switches: ai_agent_text_enabled=absent, ai_agent_message_enabled=absent, ai_conversation_send_enabled=false → OFF
- **Warning:** ORDERING: reader 1.1 / 1.2 are not applied. Once #30 is applied, 1.1 and 1.2 can no longer be applied (their apply self-check refuses #30's functions as unexpected reachable definers) until #30 is rolled back — the documented reader order is 1.0 → 1.1 → 1.2 → #30. The census step applies them inside this copy by rolling #30 back first and re-applying it after.

## Migrations #29 #30 #31 A B

SHA-256 of every apply file equals the pin in `docs/AGENT-TEXTS-DIFF-AUDIT.md` (rollback files match their pinned prefix):

- #29 `PROPOSED_20261027120000_action_gateway_ohg.sql` `3f76b0e6c0d8d184…` match
- #30 `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql` `10ec163f8d82df7c…` match
- #31 `PROPOSED_20261028100000_action_gateway_standing_reply.sql` `2e054bfdad4438df…` match
- A `PROPOSED_20261029090000_ai_generated_outbound.sql` `64537ccfe7eef2f5…` match
- B `PROPOSED_20261029100000_action_gateway_agent_message.sql` `cb34b2dcae891226…` match

| Cycle | Link | Pretest ms | Apply ms | Posttest | CHECKs re-validated on existing tables (rows; read-only scan ms) |
|---|---|---|---|---|---|
| 1 | #29 | 46 | 83 | pass (118 ms) | action_gateway.seller_action_receipts: 1 CHECK(s), 1 validated at apply, 0 rows; 14 ms |
| 1 | #30 | 17 | 159 | advisory_fail (28 ms) | — |
| 1 | #31 | 22 | 55 | pass (121 ms) | action_gateway.capability_grants: 1 CHECK(s), 1 validated at apply, 0 rows; 11 ms; action_gateway.action_authorizations: 2 CHECK(s), 2 validated at apply, 0 rows; 38 ms |
| 1 | A | 24 | 56 | pass (27 ms) | ai_generated_messages: 6 CHECK(s), 6 validated at apply, 0 rows; 93 ms |
| 1 | B | 27 | 176 | pass (107 ms) | action_gateway.seller_action_receipts: 1 CHECK(s), 1 validated at apply, 0 rows; 15 ms; action_gateway.capability_grants: 2 CHECK(s), 2 validated at apply, 0 rows; 38 ms; action_gateway.action_authorizations: 1 CHECK(s), 1 validated at apply, 0 rows; 12 ms |
| 2 (re-apply) | #29 | 38 | 75 | pass (118 ms) | action_gateway.seller_action_receipts: 1 CHECK(s), 1 validated at apply, 0 rows; 18 ms |
| 2 (re-apply) | #30 | 17 | 163 | advisory_fail (42 ms) | — |
| 2 (re-apply) | #31 | 19 | 77 | pass (77 ms) | action_gateway.action_authorizations: 2 CHECK(s), 2 validated at apply, 0 rows; 31 ms; action_gateway.capability_grants: 1 CHECK(s), 1 validated at apply, 0 rows; 10 ms |
| 2 (re-apply) | A | 19 | 51 | pass (38 ms) | ai_generated_messages: 6 CHECK(s), 6 validated at apply, 0 rows; 85 ms |
| 2 (re-apply) | B | 30 | 217 | pass (132 ms) | action_gateway.seller_action_receipts: 1 CHECK(s), 1 validated at apply, 0 rows; 15 ms; action_gateway.capability_grants: 2 CHECK(s), 2 validated at apply, 0 rows; 28 ms; action_gateway.action_authorizations: 1 CHECK(s), 1 validated at apply, 0 rows; 16 ms |

| Rollback | ms | Rollback posttest |
|---|---|---|
| B | 191 | pass (77 ms) |
| A | 51 | pass (19 ms) |
| #31 | 49 | pass (85 ms) |
| #30 | 66 | pass (89 ms) |
| #29 | 110 | pass (71 ms) |

- Fingerprint before apply `31ff3e92c89a0d9c`, after rollback `31ff3e92c89a0d9c` → identical; row counts restored: true.
- Fingerprint after the first apply `6917073e6524414e`, after the re-apply `6917073e6524414e` → identical.
- V-A {"has_columns":true,"no_agent_records_yet":true,"replies_bound":true}
- V-B {"self_check":true,"registry_rows":true,"handoff_kind":true,"composers_retired":true,"gateway_writer":true,"no_worker_fn_for_gateway":true,"no_anon":true,"feed_empty":true}
- V-OFF {"refusal":"AGENT_TEXT_KILL_SWITCH_OFF","at_switch":null,"new_grants":0,"standing_at":0}
- Switches after the re-apply: ai_agent_text_enabled=absent, ai_agent_message_enabled=absent, ai_conversation_send_enabled=false → OFF.
- Advisory posttest outcomes (recorded, not a stop): #30 PROPOSED_20261027130000_lc_mcp_acquisition_reads_posttest.sql: ERROR:  42P06: schema "action_gateway" already exists. Why advisory: written for its isolated runner world: it CREATEs schema action_gateway inside its transaction (so it fails wherever link #26 is applied, which #29 / #31 / B require) and asserts the synthetic seeds of lc_mcp_acquisition_reads_emulation.sql (threads 101 / 102 / 107). Its pretest, the apply's own self-check post-condition, its rollback posttest and the fingerprint checks remain stops.

## Census (read-only, aggregates only)

Read-only proof: default_transaction_read_only=on, write probe refused with SQLSTATE 25006. Reader links applied inside the copy: rollback #30 (documented reader order: 1.1 / 1.2 before #30); apply reader 1.1 conversation intelligence; apply reader 1.2 corpus census; re-apply #30 after the reader chain.

| Measure | Count |
|---|---|
| Leads (eg_property_facts) | 12 |
| Properties | 12 |
| Unique contacts (distinct numbers, graph ∪ threads) | 10 |
| SMS threads / with inbound / two-way | 9 / 9 / 9 |
| Messages in / out | 10 / 12 |
| Seller spoke last (message log) / >24 h / >7 d / >30 d | 7 / 7 / 2 / 1 |
| … excluding opted-out / suppressed / wrong-number threads | 5 |
| Interest stage labels | 7 |
| Inbound with a price / counter intent; with a dollar amount | 2; 2 |
| Opportunities with asking price / current offer | 2 / 1 |
| Inbound callback requests | 1 |
| Open negotiations / stalled 14 d / stalled 30 d | 2 / 1 / 1 |
| Threads warm or hot | 4 |
| Threads missing a next action (seller spoke last) | 5 (5) |
| Identity conflicts / suppression conflicts | 0 / 1 |
| Active suppression-list rows | 2 |
| Eligibility: eligible / blocked / UNKNOWN | 2 / 4 / 3 |
| Contactable (= eligible only; unknown counted as contactable) | 2 (0) |

- Blocking reasons: {"thread_suppressed":1,"contactability_opted_out":1,"suppression_list_active":2,"phone_status_blocked":2,"contactability_wrong_number":1,"contact_role_not_owner":1,"phone_wrong_number":1,"hold_blocks_ai_action":1}
- Unknown reasons: {"ownership_unconfirmed":2,"line_type_unknown":1}
- Leads by market: {"Synthetic Metro A, TX":8,"Synthetic Metro B, OK":4}; unanswered by market: {"Synthetic Metro A, TX":6,"Synthetic Metro B, OK":1}
- Leads by ZIP (min cell 5): {"(5 group(s) under 5, folded)":12}
- lc_mcp_corpus_census: coverage {"leads":12,"deal_linked":0,"with_thread":9,"equity_known":9,"with_inbound":9,"contacted_90d":8,"last_contact_set":10,"with_property_row":12,"pipeline_stage_set":7,"estimated_value_set":12,"in_campaign_targets":0,"with_phone_on_graph":11,"with_decision_engine":2,"conversation_stage_set":8,"with_sms_eligible_phone":8,"with_fresh_decision_engine":1}; duplicates {"facts_without_property_row":0,"properties_sharing_address":{"groups":1,"properties":2},"phones_on_several_properties":1,"properties_without_facts_row":0,"owners_with_several_properties":{"owners":1,"properties":2},"properties_with_several_threads":0}; contact {"threads_opted_out":1,"threads_suppressed":1,"threads_wrong_number":1,"threads_not_contactable":0,"threads_unanswered_inbound":6,"threads_unanswered_over_7d":2}; columns absent 11.

## Hidden gold (read-only, opaque ids)

Rule `lc_opportunity_rank_v1` over the reader worklist (`recent_inbound`, 365 days); 8 thread(s) analysed in 1 page(s); excluded before ranking {"opted_out":1,"not_owner":1,"negative":1}; categories {"unanswered_interested_seller":2,"interested_seller":1,"unanswered_seller":1,"seller_stated_price":1}.

Eligibility: eligible 1, blocked 2, UNKNOWN 2; contactable 1 (unknown counted as contactable: 0).

| Rank | Thread | Property | Category | Score | Eligibility | Contactable | Next step | Evidence message ids |
|---|---|---|---|---|---|---|---|---|
| 1 | `5e000000-0000-4000-8000-000000000101` | `S01` | unanswered_interested_seller | 100 | eligible | yes | draft_reply_for_human_approval | `5e000000-0000-4000-8000-00000000a012` `5e000000-0000-4000-8000-00000000a014` |
| 2 | `5e000000-0000-4000-8000-000000000102` | `S02` | unanswered_interested_seller | 75 | unknown (ownership_unconfirmed) | no | human_review_eligibility_unknown | `5e000000-0000-4000-8000-00000000a022` |
| 3 | `5e000000-0000-4000-8000-000000000106` | `S06` | interested_seller | 50 | unknown (line_type_unknown) | no | monitor | `5e000000-0000-4000-8000-00000000a062` |
| 4 | `5e000000-0000-4000-8000-000000000105` | `S05` | seller_stated_price | 38 | blocked (hold_blocks_ai_action, hold_active) | no | human_review_blocker | `5e000000-0000-4000-8000-00000000a052` |
| 5 | `5e000000-0000-4000-8000-000000000108` | `S08` | unanswered_seller | 10 | blocked (suppression_list_active) | no | human_review_blocker | `5e000000-0000-4000-8000-00000000a082` |

- the reader worklist covers threads whose last inbound is within 365 days (its bound is 365); older threads are counted by the census (last_inbound_older_than_365d), not ranked.

## Isolated database

- `destroy` PASS at 2026-10-30T05:20:21.381Z: dropped true, database gone true.

## What this does not prove

- Nothing here touched production: every step ran on the isolated local copy named above.
- An eligible verdict is a read of the send-time guard's inputs, not an authorization to contact anyone; unknown is never contactable.
- No message was sent, queued or drafted; no switch or grant was changed.
