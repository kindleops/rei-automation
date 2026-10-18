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
- **Not in the chain:**
  - `unlock_stale_jobs_status_predicate` (20261008110000) stays a standalone entry, as in rc-8.5.20.
  - The `requires: prod-shape` entries need a schema snapshot.

## Rollback

Run the rollbacks in reverse order. #0's rollback is NOT part of an rc-8.5.21 rollback in production:
the hotfix owns it, and it refuses while any hold is active.
