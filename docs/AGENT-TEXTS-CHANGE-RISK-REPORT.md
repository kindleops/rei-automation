# Agent texts: change-risk report and deployment sequence (for owner review)

Prepared 2026-10-30. **Nothing is pushed, merged, deployed or applied.**

## Scope

**Branch:** `feat/hidden-gold-operations`. It shares no history with `origin/main`. Its real base is `origin/feat/lc-conversation-intelligence` (pushed).

**The review range** is `origin/feat/lc-conversation-intelligence..HEAD` (46 commits, frozen at `029bcc8c` for re-certification):
- the Operation Hidden Gold links (#29, #30) and their acceptance world;
- the agent-text architecture: Agntei composes, LeadCommand validates and transports;
- the gates found by seven blind evaluation rounds and six real-model end-to-end attempts;
- the 2026-10-30 hardening listed below.

**Working tree:** clean. The only stray change, a regenerated `apps/api/.deploy-build-timestamp`, was restored.

## Architecture as built (verified by an independent read-only review)

**Agntei composes every agent text.** LeadCommand never writes or rewrites one:
- the `agentText` executor builds no model client;
- the two old composer actions answer `AGENT_COMPOSES_TEXT` at four layers: gateway, database, worker and MCP tool list;
- at dispatch, the body must hash-match its immutable ledger record.

**LeadCommand enforces everything else, and re-checks it** at request, at handoff, in the worker and at dispatch:
- credential and tenant;
- grant and standing grant;
- lead ownership (one holder);
- eligibility, suppression, opt-out and STOP;
- the recipient's local window;
- caps;
- both emergency stops;
- content validation;
- idempotency;
- one answer per inbound message;
- attribution kept in the AI ledger.

**LeadCommand's own AI stands down** on a lead an agent holds. That covers the shadow, turn and decide paths, review drafts, and the AI reply row gate.

## Hardening on 2026-10-30, from the independent review and blind evaluation v7

| Change | Risk it closes | Direction |
|---|---|---|
| `draft_seller_reply` is refused to any agent holding the agent-text grant | LeadCommand's writer drafts a text that the agent then sends under its own name | narrows |
| An agent text needs an explicit contact scope (`AGENT_TEXT_SCOPE_NOT_SET`) | An unset scope meant every lead the grant allows | narrows |
| Agent texts expire after 2 h at dispatch (`agent_text_expired`) | A text queued before an emergency stop or outage would go out when the runner resumed | narrows |
| On a lead an agent holds, template rows are cancelled (`template_row_lead_held_by_agent`); manual operator sends pass | A campaign or template follow-up and an agent text both reach the same seller | narrows |
| #32's "born OFF" post-condition now fires if a switch was already on | The path could go live the moment it was applied | narrows |
| Landlord-owner ("I rent it out") is no longer read as a non-owner; renters still are | A compliant reply to an owner was stopped | loosens one false positive (tested both ways) |
| "You mentioned … later in the year" counts as a timeline attribution, still checked against the ledger | A truthful re-engagement was refused | loosens one false positive |
| "unsubscribe" misspelled by one letter is an opt-out | A misspelled opt-out read as unclear | narrows |
| #31 has a runner entry, a pre-test, a post-test that proves it is born OFF, and a rollback post-test | #31 was never rehearsed | test only |

**Kept on purpose:** the gate refuses a timeline question after the seller said "no rush" (blind v7 Z37). That is a stated timeline, and asking again is the rule working.

## Database migrations in the range (all `PROPOSED_*`, each with a rollback)

| Link | File | Pre / post / rollback tests | Disposable PG 17 full cycle* |
|---|---|---|---|
| #29 OHG | `PROPOSED_20261027120000_action_gateway_ohg.sql` | yes | PASS |
| #30 acquisition reads | `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql` | yes | PASS |
| #31 standing reply | `PROPOSED_20261028100000_action_gateway_standing_reply.sql` | yes (added 2026-10-30) | PASS |
| Ledger kind (A) | `PROPOSED_20261029090000_ai_generated_outbound.sql` | yes | PASS |
| #32 agent messages (B) | `PROPOSED_20261029100000_action_gateway_agent_message.sql` | yes | PASS |

\*A full cycle is: pretest, apply, posttest, rollback, rollback posttest, identical schema fingerprint, then re-apply and posttest.

**Prerequisites:** #26, #27 and #28, the AI-message ledger (`PROPOSED_20261015130000`), and their chains. Whether any of these are applied in production is **unknown from here**. The read-only verification query in `docs/AGENT-MESSAGES-MIGRATION-PLAN.md` §1 answers it.

**Rollback limits:**
- **A** cannot be fully reversed once any `agent_text` record exists. It refuses rather than drop evidence.
- **B's** rollback leaves #26's authority CHECK `NOT VALID` if standing authorizations exist (they stay as history).
- `agent_text_*` ledger rows survive a rollback.

## Certification on the frozen versions (2026-10-30)

LeadCommand code at `c0f62de4`, with agntei at `9ed43f1`. Every result below used a disposable world and the SIMULATED provider.

| Evaluation | Result | Evidence (agntau `docs/acquisitions-certification/`) |
|---|---|---|
| Scripted certification, run 15 | 34/34, inside the lawful window | `run-15/` |
| Real-model end-to-end, e2e-9 | 20/20, all 10 steps and every negative | `realmodel-e2e-9/` |
| Blind safety evaluation v8, run 3 (56 held-out items, independent author and grader) | 0 safety-critical at the system level; 1 at the agent level, refused by agntei | `blind-v8/run-3/` |

## Open findings (accepted with a control, or for later)

| Finding | Severity | Control until fixed |
|---|---|---|
| **Seller-fact extraction misses some of the seller's own words.** "still mine" and "still own it" yield no ownership fact, and "this winter" and similar dated or seasonal timelines yield no timeline. The ledger checks then refuse truthful "thanks for confirming…" and "…about this winter" replies (blind v8 Z15, Z30; e2e-9). | quality (safe direction: a reply is refused, never sent wrongly) | None needed for safety. A warm seller may get no answer. The fix changes `extract-seller-facts.js` (and with it LeadCommand's own urgency and ownership facts for every lead), so it needs owner review and a new certification cycle. |
| Re-engagement wording: "after the holidays" is not an attribution topic, and a passed time reference is refused (blind v8 Z53) | quality | Same as above |
| An expired lead lease hands the lead back to LeadCommand's own AI | medium | Keep `ai_conversation_send_enabled` **off** (deployment invariant §3 step 4); LeadCommand's AI is not on the agent path at all |
| An answer inside the 30-minute in-session window can go outside 08:00–21:00 | low | This is the owner's earlier ruling. **Confirm it also applies to agent-written texts.** |
| Handoff and transfer take different advisory locks | low | The worker and dispatch re-check the holder |
| The text body is stored before policy runs (append-only submissions) | low | Nothing is sent; the store is evidence only |
| The worker's money re-check is weaker than the handoff's | low | Agents hold no negotiation authority in the canary |
| `lc_agent_lead_holder` ignores the org | low | A single org |
| OHG lead-state writes don't check the holder | low | Internal records only, never seller-facing |

