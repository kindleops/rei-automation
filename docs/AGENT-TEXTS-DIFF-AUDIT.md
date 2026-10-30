# Agent texts: exact diff and migration audit

Prepared 2026-10-30 for the owner's review of `origin/review/agntei-agent-texts`. **Nothing is merged, deployed or applied.**

## Range

| | |
|---|---|
| Base | `origin/feat/lc-conversation-intelligence` = `fde1f0b9d6a48aa67f275e9991a0d5cfc9fdda3d` |
| Head (pushed review branch) | `origin/review/agntei-agent-texts` = `edad38e67645eb89030054b866e560211c3e397e` |
| Commits | 48 |
| Size | 148 files, +17,894 / −115 lines |
| Frozen certification code | `c0f62de4`. `edad38e6` only adds a report section on top of it. |

**Certification evidence for this exact code** is kept in agntau `docs/acquisitions-certification/`:
- scripted run 15: 34/34;
- real-model e2e-9: 20/20;
- blind v8 run 3: 0 safety-critical at the system level.

Every result was taken with agntei `9ed43f1`.

`origin/feat/hidden-gold-operations` (`31eb0be7`) is an ancestor of the head, so the review branch contains it unchanged.

## What changes in existing production code

**36 existing source files are modified:** 33 under `apps/api/src` and 3 under `mcp/*/src`. 16 new source files are added. The rest of the diff is tests, fixtures, docs and the `PROPOSED_*` migrations. **No existing migration file is modified or deleted.**

### LeadCommand's live SMS path

| File | Change | Effect while the new links are unapplied / switched off |
|---|---|---|
| `lib/domain/queue/process-send-queue.js` (+89/−1) | Adds three row gates before dispatch: the agent-text gate, the agent-message gate and the agent-held-template gate | Agent-text and agent-message rows cannot exist without links A and B. The template gate only cancels a template row whose lead an agent holds, and holders exist only with link B. |
| `lib/supabase/sms-engine.js` (+12/−0) | The blank-greeting rule is skipped only for an agent's exact text (`agent_text_exact_body`); every other content guard applies | None. Only agent-text rows set the flag. |
| `lib/providers/textgrid.js` (+9/−2) | A carrier verdict on an agent's text is written to the agents' event feed; `resolveSender` is exported | The feed write runs only for rows that carry `agent_text_intent_id`. It never blocks the webhook and never resends. |
| `lib/flows/handle-textgrid-inbound.js` (+19/−0) | Every inbound message also appends an `inbound_message` (and, if it is a STOP, an `opt_out`) event to the agents' feed | It is wrapped in try/catch, idempotent per inbound message, and stores ids and codes only. **It needs table `action_gateway.lead_events` (link B); before B is applied, the append fails quietly and logs `lead_event_append_failed`.** |
| `lib/domain/campaigns/enqueue-campaign-target-one.js` (+1/−1) | Exports one helper | None |

### Classification (affects every inbound message once deployed: narrows only)

| File | Change |
|---|---|
| `classification/classify.js` (+12/−1) | SMS shorthand is normalized before opt-out detection: "txt" reads as "text", "this #" as "this number", "agian" as "again". |
| `classification/multilingual-opt-out.js` (+4/−2) | A misspelled "unsubscribe" is an opt-out. Bare Spanish and Portuguese imperatives that are the whole message are a STOP: "para", "alto", "basta", "detente", "cancela", "no más", "chega". |

Both changes can only produce more opt-outs, never fewer.

### LeadCommand's own AI and the Action Gateway

Every other change sits behind the Action Gateway or LeadCommand's conversation AI, both of which are off in production:
- the `agent-text` and `agent-message` actions and validator (`agent-text-validator.js`, `writer-safety.js`, `outreach/agent-text.js`, `outreach/agent-message.js`);
- the stand-down of LeadCommand's AI on agent-held leads (`ai/agent-lead-stand-down.js` and four wiring files);
- the composer-tool retirement (`AGENT_COMPOSES_TEXT`);
- the OHG lead-state writes;
- the read tools in both MCP servers;
- `outbound-validator.js` (+17/−5): the landlord-owner and "later in the year" false positives, both tested in both directions;
- `extract-seller-facts.js` (+3/−1): "I rent it out" is no longer read as a non-owner.

## Migrations (all `PROPOSED_*`, none applied anywhere but disposable databases)

