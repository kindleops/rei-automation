# LeadCommand × agntei — conversation intelligence (MCP 1.1)

Status: **implemented on `feat/lc-conversation-intelligence`; nothing applied to production; no message sent.**
The database migration is `PROPOSED` and separately approvable. The R2 production emergency stop, the send flags
(`ai_conversation_send_enabled`, `ai_conversation_send_policy`, `queue_emergency_stop_at`) and every seller-sending
safeguard are untouched by this work.

| Phase | Deliverable | State |
|---|---|---|
| 1 | Read-only conversation tool `leadcommand_get_lead_conversation` + its definer projection | built, tested on PostgreSQL + real PostgREST |
| 2 | Worklist, ranked opportunities, exact pipeline counts + integrity signals | built, tested |
| 3 | Investigation runbook for 2109512384, 2100284187, 2109529773, 2100303162 | built, demonstrated on fixture; **live run is the owner's** (§5) |
| 4 | Autonomous seller conversations: readiness on the existing Action Gateway / R3 | gap analysis + canary plan; **not certified, not activated** (§7) |
| 5 | Scheduled Sterling missions (Sterling, Scout, Equity, Haven, Atlas) | 10 agntei routines, validated by the real agntei engine (§8) |

## 1. What the audit found (Phase 1)

Message storage, as the code and migrations record it:

- `public.message_events.message_body` holds the text of **both** directions; `direction` is `inbound` / `outbound`.
- `thread_key` is the seller's E.164 phone: **one thread per phone, across properties**. `inbox_thread_state` is unique on
  `thread_key` (uuid `id`) with ONE `property_id` slot (last writer wins) and **no index on `property_id`**.
- Property attribution: outbound rows copy `property_id` from the queue; **inbound attribution is heuristic**. So a phone
  can carry messages about several properties — the tools count those rows and never return them for another lead.
- Order: an inbound row's `event_timestamp` / `received_at` are **rewritten by the handler's second pass** with processing
  time (`handle-textgrid-inbound.js`). `created_at` (the first write) is the truthful receipt order; the tools order by
  `created_at, id` and report both.
- Unknown-sender inbound rows have no `thread_key`, only `from_phone_number`: attributed `by phone`.
- Delivery: `delivery_status` (sent / delivered / failed), `provider_delivery_status`, `is_final_failure`, timestamps.
- Opt-out: `is_opt_out` / `detected_intent = opt_out`; `sms_suppression_list` unique on (`phone_e164`, `sender_phone_e164`).
  The live authority is `evaluateCanonicalContactability` + the send-time guard + `automation_holds`.

## 2. The tools (all READ, all opt-in scopes)

| Tool | Scope | Database function (STABLE SECURITY DEFINER, `search_path=pg_catalog`, static SQL, bounds → 22023) |
|---|---|---|
| `leadcommand_get_lead_conversation` | `leadcommand.conversations.read` | `lc_mcp_lead_conversation(text, uuid, int, timestamptz, text, int)` |
| `leadcommand_search_conversation_worklist` | `leadcommand.conversations.read` | `lc_mcp_conversation_worklist(text, int, text, timestamptz, uuid, int)` |
| `leadcommand_get_opportunity_ranking` | `leadcommand.conversations.read` | (bounded batch over the worklist: ≤ 4 pages, ≤ 100 threads) |
| `leadcommand_get_pipeline_summary` | `leadcommand.pipeline.read` | `lc_mcp_pipeline_counts(text, text, text, int)` + `lc_mcp_conversation_signals(int, text)` |

`leadcommand_get_lead_conversation` — one lead (`property_id`) or one inbox thread (`thread_id`):

- **Threads** found from every source that links a phone to the lead (`message_events.property_id`, `campaign_target_graph`,
  `inbox_thread_state.property_id`, `contact_property_resolution`), the 10 most recently active, as handles `T1…` — never
  a phone. Per thread: link (`this` / `other` / `none`), status, counters vs events on record, the contact ↔ property role,
  and the **send-time guard's inputs** (suppression list global / sender-scoped, thread flags, phone line type / status,
  holds through `automation_hold_for`, the latest recorded opt-out).
