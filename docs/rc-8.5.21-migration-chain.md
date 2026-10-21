# rc-8.5.21 PROPOSED migration chain

Every file below is PROPOSED. Nothing in this release applies, enables or arms anything by itself.
Each production apply needs its own owner authorization (owner boundary 2026-10-15: production is
read-only for agents; migrations, pretests and rollbacks run on a disposable database only).

The order is proven as ONE chain on a disposable PostgreSQL 17 by
`scripts/db/run-migration-test.mjs --id rc_8_5_21_release_chain` (part of `--all`): setup, then each
file's own pretest right before it, then apply, verify (`supabase/tests/rc_8_5_21_release_chain_verify.sql`)
and every posttest on the final state. Then all rollbacks run in reverse order and must restore the
exact pre-chain schema fingerprint. Then the whole chain is re-applied and re-verified.

## Production apply order

| # | File (supabase/migrations/) | Release | Status |
|---|---|---|---|
| 0 | `PROPOSED_20261016200000_automation_holds_registry.sql` | P0 holds (rc-8.5.20-holds = hotfix/automation-holds) | **ALREADY APPLIED VIA HOTFIX** before rc-8.5.21 deploys. Byte-identical to the hotfix file. Kept first in the disposable chain so every later file and rollback is proven against the hold triggers. Do not re-apply: its precondition refuses an existing registry. |
| 1 | `PROPOSED_20261012140000_intel_runtime.sql` | R2 runtime | in chain since rc-8.5.20 |
| 2 | `PROPOSED_20261013120000_agent_capabilities.sql` | capabilities | " |
| 3 | `PROPOSED_20261013160000_conversation_ai_shadow.sql` | conv-AI shadow | " |
| 4 | `PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql` | 8.5.15 | " |
| 5 | `PROPOSED_20261013161000_conversation_decide_event_budget.sql` | 8.5.15 (needs #4 despite its stamp) | " |
| 6 | `PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql` | 8.5.15 | " |
| 7 | `PROPOSED_20261014120000_persistent_missions.sql` (+ seed `…120100_persistent_missions_schedules.sql`) | 8.5.18 | " |
| 8 | `PROPOSED_20261015130000_message_origin_ai_generated_messages.sql` | 8.5.16 | " |
| 9 | `PROPOSED_20261015190000_negotiation_authority.sql` | 8.5.19 | " |
| 10 | `PROPOSED_20261015191000_ai_operator_feedback.sql` | 8.5.19 | " |
| 11 | `PROPOSED_20261015110000_block_repeat_asking_price_mirror.sql` (**renumbered** from 20261014120000, which #7 also used) | 8.5.16 mirror of the live body (must precede #12) | " |
| 12 | `PROPOSED_20261015120000_repeat_asking_price_question_kind.sql` | 8.5.15.1 | " |
| 13 | `PROPOSED_20261016100000_zip_acquisition_intelligence.sql` (+ seed `…100100_property_research_schedules.sql`) | 8.5.20-b | " |
| 14 | `PROPOSED_20261016120000_conversation_reply_turns.sql` (+ seed `…120100_conversation_reply_turns_schedules.sql`) | 8.5.20-a: creates `agent.runtime_enqueue_event_at` | " |
| 15 | `PROPOSED_20261016140000_operations_action_center.sql` (+ seed `…140100_operations_schedules.sql`) | 8.5.20-c | " |
| 16 | `PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql` | 8.5.21-a | new |
| 17 | `PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner.sql` | 8.5.21-a recontact guard (graph side) | new; **renumbered** from 20261016160000 |
| 18 | `PROPOSED_20261016160000_runtime_event_budget_ceilings.sql` | 8.5.21-b: **re-creates** `runtime_enqueue_event` + `runtime_enqueue_event_at` | new |
| 19 | `PROPOSED_20261016161000_negotiation_send_authorization.sql` | 8.5.21-b | new |
| 20 | `PROPOSED_20261016162000_ops_research_valuation_snapshot.sql` | 8.5.21-b | new |
| 21 | `PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql` | owner decision 2026-10-17: the `ownership_declined_unverified` role | new |
| seed | `PROPOSED_20261016163000_followup_execution_schedules.sql` | 8.5.21-a follow-up pipeline schedules (born DISABLED; `psql -v owner_id=…`) | new; **renumbered** from 20261016161000. Exercised by its posttest after #18. |
| 22 | `PROPOSED_20261017120000_followup_intent_lifecycle.sql` | P0 2026-10-17 follow-up execution lifecycle: `followup_intents` + audit, materialize-before-claimable, send_queue ⇄ intent sync, `follow_up_at` projection (live-only guards, born OFF) | new; LAST link, after `PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql` (needs #0, send_queue, inbox_thread_state). Also a standalone entry `followup_intent_lifecycle`. Also on `hotfix/followup-materialization` (byte-identical). |
| 23 | `PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql` | owner directive 2026-10-17 ("no duplicate response to the same inbound turn"): the turn dispatch lease (`dispatch_*` columns, finalize re-created to hand the claimant the lease, `conversation_reply_turn_dispatch_claim` / `_dispatch_done`), the `send_queue_ai_turn_uq` backstop (one `ai_generated` row per `metadata.turn.turn_id`), and `agent.runtime_finish(…, p_retry_after_seconds)` | new; after #14 and #8; the LAST link (after the follow-up lifecycle #22, whose stamp 20261017120000 it originally collided with: renumbered). Precondition RAISEs if production already has two ai_generated rows for one turn. Rollback restores the rc-8.5.20 finalize body exactly (fingerprint-proven) and refuses while a dispatch lease is live. |
| 24 | `PROPOSED_20261017122000_conversation_turn_operator_items.sql` | blind-eval D3: scope `conversation` for `agent.ops_work_item`; `agent.ops_scope_of_kind('conversation.turn')` → `conversation` (an R3 hold raises one operator item per turn through the existing lease-bound writer) | new; after #15 (operations_action_center). Rollback refuses while any conversation-scope item exists. |
| 25 | `PROPOSED_20261019120000_payload_clean_opaque_ids.sql` | rc-8.5.21 (finding_doc_check defect): `agent.payload_string_violation` masks DELIMITED canonical UUID tokens and lettered hex ids of 20-128 characters before the phone-run heuristic, so a random id is never read as a phone (it was 923 / 10,000 random UUIDs; a recovery-sweep finding could be refused and lost) | new; needs only S3 (`PROPOSED_20261010120000`, already applied in production), so it is independent of #0-#24 and is placed after #24 by stamp. Only more permissive for id tokens, so every existing row still satisfies every CHECK. Rollback restores the S3 body byte-for-byte; rollback posttest `…_rollback_posttest.sql`. Also a standalone entry. |
| 26 (optional) | `PROPOSED_20261019150000_lc_mcp_reader.sql` | LeadCommand MCP 1.0 live mode: the database-role-enforced read-only credential `lc_mcp_reader` (NOLOGIN, no BYPASSRLS, member of no role; `docs/LEADCOMMAND-MCP-1.0.md` §4.2) | **OPTIONAL, separately approved; not needed by any other link.** **Renumbered** from 20261016120000 (collided with #14 conversation_reply_turns); bodies unchanged except their own self-references. Apply only after pg_net is resolved: its self-check refuses (atomically) while PUBLIC can reach schema `net`. Its five operations read functions (rc-8.5.21 MCP tools) read #0 / #15 / #20 / #22 as their owner, but binding happens at call time, so the link does not require them. In the disposable chain it is the LAST link of both release chains: setup `mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_baseline.sql` adds only the MCP read-inventory relations the chain fixtures lack and models the production ACL of the four campaign-graph SECURITY DEFINER functions; the chain posttest `lc_mcp_reader_chain_posttest.sql` calls the five reads AS the role on the real chain objects. It is also the standalone entry `lc_mcp_reader`. Rollback drops exactly what it created; kill switch `revoke lc_mcp_reader from authenticator;`. |

The schedule seeds take `psql -v owner_id=<owner auth uuid>` and carry their own BEGIN/COMMIT. Every
schedule is created with `enabled = false`. Their posttests run the same statements inside
BEGIN … ROLLBACK.

## Integration notes

- **One final `agent.runtime_enqueue_event_at`.** #14 creates it and #18 re-creates it with the same body,
  except the hard-coded 0.05 clamp becomes `agent.runtime_event_budget_ceiling(p_kind)`. The ceilings
  default to `{}`, so the clamp is still 0.05 for every kind. 8.5.21-a never redefines it; it only calls
  it, through the follow-up seed and its posttest. The chain verify asserts that each enqueue function
  has exactly one overload and that the final bodies are #18's. It also asserts the 8.5.20-a
  `p_not_before` contract survives. The follow-up posttest runs after #18 and still sees an unarmed
  `followup.dispatch` refused (`kind_not_armed`).
- **Version-stamp collisions fixed.** Two pairs of 8.5.21-a / 8.5.21-b files shared one stamp:
  - 160000: campaign_graph vs runtime_event_budget_ceilings
  - 161000: followup_execution_schedules vs negotiation_send_authorization

  The 8.5.21-a files were renumbered (155000 / 163000); their bodies are unchanged except their own
  self-references.
- **The holds registry's stamp (20261016200000) is later than the 8.5.21 files.** It is the hotfix's file,
  kept byte-identical. It is applied first because production receives it with the hotfix.
- **The Hartford / Maxwell hold rows** (`PROPOSED_hartford_hold.sql`, `PROPOSED_maxwell_hold.sql`, P0 holds
  package) are production data migrations of the hotfix, not part of this chain.
- **lc_mcp_reader (#26) is optional.** It was integrated as #25 on rc-8.5.21-mcp; the final integration renumbered the doc ordinal to #26 because `payload_clean_opaque_ids` (rc-8.5.21-cont, stamp 20261019120000) precedes it. Neither stamp nor any body changed. Nothing else depends on it, and it is applied only on its own approval. The chain proves three things on the whole rc-8.5.21 schema:
  - its privilege self-check is ok: no PUBLIC-executable definer writer, no egress function, no exposed read;
  - its rollback restores the fingerprint;
  - re-applying it after the rollback works.

  The graph-function fixture carries the live bodies without their ACLs, and PostgreSQL's default PUBLIC EXECUTE made the self-check refuse. Production revoked PUBLIC on those four functions (operator_lockdown 20261003130000, campaign_audience_completeness 20261003220000), so the lc_mcp chain baseline models that. Roles are cluster-global, so both lc_mcp entries first drop a leftover `lc_mcp_reader` role from an earlier test on the same disposable cluster.
- **Final integration stamp audit (2026-10-19 / 2026-10-20).** Supabase migration history keys on the VERSION, so
  two files with one stamp collide on a production apply. Resolved from VERIFIED production history: Supabase
  `list_migrations` (read-only metadata), retrieved 2026-10-20 and saved at
  `tmp/rc821-cert/prod-migration-history-20261020.md` in the integration job. That history is INCOMPLETE:
  out-of-band applies (intel_runtime via psql on 10-14; agent_s3_persistence and agent_research_ro on 10-11) are
  not recorded, so being absent from it does not prove a migration is unapplied. An applied production migration
  is never renamed.
  - The merges added 20261019120000 (#25) and 20261019150000 (#26). Neither collides. The hotfix stamps
    20261016200000 (#0) and 20261017120000 (#22) are unchanged.
  - Chain collisions, renamed (neither file is applied in production; of this chain only intel_runtime is):
    - 20261014120000 was #7 and #11. #11 block_repeat_asking_price_mirror (+ pretest and posttest) is now
      **20261015110000**: after #7, still before #12. Only self-references changed.
    - 20261013160000 was #3 and an out-of-chain file. `inbox_thread_state_recency_index` (PROPOSED,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, idempotent) is now **20261013163000**, with the body unchanged.
  - Legacy collisions outside the chain:
    | Stamp | Members | Evidence | Resolution |
    |---|---|---|---|
    | 20261007170000 | entity_graph_distress_indexes / graph_sender_coverage_routing_v2 | production RECORDS entity_graph_distress_indexes as **20261007170001** | the repo file is renamed to 20261007170001 to match; routing_v2 keeps 170000 |
    | 20261007120000 | campaign_audience_field_values (06:51) / queue_health_overdue_semantics (07:00, later-added) | neither recorded; no out-of-band evidence in repo docs, RC reports, STATUS ledger or memory | queue_health_overdue_semantics (+ rollback) is now **20261007120500**: before 20261007121000 terminalize, which it precedes |
    | 20261006150000 | price_reality_check_templates (10-06) / command_wall_displays (10-11) | command_wall_* APPLIED out of band (STATUS 2026-10-11 20:25Z). price_reality_check_templates **VERIFIED unapplied** by a read-only production check on 2026-10-20 (`tmp/prod-readonly-20261020/RESULTS.md`): 0 `sms_templates` rows by use_case or template_id prefix, 0 `send_queue` references | **price_reality_check_templates (+ rollback) renamed to 20261006150200**, its feat-branch name; command_wall_displays keeps 150000 (applied, never renamed). **Resolved** |
    | 20261010120000 | agent_s3_persistence / inbox_price_gap_gate | both **APPLIED**. S3 out of band on 10-11. price_gap_gate: the owner's apply.sh (`tmp/owner-apply-20261012`), done 2026-10-12, a byte-identical copy of the 5b470fa5 body. VERIFIED read-only on 2026-10-20 (RESULTS.md): `v_inbox_thread_state_buckets` has `in_unclear`, `f_price_gap` and `in_price_gap`; `v_inbox_bucket_counts` has `unclear` and `price_gap`; the production view does **not** map `declined_unverified` (the repo body gained it on 10-17, 31f405e3); dependent views `v_inbox_bucket_counts` and `v_inbox_zero_counts` | **permanent historical collision**, rename neither. Deploy-BLOCKED: the `declined_unverified` mapping needs a NEW forward view migration that also handles both dependent views, never a re-apply of this file |
    | 20261010130000 | agent_research_ro / inbox_pipeline_hygiene_cleanup | both APPLIED (research_ro 10-11; hygiene `updated_by = hygiene_20261010`, follow-up intents in production per followup-reconciliation W5) | **permanent historical collision**, rename neither |
  - `scripts/db/scan-duplicate-migration-versions.mjs` (run by `tests/critical/migration-version-uniqueness.test.mjs`)
    fails on any duplicate version in `supabase/migrations`. Companions (`_pretest`, `_posttest`, `_rollback`,
    `_verify`, `_dryrun`, …) are not duplicates. After the 2026-10-20 production read-only check
    (`tmp/prod-readonly-20261020/RESULTS.md`) the allowlist is exactly two permanent historical collisions,
    20261010120000 and 20261010130000. It can only shrink, because a stale entry fails.
  - The apply order is this table, not the stamp sort.
- **Not in the chain:**
  - `unlock_stale_jobs_status_predicate` (20261008110000) stays a standalone entry, as in rc-8.5.20.
  - The `requires: prod-shape` entries need a schema snapshot.

## Deploy notes (production history check, 2026-10-20)

- **No chain link collides with a recorded production version.** None of the chain stamps #0–#26 (20261012140000 …
  20261019150000) is recorded in production history. #1 intel_runtime is applied (out of band, 10-14) but not
  recorded. #0 is applied via the hotfix. The renamed stamps (20261015110000, 20261013163000, 20261006150200) are
  unused in production history.
- **The two permanent collisions (20261010120000, 20261010130000) are EXCLUDED from every deploy plan.** Every member
  is applied, so none is ever applied or re-applied. The production `v_inbox_thread_state_buckets` lacks the
  `declined_unverified` mapping (verified read-only 2026-10-20). It needs a new forward view migration that also
  rebuilds the dependents `v_inbox_bucket_counts` and `v_inbox_zero_counts`. That migration is
  **`PROPOSED_20261020120000_inbox_bucket_views_declined_unverified.sql`** (rc-8.5.21 v4), a standalone entry
  `inbox_bucket_views_declined_unverified` outside the release chain. It uses `CREATE OR REPLACE` only, so both
  dependents keep their column contract in place. An md5 precondition refuses any body other than production's
  10-10 body (edba02b9… / 140bccf2…, verified read-only 2026-10-20), and its rollback restores that body.
  Production order: apply it after #21 (`PROPOSED_20261017100000`, the role) and before the
  `PROPOSED_20261017110000` disposition backfill. That backfill refuses by its own precondition until the view
  maps `declined_unverified`. Its stamp 20261020120000 is unique and not recorded in production history.
- **The 2026-10-18 spatial_ref_sys migrations are recorded production history**: see the next section. They are
  never applied.
- A production apply records each migration under its file stamp. Before applying, re-read `list_migrations`
  (read-only) and confirm the next stamp is not already recorded.

## Recorded production history (APPLIED IN PRODUCTION, never re-applied)

| Version / file (supabase/migrations/) | Applied | Source | Effect |
|---|---|---|---|
| `20261018040156_revoke_public_writes_spatial_ref_sys.sql` | 2026-10-18T04:01:55Z | Claude Code session in the Prominent Cash Offer website project (transcript 0310cd0a), Supabase MCP `apply_migration`, after an interactive approval recorded at 04:01:39Z | **Ineffective.** The anon/authenticated write grants are supabase_admin's, so postgres cannot revoke them; the session's own check at 04:02:08Z still showed anon INSERT/UPDATE/DELETE/TRUNCATE true |
| `20261018040244_guard_spatial_ref_sys_against_api_writes.sql` | 2026-10-18T04:02:43Z | same session | **Effective.** `public.block_api_role_writes()` plus two statement-level triggers refuse writes as anon/authenticated (42501). Re-tested 04:09Z and 07:27Z: writes refused, SELECT works, 8500 rows intact, ST_Transform works. The durable fix is still a Supabase support request (SEC-02) |

- Each file holds a header, then the applied SQL byte-for-byte between BEGIN/END markers (sha256 pinned).
- `scripts/db/applied-in-production.mjs` registers both as `applied_in_production: true`, and the manifest re-exports
  that list.
- `scripts/db/run-migration-test.mjs` refuses any entry that names one, and refuses to apply one by path or by
  header marker, before any database is touched.
- `tests/critical/applied-in-production-history.test.mjs` pins the bytes, the manifest exclusion, the runner refusal,
  and the absence of any workflow, script or apply-order reference.
- Rollback: the first needs none. Rolling back the second re-opens anonymous writes to PostGIS's coordinate table:
  owner approval only.

## Rollback

Run the rollbacks in reverse order. #0's rollback is NOT part of an rc-8.5.21 rollback in production:
the hotfix owns it, and it refuses while any hold is active.