| Link | File | SHA-256 | Lines | Creates or changes | Rollback (SHA-256) | Runner id |
|---|---|---|---|---|---|---|
| #29 OHG | `PROPOSED_20261027120000_action_gateway_ohg.sql` | `3f76b0e6c0d8d184a91a53ef3dd5d187ee11858a72d69a7ef7b50467b796fda7` | 231 | Tables `action_gateway.lead_annotations` (an immutability trigger and a unique intent index) and `action_gateway.ohg_restore`; functions `action_gateway_annotations`, `action_gateway_dw_ohg`, `action_gateway_reply_status`; catalog rows | `fb24555568e7…` | `ohg` |
| #30 acquisition reads | `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql` | `10ec163f8d82df7c81e7ca64548f2aa6b974f3fbc8a9d7a4a4551e38b24010fe` | 469 | Read-only functions `lc_mcp_thread_offers`, `_followups`, `_execution_log`, `_contact_eligibility`, `lc_mcp_operator_tasks` | `e124785fa75c…` | `lc_mcp_acquisition_reads` |
| #31 standing reply | `PROPOSED_20261028100000_action_gateway_standing_reply.sql` | `2e054bfdad4438df30b816d7c2d336d12f2cbcddb35c83a859a8649cb4b88f18` | 256 | Standing-authority columns on `capability_grants` and `action_authorizations`; the trigger `ab_standing_authority`; `standing_authority()`, `standing_reply_refusal()`; replaces `grant_refusal`, `action_gateway_principal`, `action_gateway_dw_handoff`, `lc_seller_action_load`; **drops and re-adds the `action_authorizations` check constraint** | `c3b925a1e26d…` | `action_gateway_standing_reply` |
| A ledger kind | `PROPOSED_20261029090000_ai_generated_outbound.sql` | `64537ccfe7eef2f526ba11db773c1d37d1b4c355695a3ec8be1c017e8940dc33` | 90 | **Drops and re-adds four `ai_generated_messages` check constraints** so they admit the `agent_text` kind and the agent's attribution | `be12377bbe27…` (refuses once any `agent_text` row exists) | `ai_generated_outbound` |
| #32 agent messages (B) | `PROPOSED_20261029100000_action_gateway_agent_message.sql` | `cb34b2dcae8912266784931a2b1f3369c01cf0f98b302bd645c1313885605178` | 1,425 | Tables `lead_events`, `lead_assignments`, `agent_text_submissions`, `agent_message_restore`; the receipt function; the queue functions for agent texts and messages; switches stay born OFF (the post-condition raises if not) | `61b0e9ba3393…` | `action_gateway_agent_message` |

**Every link has a pre-test, a post-test, a rollback and a rollback post-test.** All five pass the full cycle on disposable PostgreSQL 17: pretest, apply, posttest, rollback, rollback posttest, identical schema fingerprint, re-apply, posttest. The commands are in `scripts/db/migration-tests.manifest.mjs`.

**Grants:**
- New tables revoke `public`, `anon`, `authenticated` and `service_role`.
- New functions grant execute to exactly one of these roles:
  - `lc_mcp_reader`: the #30 reads;
  - `lc_action_gateway`: the gateway's functions;
  - `service_role`: LeadCommand's own worker and webhook functions in B (`lc_agent_text_*`, `lc_agent_message_*`, `lc_lead_event_append`, `lc_agent_lead_holder`) and the re-created receipt writer, keeping #28's privileges.
- `anon` and `authenticated` get nothing.

**Order and prerequisites:** #26, #27, #28 and the AI-message ledger (`PROPOSED_20261015130000`) must already be in production. The read-only query in `docs/AGENT-MESSAGES-MIGRATION-PLAN.md` §1 answers this. Then apply #29, #30, #31, A, B.

**Before any of this reaches production:**
1. The inbound feed append (`handle-textgrid-inbound.js`) depends on link B. Either deploy the code after B is applied, or accept that `lead_event_append_failed` warnings appear until then (no functional effect).
2. A cannot be rolled back once an `agent_text` row exists. It refuses rather than discard evidence.
3. #31 and A rewrite check constraints. On a large `ai_generated_messages` table, the re-add validates every row. Time it on the production-copy rehearsal (`docs/PRODUCTION-COPY-REHEARSAL.md`).