## Deployment sequence (every step is the owner's)

1. **Review.** The owner reviews this range. With authorization, it is pushed to a dedicated remote branch (`review/agntei-agent-texts`, based on `origin/feat/lc-conversation-intelligence`). Nothing is merged.
2. **Production prerequisites (read-only).** Run the §1 query of the migration plan on production. Any `false` stops the sequence; a missing link goes first, through its own plan.
3. **Clone rehearsal.** Restore a recent production backup to a disposable database. Then:
   - run the §1 query;
   - apply, in order: #29, #30, #31, A, B, each with its pretest and posttest;
   - roll everything back and compare the schema fingerprint;
   - re-apply.

   The read-only census (Phase 2) runs on this same clone.
4. **Switches before apply, on production:**
   - `ai_agent_text_enabled` absent or `false`;
   - `ai_agent_message_enabled` absent or `false`;
   - `ai_conversation_send_enabled` `false`.

   B's post-condition now refuses the apply otherwise.
5. **Deploy the code.** It is inert without the links.
6. **Apply to production:** #29, #30, #31, A, B in a quiet window. Verify V-A, V-B and V-OFF, then watch 24 h with everything off.
7. **Activation, for the Phase 5 test and then the canary:**
   1. read grants;
   2. `assign_lead` and `release_lead` for the representative, and `transfer_lead` for the head;
   3. company identity;
   4. `ai_conversation_send_policy.scope.thread_keys`, set to exactly the designated test phone, later to the canary's contacts (`enabled: false`);
   5. a small `ai_agent_text_policy` (for example `max_per_day_global` 10);
   6. `ai_agent_text_enabled = 'true'`;
   7. `conversation.queue_agent_text` per use only (supervised: a person approves each text).

   **No standing seller-facing grant.**
8. **Real carrier check (Phase 5):** one Agntei-written text to the owner's designated test phone. Then a reply, the receipt, attribution and status. Then an emergency-stop drill.
9. **Canary (Phase 6):** add about 10 independently verified Indianapolis contacts to the scope and keep supervised mode.

**Brakes at any time:**
- LeadCommand's R2 emergency stop;
- the queue stop;
- `ai_agent_text_enabled = 'false'`;
- emptying the scope;
- revoking the grant.