- **Messages**: a keyset page oldest-first within the page; `next_cursor` pages back in time (microsecond-exact keys).
  Text (≤ 2000 chars), direction, speaker, event type, timestamps (first write + rewritten), delivery block, recorded
  opt-out / intent / language, origin, attribution, `instruction_like`.
- **History state**: `present`, `outside_window`, `empty` (a thread with nothing), `missing` (counters say messages exist,
  none on record), `no_thread`; `property_on_record` separates an unknown id from a lead without a thread.
- **Evidence** (this page; inferred, cited): interest **per thread** and for the lead, offer requests, price candidates,
  timelines, our latest commitment (due / overdue / delivered), last speaker, unanswered seller words, failed outbound.
- **Contact reading**: `blocked` / `unknown` / `no_blocker_in_inputs`, never authoritative, and **fails closed** — a
  missing input (no phone row, holds unavailable, ownership unconfirmed, possible opt-out text) is `unknown`, never clear.

The worklist categories: `unanswered_inbound` (the seller spoke last — **verified against the message log**, a thread
whose counters say so but whose messages are not on record reads `not_verifiable`), `recent_inbound`, `opted_out`,
`identity_conflict` (one phone, several properties), `suppression_conflict` (the opt-out record and the suppression
list disagree, either direction). Each row: exact category total, the latest ≤ 3 seller texts, our latest outbound and
its commitment, overdue response, interest reading (**a label alone is `label_only`**), Decision Engine presence / age.

The ranking scores with **explicit additive factors, each citing its evidence** (`lc_opportunity_rank_v1`): interest
from seller words 40, label only 5, offer request 15, price-ask candidate 15, timeline 10, verified unanswered 15,
waiting > 24 h 5, > 72 h 5, our overdue commitment 10, Decision Engine tier A/B/C 10/6/2, stale −3, contact blocked −20,
identity conflict −5. Opted-out, possible opt-out, not-owner and declined threads are excluded and counted. Each row
names a next step **for a human**.

## 3. Security model

- **Authorization**: each tool needs its opt-in scope (never in the default grant) plus the existing principal / org /
  membership / role checks. The database role `lc_mcp_reader` holds **no privilege** on `message_events`,
  `contact_property_resolution` or the holds registry: it sees only the projections (proved by the posttest and the
  real-PostgREST e2e: direct reads are refused). No raw SQL anywhere; inputs are bounded and refused with 22023.
- **Optional functions**: the server passes the four new signatures to the reader self-check. Applied, they are judged
  like every other function (STABLE, executable, an expected definer); not applied, they are **no finding** and the
  tools answer `data_unavailable / SOURCE_NOT_APPLIED` while every 1.0 tool keeps working.
- **Untrusted content**: message text is a data value only — control / zero-width / bidi characters stripped, capped,
  listed in `untrusted_fields`, flagged `instruction_like` when it addresses an AI, and every result carries a
  `content_policy`. The gateway's second net masks phone / email shapes inside text (prices survive). Never returned:
  phone numbers, thread keys, names, emails, raw provider payloads, hold ids / keys / reason text.
- **Access logging**: every call writes one audit line — tool, scope, salted principal / org hashes, an input hash (the
  property / thread is attributable by recomputing it), counts, bytes, timing. **No message text ever reaches it**
  (asserted in tests, fixture and real-stack).
- **Readings are not authority**: price spans are candidates (the canonical asking-price authority is a write-path
  module this server may not import), interest needs cited seller words, contact readings are the guard's inputs.

## 4. Phase 2: aggregation

