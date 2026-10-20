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
| 11 | `PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql` | 8.5.16 mirror of the live body (must precede #12) | " |
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
| 25 (optional) | `PROPOSED_20261019150000_lc_mcp_reader.sql` | LeadCommand MCP 1.0 live mode: the database-role-enforced read-only credential `lc_mcp_reader` (NOLOGIN, no BYPASSRLS, member of no role; `docs/LEADCOMMAND-MCP-1.0.md` §4.2) | **OPTIONAL, separately approved; not needed by any other link.** **Renumbered** from 20261016120000 (collided with #14 conversation_reply_turns); bodies unchanged except their own self-references. Apply only after pg_net is resolved: its self-check refuses (atomically) while PUBLIC can reach schema `net`. Its five operations read functions (rc-8.5.21 MCP tools) read #0 / #15 / #20 / #22 as their owner, but binding happens at call time, so the link does not require them. In the disposable chain it is the LAST link of both release chains: setup `mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_baseline.sql` adds only the MCP read-inventory relations the chain fixtures lack and models the production ACL of the four campaign-graph SECURITY DEFINER functions; the chain posttest `lc_mcp_reader_chain_posttest.sql` calls the five reads AS the role on the real chain objects. It is also the standalone entry `lc_mcp_reader`. Rollback drops exactly what it created; kill switch `revoke lc_mcp_reader from authenticator;`. |
| 26 (optional) | `PROPOSED_20261019160000_action_gateway.sql` | Action Gateway phase 1 (`docs/ACTION-MCP.md`): schema `action_gateway` (agent principals, **standing grants**, intents, immutable authorizations, outcomes, append-only audit, grant events), the scoped execution role `lc_action_gateway` (NOLOGIN, no BYPASSRLS, member of no role; SECURITY INVOKER entry points + lease-bound domain writes), agent-scope operator tasks in `agent.ops_work_item` | **OPTIONAL, separately approved; not needed by any other link; AFTER #25.** Born OFF (`system_control.action_gateway_enabled` absent = every action refused). Like #25 its self-check refuses (atomically) while PUBLIC can reach pg_net (schema `net`). Needs #0, R2 (#1), #2, #3, #7, #15 and #24. Rollback refuses while any intent is pending or any agent-scope operator task exists, drops exactly what it created, restores the two `ops_work_item` CHECKs, and keeps every hold it set (releasing a hold is an operator decision). Kill switch: `revoke lc_action_gateway from authenticator;` and/or delete `action_gateway_enabled`. In the disposable chain it is the LAST link of both release chains (setup `mcp/leadcommand-action-mcp/migrations/test/action_gateway_baseline.sql`: the read-inventory relations + RLS on `system_control`, modelling production); also the standalone entry `action_gateway`. |
| 28 (optional) | `PROPOSED_20261020110000_action_gateway_t34.sql` | Action Gateway T3 / T4 (`docs/ACTION-MCP.md` §9): the handoff / envelope domain writes, envelope-ref authorization (replaces #26's `authorization_guard` body; rollback restores it), seller-action receipts, the R4 ceiling trigger on `seller_offers`, the R5 durable send budget (`negotiation_send_authorization_uses` + `_consume`) | **OPTIONAL, separately approved; AFTER #27** (#27 = `PROPOSED_20261020100000_action_gateway_t2.sql`, on `feat/action-mcp-t2`): adds rows to #27's extension registry, never re-edits its bodies. Needs #19 / #20 (negotiation authority + send authorization). Born OFF (tiers T3 / T4 absent; `negotiation_send_enabled` absent; the executor kind `action_gateway.execute` unarmed). Rollback refuses while a T3 / T4 intent is pending, a receipt is open or a send-budget use exists. LAST link of both release chains (setup adds `mcp/leadcommand-action-mcp/migrations/test/action_gateway_t34_baseline.sql`); also the standalone entry `action_gateway_t34`. |

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
- **lc_mcp_reader (#25) is optional.** Nothing else depends on it, and it is applied only on its own approval. The chain proves three things on the whole rc-8.5.21 schema:
  - its privilege self-check is ok: no PUBLIC-executable definer writer, no egress function, no exposed read;
  - its rollback restores the fingerprint;
  - re-applying it after the rollback works.

  The graph-function fixture carries the live bodies without their ACLs, and PostgreSQL's default PUBLIC EXECUTE made the self-check refuse. Production revoked PUBLIC on those four functions (operator_lockdown 20261003130000, campaign_audience_completeness 20261003220000), so the lc_mcp chain baseline models that. Roles are cluster-global, so both lc_mcp entries first drop a leftover `lc_mcp_reader` role from an earlier test on the same disposable cluster.
- **action_gateway (#26) is optional too, and comes after #25.** It reuses #3's design rule: `conversation_ai_reply_policy` stays service-role only (no RLS policy is added; the gateway reads that one row through an allowlisted STABLE definer function). The chain proves its self-check is ok on the whole rc-8.5.21 schema, its posttest (privileges, tenant isolation, forged digests, the hold blocking a queued row, the emergency stop, approval binding / replay / expiry, resource exclusivity), that its rollback restores the fingerprint, and the re-apply.
- **Not in the chain:**
  - `unlock_stale_jobs_status_predicate` (20261008110000) stays a standalone entry, as in rc-8.5.20.
  - The `requires: prod-shape` entries need a schema snapshot.

## Rollback

Run the rollbacks in reverse order. #0's rollback is NOT part of an rc-8.5.21 rollback in production:
the hotfix owns it, and it refuses while any hold is active.