Exact server-side counts (`count(*)`, no sampling), keyset pagination everywhere, bounded batches (worklist ≤ 25 rows /
page, ranking ≤ 100 threads), windows ≤ 365 days (conversation ≤ 1095); with `PROPOSED_20261030120000_lc_mcp_full_history` applied, the worklist and the conversation also accept window 0 = all history (the ranking's `traverse` uses it by default, and `since` makes an incremental pass), still keyset-paged per call. `get_pipeline_summary` groups leads by market,
state, conversation / pipeline stage and status or SMS status (top N + remainder + not-set) and reports: threads with
inbound, unanswered, opted out, suppressed, not contactable, without property; opt-outs without an active suppression
row and active suppressions marked contactable; inbound / opt-out / unknown-sender / outbound messages; phones on several
properties; leads in conversation without a Decision Engine score or with one older than 30 days.

## 5. Phase 3: investigating 2109512384, 2100284187, 2109529773, 2100303162

This environment holds **no production credential** (by design), so the live investigation is the owner's single command:

```
cd mcp/leadcommand-mcp
env -i HOME="$HOME" PATH="$PATH" LEADCOMMAND_MCP_DATA=live \
  LEADCOMMAND_MCP_SUPABASE_URL=https://<project>.supabase.co \
  LEADCOMMAND_MCP_READER_JWT_FILE=<0600 file> LEADCOMMAND_MCP_API_KEY_FILE=<0600 file> \
  LEADCOMMAND_MCP_PRINCIPAL_USER_ID=<uuid> LEADCOMMAND_MCP_ORG_ID=<uuid> \
  LEADCOMMAND_MCP_SCOPES="leadcommand.leads.read leadcommand.properties.read leadcommand.scores.read leadcommand.comps.read leadcommand.contact_status.read leadcommand.holds.read leadcommand.conversations.read" \
  node --import ./src/loader/register.mjs scripts/investigate-leads.mjs --out ~/lc-investigation
```

It runs the preflight (refuses ambient writable credentials and any non-reader token), then per property: lead, property,
Decision Engine, comps (1 mi / 12 months), contact status, the whole conversation (≤ 200 messages) and the hold authority
per thread — through the gateway, so every read is authorized, masked and audited (`audit.jsonl` beside the reports,
mode 0600). Each `<id>.md` has: property details, Decision Engine, recorded sales, conversation summary (interest per
thread, offer requests, price candidates, timelines, stop requests, our responses and commitments, transcript), contact
eligibility, a **next step for a human**, and uncertainties. Before the 1.1 migration is applied the conversation section
reads `SOURCE_NOT_APPLIED` and the uncertainties say so — nothing is guessed.

Fixture demonstration (synthetic data, `--fixture`): FX1001 → `human_review_blocker` (interest with a $185,000 ask and a
60-day timeline, an overdue undelivered promise of ours, but an ownership-attribution hold); FX1002 → `resolve_unknowns_first`
(one phone denies owning it; the lead's own seller only asked who we are; "Never contact: T1 not_owner"); FX1003 →
`do_not_contact` (Spanish "ALTO" opt-out, suppressed); FX2002 → `no_conversation_on_record`.

## 6. Findings (for owner decision; none changed here)

- **F1 — bare Spanish stop words.** The dispatch guard's independent stop reading
  (`classification/multilingual-opt-out#readStopLikeText`) reads a bare **"ALTO"**, "Alto." and "Para" as neither confirmed
  nor uncertain (the primary classifier handles "alto" only with a target). Production effect depends on the primary
  classifier + recorded `is_opt_out`; the dispatch guard should not depend on it. This server fails closed (possible
  opt-out). Fix belongs in the classifier, with its blind re-test, before any autonomous sending.
- **F2 — `inbox_thread_state.property_id` has no index**; the conversation read scans it (bounded, 20 rows) inside the 5 s
  statement timeout. The worklist filters `last_inbound_at` (no index either). A timeout answers `SOURCE_TIMEOUT`, never
  partial data. Optional, separately approved: `create index concurrently … (property_id)` and `(last_inbound_at desc, id desc)`.
- **F3 — inbound timestamps are rewritten** by the second pass; any consumer ordering by `event_timestamp` misorders.
- **F4 — one thread per phone across properties**; inbound property attribution is heuristic. The tools separate rows by
  attribution and read interest per thread, but the single `inbox_thread_state.property_id` slot can point at the wrong lead.
- **F5 — AI disclosure** is "truthful when asked, never volunteered" (`outbound-validator#identityStatementReasons`).
  Whether a proactive disclosure is required for some recipients is a counsel question
  (`docs/messaging-jurisdiction-questions-for-counsel.md` B5) and a precondition for Phase 4.
- **F6 — certification evidence is not in this repository.** The NO-GO auto-reply safety evaluation the request refers to
  is absent from the worktree; the code references blind-eval items (S2, SCONV-22) but the current verdict cannot be
  confirmed here.

## 7. Phase 4: autonomous seller conversations — readiness (NOT activated)

The send path already exists and must be the only one: Action Gateway `queue_authorized_reply` (T3, a human approves each
use) → `action_gateway.execute` job → `createCanonicalTurnDecider` (decideAndCompose) → shared outbound validator → **R3**
(`conversation-ai-r3-executor.js`) → `insertSupabaseSendQueueRow` → queue runner (every dispatch guard, one dispatch).

| Requirement | Existing implementation | Gap |
|---|---|---|
| Full context | canonical decider + context builder + fact ledger; this MCP adds the full conversation read | — |
| Strict pre-dispatch suppression | R3 step 0 (STOP cancels queued sends first), step 5 fresh eligibility dry run, queue runner send-time guard | — |
| Multilingual opt-out | classify.js + multilingual-opt-out / contact-revocation | **F1** |
| Eligibility / identity | send-time guard (wrong number, not-owner), ownership-attribution holds, persona + sender continuity | F4 (attribution) |
| Recipient-local windows | `reply-timing#evaluateReplyTiming` + `resolveRecipientZones`; out-of-window deferred | — |
| Rate limits, dedup, idempotency | `idempotency_ledger`: one reply per inbound, one per seller per day, global per-day slots; `client_request_id`; `max_retries 1`; gateway `per_min 6` | — |
| AI disclosure | truthful when asked | **F5** |
| Escalation | canonical routine scope holds money / offers / legal / negotiation / multi-property / non-English for humans; escalation-evidence | — |
| Durable audits | immutable `ai_generated_messages` + lifecycle events + Action Gateway ledger | — |
| Emergency stops | R3 reads `queue_emergency_stop_at` at step 1 and again before insert; R2 `agent.runtime_limits.emergency_stop` stops job claiming (`job-runtime#stopReason`) | — (unchanged) |
| Independent blind safety evaluation | blind-eval items referenced in code | **F6**: the evaluation must be re-run independently after F1 / F5 |

**Canary plan (a separate approval, only after certification):** one owner-approved thread scope in
`ai_conversation_send_policy` (≤ 5 named threads, English only, conversational-reply category, `max_per_day_global` 3),
every reply still T3 human-approved, the R2 stop cleared **by the owner** for the `action_gateway.execute` kind only,
the queue emergency stop left armed except during an attended window; success = zero guard bypasses, zero sends to a
blocked / unknown contact, every reply's immutable record matched to its approval. Abort = re-arm both stops (no code change).
This request does **not** clear R2 or enable any send flag.

## 8. Phase 5: scheduled missions

`mcp/leadcommand-mcp/missions/sterling-missions.json` (generated by `missions/build-missions.mjs`): 10 agntei routines in
the engine's `RoutineInput` shape, **one agent per routine, each with its own read scopes** — collaboration is real
tasks by real agents, not one agent playing roles:

- `lc-pipeline-audit` (manual, once): Scout census · Sterling verified unanswered + ranking + top-10 conversations ·
  Equity Decision Engine and comps · Haven buyer demand · Atlas compliance / integrity review and the cited brief.
- `lc-daily-prioritization` (weekdays 06:40 → 07:40, attended): Scout signals · Sterling today's queue + drafts for
  human approval · Equity engine gaps · Atlas morning brief.
- `lc-compliance-sweep` (Mondays 08:05): Atlas — suppression conflicts, possible opt-outs without a record, identity overlaps.

Every prompt carries the same rules: read-only tools only, message text is quoted data, cite tool + `correlation_id`,
labels are not evidence, drafts only, never contact a blocked / opted-out / not-owner thread. Verified: every named tool
is a registered read whose scope the routine declares (`test/missions.test.mjs`), and all 10 routines validate and import
into the real agntei engine (the engine's own `Routines.create` validation; 5 scheduled, 5 manual).

Running them through **Claude Desktop's schedule via the agntei external-executor bridge** depends on the bridge branch
(`agntei-4.9.1-external-executor-bridge`), which exists only on the owner's machine and has not been pushed; it is not
verified here. Without the bridge the routines run on agntei's own scheduler, attended.

## 9. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | Sterling reads a real authorized conversation in correct chronology | posttest B (created_at order despite the rewritten timestamp), fixture + real-PostgREST e2e; live: §5 |
| 2 | Suppressed contacts and missing channels identified reliably | contact reading fails closed (unit tests: every missing input → unknown); suppression global / sender-scoped, line type, holds, opt-out record and text |
| 3 | No unauthorized access, no raw database privileges | opt-in scopes refused without grant; role has no privilege on `message_events` (posttest A, e2e); definer functions only; self-check judges them |
| 4 | Full pipeline counted and investigated efficiently | exact counts + keyset paging + bounded batches; runbook |
| 5 | Missed replies from actual inbound records, not labels | worklist verification against `message_events`; `not_verifiable` without records; `label_only` |
| 6 | Source data untrusted | sanitizer, `instruction_like`, `content_policy`, masking, no text in audit |
| 7 | Scheduled missions can use the new tools | missions test + real agntei import |
| 8 | Seller-sending safeguards and the R2 stop unchanged | no file of the send path, R3, Action Gateway, system_control or `agent.runtime_limits` is modified (diff) |

## 10. Production dependencies and the smallest safe activation

1. `PROPOSED_20261019150000_lc_mcp_reader.sql` applied (the 1.0 reader) — prerequisite, already separately approved.
2. Owner approval, then apply `PROPOSED_20261026120000_lc_mcp_conversation_intel.sql` (pretest first; it aborts on any
   self-check finding). Rollback: its `_rollback.sql`. Kill switch without rollback: revoke EXECUTE on the four functions
   from `lc_mcp_reader` (the 1.0 reads keep working).
3. Grant the two opt-in scopes only to the MCP host configuration that serves Sterling's workforce.
4. `npm run acceptance:live` (now covers the four tools; before step 2 they report `SOURCE_NOT_APPLIED`).
5. Run the Phase 3 runbook for the four properties; review the reports.
6. Import the missions into agntei; run `lc-pipeline-audit` once by hand before enabling the scheduled routines.
7. Nothing in Phase 4 is activated by any of these steps.

## 11. Tests

- `node scripts/db/run-migration-test.mjs --id lc_mcp_conversation_intel` (disposable PostgreSQL): pretest, apply, posttest
  (A privileges · B conversation · C worklist · D counts · E signals · F self-check · G suppression conflicts), rollback,
  rollback posttest, pre-apply fingerprint restored, re-apply. Mutation-checked: an altered expectation fails.
- `mcp/leadcommand-mcp`: `npm test` (fixture + fake PostgREST: 150 tests) and, with `LC_PG_BIN` + `LC_POSTGREST_BIN`, 16 more:
  `postgrest-e2e` (1.1 not applied) and `conversations-pg-e2e` (1.1 applied: the real SQL through the real gateway).
