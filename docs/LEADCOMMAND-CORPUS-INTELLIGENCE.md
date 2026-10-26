# LeadCommand × agntei — autonomous acquisitions operations: corpus intelligence, delegation, pipeline tools (MCP 1.2)

Status: **implemented on `feat/lc-conversation-intelligence` (this worktree) and on agntei `agntei-living-world-1.1-e`;
nothing applied to production; no message sent; no record changed.** Every database change is a `PROPOSED` migration
with its own pretest / posttest / rollback cycle on a disposable PostgreSQL. The R2 production emergency stop, the send
flags, every seller-sending safeguard, the Supabase privileges of every role and the Action Gateway's born-OFF state
are untouched. This environment holds **no production credential** (by design, as in 1.1): every live number below is
the owner's to produce with the commands given; every number here comes from the synthetic corpora the tests seed.

This document answers the owner's brief of 2026-10-26 ("Full Database Intelligence, Hidden Opportunities, Pipeline
Cleanup, Multi-Agent Delegation & Action Tools") item by item, in the brief's priority order (§12). It builds on
`docs/LEADCOMMAND-MCP-1.0.md` (the read-only reader), `docs/LEADCOMMAND-CONVERSATION-INTELLIGENCE.md` (1.1: conversations,
worklist, ranking, the four-lead runbook, the readiness analysis for autonomous replies, the first missions),
`docs/ACTION-MCP.md` (the Action Gateway, T1–T4) and `docs/WORKFORCE-AGNTEI.md` (one identity across both products).

## 0. What the audit found first (reuse before build)

| Capability the brief asks for | Already existed | Gap closed in this pass |
|---|---|---|
| Efficient read access, exact counts | 1.0 reader (13 tools), 1.1 `get_pipeline_summary` (exact grouped counts + signals), worklist, ranking | **The corpus itself**: populations of every source, coverage of each over the lead key, duplicates, evidence, health — and a keyset screen of every lead (§1) |
| Durable, restartable batch screening | runbook for named leads (`investigate-leads.mjs`) | **`scripts/corpus-screen.mjs`**: checkpointed, resumable, deduplicated, audited, bounded (§1.3) |
| Full seller conversations | 1.1 `get_lead_conversation` (ordered messages, text, timestamps, delivery, commitments, human involvement, restrictions) | none needed; the mission uses it (§2) |
| Correct agent delegation | agntei 4.9.2 (conversations) + 4.7 delegation | **proved for the delegation path** with a new engine test; root cause of the report = an undeployed fix (§3) |
| Stage / disposition / follow-up / task / evidence tools | Action Gateway T1 (research, valuation, operator tasks, drafts, reconciliation) + T2 (stage, disposition, deal action, holds, follow-ups, campaigns) | **`update_lead_temperature`** (T2, request-only, human-decided; §5). Verified interest, evidence, flags, review resolution and duplicate merges: what exists and what is proposed (§5) |
| Status apart from contact eligibility | the send-time guard and the registry already keep them apart | made **explicit** in the temperature tool and the mission rules (§6) |
| Underwriting evidence | Decision Engine V3 comp eligibility, confidence, backfill | the **reason scores are missing** found; the mission makes Equity's work independent and graded (§7) |
| Autonomous follow-up | the certified send path and its gates (1.1 §7) | unchanged; **not activated** (§8) |
| Persistent missions | 1.1 missions (audit, daily, compliance) | **`lc-corpus-intelligence`**: weekly, resumable, one step per agent (§9) |

## 1. Full database audit — the corpus census and the lead screen

**The lead key.** LeadCommand anchors a seller lead on its property: `eg_property_facts.property_id` (one row per
property, ~177 K in production per the 1.0 audit) is the corpus. Every other source covers a subset of it — outreach
(`campaign_targets`, `campaign_target_graph`), conversations (`inbox_thread_state`, `message_events`), pipeline records
(`acquisition_opportunities`), Decision Engine output (`property_acquisition_scores`, 101 rows in the 1.0 audit). "The
~12,000 outreach contacts" are `campaign_targets` / phones on the graph, not the lead population. The census measures
exactly that.

### 1.1 Two new read-only definer projections (migration `PROPOSED_20261026150000_lc_mcp_corpus_census.sql`)

Both are STABLE SECURITY DEFINER with `search_path = pg_catalog`, static SQL, bounded inputs (22023 when out of
bounds), granted to `lc_mcp_reader` only. The role gains nothing else: it still holds no privilege on `message_events`,
`contact_property_resolution` or the holds (posttest A). Columns the database does not have are read through
`to_jsonb()` and reported in `columns_absent` — their counts are 0 *by absence*, never guessed.

- **`lc_mcp_corpus_census(text)`** (optionally one market) — exact `count(*)`:
  - *sources*: properties, eg_property_facts, campaign_target_graph (rows / properties / phones / SMS-eligible rows),
    campaign_targets (rows / properties), campaigns, inbox_thread_state (threads / with property / with inbound / with
    outbound), message_events (rows / inbound / outbound / unknown-sender / earliest / latest), acquisition_opportunities
    (rows / open / stale open > 60 d), property_acquisition_scores (rows / fresh ≤ 30 d), sms_suppression_list (rows / active),
    master_owners, prospects, phones;
  - *coverage* over the leads: with a property row, a phone on the graph, an SMS-eligible phone, in a campaign target
    list, with a thread, with inbound, with a Decision Engine result (fresh), conversation / pipeline stage set, deal linked,
    last contact set, contacted in 90 d, estimated value set, equity known;
  - *evidence*: distress signals (≥ 1, ≥ 2), tax delinquent, active lien, probate, pre-foreclosure, equity ≥ 30 %, owners
    with several properties, out-of-state owners, signals never contacted;
  - *duplicates*: one phone on several properties, properties sharing an address (groups / properties), owners with several
    properties (owners / properties), properties with several threads, facts without a property row, properties without a facts row;
  - *contact* (recorded thread flags — the live authority stays the send-time guard): opted out, wrong number, suppressed,
    not contactable, unanswered inbound, unanswered > 7 d;
  - *pipeline health*: `needs_review` unresolved > 14 d, interest labels without contact in 30 d, deal linked without contact
    in 60 d, pipeline stage without a conversation stage, SMS opted-out label without a thread opt-out, contactable phone never
    contacted;
  - *Decision Engine* over leads in conversation: without a result, older than 30 d.
- **`lc_mcp_lead_screen(text, integer, text, text)`** — a keyset page (`property_id > cursor`, ascending, ≤ 500) of
  screening rows over every lead, optionally one market / state: property basics, equity, distress flags, owner portfolio
  size, phones **as counts** and SMS eligibility, outreach counts, last contact, conversation / pipeline labels, Decision
  Engine presence and age, thread state (unanswered, opted out, wrong number, suppressed, contactability). Never a name, a
  phone, a thread key or an address.

Tools (`mcp/leadcommand-mcp`, scope `leadcommand.pipeline.read`, opt-in, never in the default grant):
`leadcommand_get_corpus_census` and `leadcommand_search_lead_screen` (paged; `after_property_id` resumes a batch by the
plain key across processes, because a signed cursor belongs to the server that minted it).

### 1.2 Proofs

- `node scripts/db/run-migration-test.mjs --pg-bin … --id lc_mcp_corpus_census` (disposable PostgreSQL 16 here): pretest,
  apply, posttest, rollback, rollback posttest, fingerprint restored, re-apply — **PASS**. Posttest: A privileges, B every
  census number against a seeded corpus of six leads (P1 in conversation and unanswered, P2 opted out, P3 interest label
  but stale, P4 `needs_review` unresolved with a portfolio owner and a duplicate address, P5 distress + equity + eligible
  phone never contacted, P6 another market), the market filter, bounds; C keyset pages cover P1..P6 once, rows as
  seeded, no identifier in the output, bounds; D the reader self-check with the extended list.
- `test/census.test.mjs` (fixture, 6 tests): opt-in scope refused and audited; exact counts over the 31-lead fixture;
  pages cover every lead once; the screen rule; the job's durability (below); `SOURCE_NOT_APPLIED` when the functions are
  absent while every 1.0 tool keeps working.
- `test/census-pg-e2e.test.mjs` (real PostgREST + PostgreSQL, the migration applied): the boot self-check judges six
  optional functions; the seeded corpus through the real gateway and output schema; real cursors; the screening job runs
  and resumes on the real stack and shortlists P1 and P5, never P2; the role still cannot read `message_events`.
- The whole reader suite with the two tools: inventory (15 allowlisted functions), protocol (19 read tools), HTTP,
  credential, limits, security — see §11.

### 1.3 The restartable screen (`mcp/leadcommand-mcp/scripts/corpus-screen.mjs`)

Read-only, in-process through the gateway (authorized, masked, output-validated, audited), fixture or live:

```
env -i HOME="$HOME" PATH="$PATH" LEADCOMMAND_MCP_DATA=live LEADCOMMAND_MCP_SUPABASE_URL=… \
  LEADCOMMAND_MCP_READER_JWT_FILE=… LEADCOMMAND_MCP_API_KEY_FILE=… \
  LEADCOMMAND_MCP_PRINCIPAL_USER_ID=… LEADCOMMAND_MCP_ORG_ID=… LEADCOMMAND_MCP_SCOPES="leadcommand.pipeline.read" \
  node --import ./src/loader/register.mjs scripts/corpus-screen.mjs --out ~/lc-screen [--market "Tulsa, OK"] [--page 500]
```

- `census.json` first; then every lead, a page at a time, to `leads.jsonl` (append + fsync) **before** `state.json`
  (atomic rename) records the last `property_id`. A run that dies between the two re-reads that page and skips the ids
  already logged: **every lead is screened exactly once, however often the job is retried** (tested on fixture and on
  the real stack). Counters are recovered from the log, not trusted from the state file. `--fresh` starts over; a
  different rule or filter set refuses to continue in the same directory.
- `lc_lead_screen_v1`: every point is an explicit factor with the evidence that earned it — unanswered seller message
  40 · in conversation 15 · interest label 10 (a label, not seller words) · Decision Engine tier A 10 / B 6 · distress ≥ 2
  signals 10 · tax delinquent 5 · probate 5 · pre-foreclosure 8 · active lien 3 · known equity ≥ 30 % 8 · portfolio owner 4
  · SMS-eligible phone 5 · stalled deal 6 · `needs_review` unresolved 8 · re-engage after 180 d 5 · signals never contacted 5
  · no channel −15. Candidate at ≥ 25. **Opted-out, wrong-number and suppressed threads are excluded before scoring** and
  counted apart. No protected characteristic or personal vulnerability is a signal: only the lead's own record of
  contact, response, pipeline state, property facts and public distress evidence.
- Outputs: `summary.json` (totals, by market, categories, flags, exclusions), `shortlist.json` (top N with factors —
  the input of `scripts/investigate-leads.mjs`, the expensive reads), `report.md`, `audit.jsonl` (no message text; tool,
  hashes, counts). Files are 0600.

Why the screen is cheap: one page of 500 leads is one definer call joining the facts page to phone counts, thread flags,
scores and target counts by `property_id in (page)` — a hash semi-join per page, no per-row scans; the whole corpus is
~350 pages.

## 2. Complete conversation intelligence

Unchanged from 1.1 and reused by the mission: `leadcommand_get_lead_conversation` gives ordered inbound and outbound
messages (by the row's first write), the seller's actual words, timestamps, delivery and response states, seller-stated
prices and timelines, offer requests, our commitments and whether we kept them, previous human involvement
(`message_origin` operator / campaign), per-thread contact restrictions and the send-time guard's inputs (suppression,
holds, phone state, recorded opt-outs), with PII masked and instruction-like text flagged. The worklist identifies
unanswered seller messages in batch, verified against the message log. Nothing in this pass sends text to a model: the
census and screen are counts and flags, and the mission prompts tell each agent exactly which conversations to read.

## 3. Agent delegation runs as the receiving agent (agntei)

The report: Sterling brought Equity into a discussion; the reply, attributed to Equity by the UI, claimed to be Sterling.

The audit of agntei `agntei-living-world-1.1-e`:
- **Conversations**: fixed in 4.9.2 (`docs/AGNTEI-4.9.2-AGENT-IDENTITY.md`): a provider session belongs to one account
  *and* one agent; history is replayed with authors; the agent is bound with the message server-side. Pinned by
  `packages/engine/test/identity492.test.ts` (12 tests incl. the War Room).
- **Delegation** (`delegate_task` from a task or a chat; a War Room hand-off): the child task is created for the
  receiving agent and runs with that agent's own instructions, a fresh provider session (never a resumed one) and its own
  execution record; its findings return to the delegating agent's record attributed to the receiver; the delegating agent
  reaches the child only as data ("Delegated by Sterling …"). Pinned by the new
  `packages/engine/test/delegation-identity.test.ts`: Sterling → Equity on ONE shared Claude account; Equity's
  instructions, `resumeSessionId` null, the run on Equity's task, the summary signed "I am Equity", Sterling's own session
  untouched, the status Sterling reads back attributed to Equity. Both suites pass (identity 12/12, delegation 11/11, the
  new test 1/1).
- **Root cause of the report**: the observed build predates 4.9.2 — the branch carrying it has not been deployed. No
  further engine change was needed. Rule for the acquisitions department: Sterling delegates underwriting to Equity,
  research to Scout and buyer evidence to Haven through `delegate_task` (or a War Room hand-off), never by answering for
  them; the LeadCommand missions (§9) are one step per agent, each under its own identity and read scopes.
- **Across products**: LeadCommand Workforce binds one agntei agent to one employee and one Action Gateway principal
  (`docs/WORKFORCE-AGNTEI.md`); every gateway call resolves the acting employee from the authenticated credential, never
  from an argument (`FORGED_CONTEXT`). Session or persona reuse across identities is refused on both sides.

## 4. Hidden-opportunity discovery — where each category comes from

| Brief category | Where it is found (all read-only, all cited) |
|---|---|
| Verified inbound seller interest without a response | worklist `unanswered_inbound` (verified against `message_events`) → screen factor `unanswered_seller_message`; conversation read for the words |
| Stalled negotiations | screen `stalled_opportunity` (deal linked, no contact > 60 d); census `deal_linked_no_contact_60d`, `acquisition_opportunities.stale_open_60d` |
| Interested leads with no recent follow-up | screen `interest_no_recent_followup`; census `interest_label_no_contact_30d`; ranking's overdue commitments |
| Needs-review never resolved | screen `needs_review_unresolved`; census `needs_review_unresolved_14d` |
| Strong property candidates overlooked by campaigns | screen `signals_never_contacted` / `distress_equity_uncontacted` (distress + equity, never contacted, eligible phone); census `contactable_phone_never_contacted`, `signals_never_contacted` |
| Inaccurate stages / temperatures | screen flag `label_inconsistent_pipeline_without_conversation`; census `pipeline_without_conversation_stage`, `sms_opted_out_label_without_thread_opt_out`; the mission's Sterling step compares labels with seller words and proposes `update_lead_temperature` / `update_lead_stage` requests |
| No usable SMS channel, other channel possible | screen `no_sms_channel_other_possible` (phones on record, none SMS-eligible) vs `no_channel` |
| Several properties linked to one owner | screen `portfolio_owner`; census `owners_with_several_properties`, `phones_on_several_properties`, `properties_with_several_threads` |
| Abandoned because of incomplete / stale evidence | screen flags `decision_engine_missing` / `decision_engine_stale` / `data_gap_estimated_value`, category `abandoned_with_signals`; census Decision Engine coverage |
| Overlooked buyer-demand opportunities | Haven's step: `leadcommand_get_market_intelligence` per candidate ZIP (investor / cash share, active buyers, build provenance) |

Priority = `lc_lead_screen_v1` for the screen (documented factors, exclusions first) and `lc_opportunity_rank_v1` for
conversations (seller words over labels). Verified facts, seller statements, inferred readings and missing evidence are
separate fields everywhere (`verified`, `interest.state`, `label_only`, `columns_absent`, `unknowns`).

## 5. Production-grade pipeline action tools — audit and the smallest gap

Every mutation goes through the ONE Action Gateway pipeline (`docs/ACTION-MCP.md` §1.1): authenticated agent principal,
kill switches, standing grant with scope / caps / envelope, closed schema, forged-context refusal, resource resolution
in the tenant, idempotent intent per `client_request_id`, policy (holds, STOP / suppression, budgets), immutable
authorization, lease, lease-bound SECURITY DEFINER writer, outcome, recovery (re-execute or visible `outcome_unknown`),
append-only audit. No agent holds raw SQL. Stage and temperature values are the canonical registry's
(`universal-lead-state-registry.js`): stages S1–S5 proposable, contract / closing refused; temperatures cold / warm / hot.

| Brief mutation | Tool | State |
|---|---|---|
| Update lead stage | `update_lead_stage` (T2, request-only → `pipeline.propose_stage_change`, human decides; transition re-validated) | existed |
| Update lead temperature | **`update_lead_temperature`** (T2, request-only → `inbox.prepare_temperature_change`, human decides; `patchUniversalLeadState` dry run then write) | **new** |
| Record verified interest | `update_lead_disposition` → `interested` with the reason (the ownership-answer rules apply); interest *evidence* is the conversation read's cited message ids in the request's reason / the mission report | existed (disposition) — a separate "verified interest" record is **not** a new table: the universal lead-state writer is the authority |
| Record follow-up commitments | `schedule_followup` / `cancel_followup` (T2, reversible; hold + send-time guard at plan) | existed |
| Create internal acquisition tasks | `create_operator_task`, `create_deal_action` (T1 / T2) | existed |
| Assign research | `create_research_job`, `request_property_valuation` (T1), `workforce_request_research` | existed |
| Record evidence | `workforce_report_progress` / `workforce_complete_assignment` (evidence refs the gateway can resolve) + the approvals' `intended_change`; conversation evidence stays in `message_events` | existed |
| Flag conflicting records | `create_operator_task` with the conflict (suppression / opt-out disagreement, one phone on several properties) — the census and worklist list them; `set_thread_hold` when contact must stop while a human looks | existed |
| Resolve review items | `update_operator_task` (resolve agent tasks); `update_lead_disposition` / `update_lead_stage` requests move a `needs_review` thread; operator items stay the operator's | existed; the mission's Sterling step proposes them |
| Propose duplicate merges | **proposed, not built**: a `propose_duplicate_merge` T2 request (human-decided) needs a merge service that LeadCommand does not have yet (no `merge_properties` / `merge_contacts` domain mutation exists; the census counts duplicate groups so a human can act) |

**`update_lead_temperature`** (`apps/api/src/lib/domain/action-gateway/actions/t2/update-lead-temperature.js`,
capability `inbox.prepare_temperature_change` in `agent/capabilities/defs/action-gateway-requests.js`, the SQL writer
case and registry rows in `PROPOSED_20261020100000_action_gateway_t2.sql`, link #27 — unapplied, so amended in place):
- input `{ client_request_id, thread_id, temperature ∈ cold|warm|hot, basis ∈ seller_words|seller_price|seller_timeline|no_response|decision_engine|property_evidence, reason }`;
- policy: never-revive identities, the canonical set, a named evidence class, the hold authority (`ai_action`),
  `ALREADY_SET`, `TEMPERATURE_LOCKED` (an operator's manual lock is final); **contact eligibility is neither consulted
  nor changed** (§6);
- effect: ONE pending `agent.approval_request`; on a named operator's approval the lead-state writer runs its dry run
  and invariants with `change_source: 'ai'` and `manual_temperature_lock: false` — an agent request never installs an
  operator lock; the registry's lock guard refuses under an existing lock again at execution;
- proofs: `action-gateway-t2-unit` (ten T2 tools, six request-only, the capability in the production registry, never
  model-facing), `action-gateway-unit` (22 requested tools), the Action MCP suite (25 pass), and the PostgreSQL proofs
  written for the owner's PG 17 CI: `action-gateway-t2-tools-pg` (happy path through the real decide path; a suppressed
  contact still gets a label request; lock / already-set / unknown temperature / unknown basis / hold refuse; no phone in
  the approval record) and the T2 matrix (concurrent agents, forged context, replay). **Not run here**: the gateway's
  PostgreSQL fixtures need PostgreSQL 17 (`grant … maintain` in `send_queue_live_baseline.sql`); this container has 16
  and installing 17 was not permitted in this session.

**Cleanup plan (proposed, no write performed).** From the census and screen: (1) the label inconsistencies
(`pipeline_without_conversation_stage`, `sms_opted_out_label_without_thread_opt_out`) → human review list; (2) interest
labels without contact in 30 d and `needs_review` unresolved → the daily prioritization; (3) temperature / stage
corrections the seller's words justify → `update_lead_temperature` / `update_lead_stage` requests, each decided by a named
operator; (4) duplicate groups → operator tasks. Certification of the narrow write scopes = the T2 PostgreSQL suite on an
isolated environment, then the existing supervised production-canary process (T1 first, then `T2` in
`action_gateway_tiers` with low caps and a short validity window). The eventual routine maintenance without per-update
approval is a later owner decision: it would move `update_lead_temperature` to a *reversible* standing basis
(`basis = 'reversible'` in the registry + a lease-bound domain writer), which this pass deliberately does not do.

## 6. Pipeline status is not communication eligibility

Seven authoritative states, kept apart in every tool and prompt of this pass:

| State | Authority | Read by | Changed by |
|---|---|---|---|
| Opportunity status / stage | `acquisition_opportunities`, lead-state registry | screen, census, `get_lead` | `update_lead_stage` (human-decided) |
| Seller interest | the seller's words (`message_events`) | conversation read, worklist, ranking | nothing — it is evidence |
| Contact eligibility | the send-time guard (`evaluateCanonicalContactability`), holds | `get_lead_contact_status`, thread contact inputs | never by an agent (holds can only be set) |
| Opt-outs / preferences | `sms_suppression_list`, recorded opt-outs | contact inputs, census | never by an agent |
| Telephone validity | phones / graph (`wrong_number`, line type) | contact inputs, screen counts | the ownership pipeline, humans |
| Conversation state | `inbox_thread_state` flags | screen threads, worklist | the inbox |
| Follow-up commitments | `followup_intents`, outbound text | conversation evidence, follow-up health | `schedule_followup` / `cancel_followup` |

Consequences, enforced: an interested lead may be suppressed from SMS (the screen shows interest and excludes it from
contact-shaped actions, never from the pipeline); a wrong number does not close the property opportunity (the
temperature tool files a label request regardless of eligibility — tested with a suppressed thread); "not interested
right now" is `declined_unverified` / `not_interested` through the disposition rules, never a removal from all contact;
no tool clears a suppression; no tool deletes or closes an opportunity because a channel is unusable.

## 7. Acquisition valuation and underwriting

**Why the acquisition scores were missing.** `property_acquisition_scores` is written only when the Decision Engine
runs. The engine has run for ~170 of ~170 K properties (`apps/api/src/lib/acquisition/scoringBackfill.js` header):
the overnight, throttled, resumable backfill exists, but it runs only while `system_control.acquisition_scoring_backfill.status
= 'running'`, outside the operator contact window, under the load rails — and the owner-directed campaign-scoped
offer-ready layer scores only live campaigns' properties. So a lead outside a live campaign has no score unless an
operator or the seller flow requested one. The census reports the coverage exactly (`with_decision_engine`,
`decision_engine.without_decision_engine`, `..._older_than_30d`); the mission flags every candidate without a fresh
result for `request_property_valuation` (T1) or the backfill. Turning the global backfill on is an owner action in
`system_control`; it is not done here and is not a paid external call (the engine runs on recorded data).

**Comps relevance.** The Decision Engine V3 already rejects comps by: invalid price, nominal non-arm's-length transfer
(price far below assessed value), package / portfolio consideration, same property, asset-type mismatch, implausible
unit count, sale too old, outside radius (4 mi / 30 months residential; 7 / 36 multifamily; 15 / 48 commercial; 20 / 48
land), outside ZIP without coordinates, square-feet ratio outside 0.5–1.9 (residential), unit ratio 0.35–2.75
(multifamily), building size 0.3–3.5 (commercial); it adjusts by price per unit / sqft / lot sqft and grades confidence
(`acquisitionConfidence.js`). What the brief asks beyond that — condition differences and rehab uncertainty as explicit
factors, sale-type exclusions by document type, a price-per-square-foot band against the pool, a stated geographic
expansion rule and a confidence grade on every report — is written into Equity's mission step as the reporting standard
over the engine's own evidence (`search_comps` exposes recorded sales with distance, age and buyer basis). A change to the
engine's selection logic is out of this pass (it is the monetary authority with its own test corpus of 2,102 Florida
comps) and would be proposed separately with measured thresholds.

**Independence.** Equity's step reads the property, the engine result and the comps itself and must produce its own
band and grade, comparing to — never repeating — Sterling's or the engine's numbers; Haven's step verifies buyer demand per
ZIP before any opportunity is called assignable. Each runs as its own agent (§3).

## 8. Autonomous follow-up — unchanged, not activated

The readiness analysis and canary plan of 1.1 §7 stand. The send path remains the only one (Action Gateway T3
`queue_authorized_reply` → canonical turn decider → outbound validator → R3 → queue runner with every dispatch guard);
AI-written production sending stays behind its blind safety evaluation and deployment gate; the R2 stop and
`queue_emergency_stop_at` are untouched; nothing inserts into `send_queue`. F1 (bare Spanish stop words) and F5 (AI
disclosure) remain preconditions.

## 9. The persistent mission — `LeadCommand — Full Pipeline Intelligence & Hidden Opportunity Recovery`

`mcp/leadcommand-mcp/missions/sterling-missions.json` (generated by `missions/build-missions.mjs`; now 15 routines)
adds `lc-corpus-intelligence`: weekly (Sunday 05:00, missed → once), **one step per agent, each under its own identity
and read scopes**:

1. **Scout** — census (whole corpus + the owner's markets), the screen (≤ 20 pages × 500 per run, resumed by
   `after_property_id` from the previous run's RESUME MARKER; or the operator host's `corpus-screen.mjs` outputs), the
   shortlist with categories, the data gaps.
2. **Sterling** — for the top 25: the whole conversation and the contact status; the seven states kept apart; proposed
   internal updates as DRAFTS, or filed as `update_lead_temperature` / `update_lead_stage` / `update_lead_disposition`
   requests once the grants are live (each decided by a named operator); hands Equity and Haven their leads.
3. **Equity** — independent underwriting for the top 10 with the widening rule, exclusions, rehab uncertainty, economics
   and a confidence grade; flags missing / stale engine results.
4. **Haven** — buyer demand per ZIP; "thin / missing" said plainly.
5. **Atlas** — compliance and integrity items, the brief, escalations (genuine business decisions), the RESUME MARKERS of
   every step, and the confirmation that nothing was sent or changed except through a human-decided request.

Every prompt carries the 1.1 rules plus the durability rule (record the resume marker; never redo a covered lead).
`test/missions.test.mjs` proves every named tool is a registered read whose scope the routine declares, one agent per
routine, valid schedules, and that the committed JSON is the generator's output. Importing into agntei and running
through the scheduled executor is the owner's step (1.1 §8). Durable progress across runs = the resume markers in the
reports + the screening job's `state.json` / `leads.jsonl` (no duplicate work after retries or restarts, tested).

## 10. The first actionable investigation (the four Tulsa / Wilson sellers)

Unchanged: `scripts/investigate-leads.mjs` reads, per property, the lead, the property, the Decision Engine, comps,
contact status, the whole conversation and the hold authority, and writes an evidence report with a next step for a
human and its uncertainties. The live run needs the owner's reader credential (1.1 §5 command); it sends nothing and
commits nothing. Its fixture run is part of the suite (`test/investigate.test.mjs`).

## 11. Certification — what is demonstrated, and where

| # | Criterion | Evidence here | Pending on the owner |
|---|---|---|---|
| A | Complete corpus scan with exact population and coverage counts | `lc_mcp_corpus_census` posttest + PG e2e (every count); the screen covers every lead once (fixture 31, PG 6) | the live census and screen (§1.3 command) |
| B | Verified identification of unanswered seller conversations | 1.1 worklist (verified against `message_events`); census `threads_unanswered_inbound` / `_over_7d`; screen `unanswered` | live run |
| C | Genuine Sterling → Equity delegation, correct identity, independent output | `delegation-identity.test.ts` + `identity492.test.ts` (agntei) | deploying the branch that carries 4.9.2 |
| D | Suppression and contact-eligibility enforcement | 1.1 contact readings fail closed; the screen excludes opted-out / wrong-number / suppressed before scoring; the temperature tool leaves eligibility untouched (test) | — |
| E | Certified stage / temperature updates through the Action Gateway in an isolated test | unit + Action MCP suites pass; the PostgreSQL proofs are written (`action-gateway-t2-tools-pg`, matrix, the T2 migration cycle) | **run on PostgreSQL 17** (the gateway fixtures need it) |
| F | Durable progress across sessions and scheduled runs | the screening job's checkpoint / resume tests (fixture and real stack); mission resume markers | running the mission on the scheduler |
| G | Real results visible in agntei Missions and LeadCommand | the 15 routines validate against the agntei engine (1.1 §8) and the reader catalog; filed requests appear as `agent.approval_request` rows (T2 tests) | live import + grants |
| H | No unapproved seller messages, financial commitments or permission expansion | no file of the send path, R3, `system_control` or the roles' privileges changed; every new function is a read for `lc_mcp_reader`; the new tool is request-only (human-decided) | — |

Suites: reader `npm test` (see the final counts in the commit message), `census-pg-e2e` 6/6, `conversations-pg-e2e` 7/7,
migration cycle `lc_mcp_corpus_census` PASS, Action MCP 25 pass, `action-gateway-t2-unit` + `action-gateway-unit` 16/16,
agntei engine identity 12/12, delegation 11/11, delegation-identity 1/1.

## 12. Owner steps, in order (each its own approval)

1. Apply `PROPOSED_20261026150000_lc_mcp_corpus_census.sql` after the 1.0 reader and the 1.1 conversation migration
   (pretest first; rollback and kill switch in the file's header). Grant `leadcommand.pipeline.read` to the host that
   serves Scout and Atlas.
2. Run `scripts/corpus-screen.mjs` live (§1.3) on the operator host; keep `~/lc-screen` private; feed `shortlist.json` to
   `scripts/investigate-leads.mjs`.
3. Import `missions/sterling-missions.json` into agntei; run `lc-corpus-intelligence` once by hand; then enable its schedule.
4. On a PostgreSQL 17 CI: `run-migration-test --id action_gateway_t2` and the `action-gateway-t2-*-pg` suites; then the
   link #27 production path of `docs/ACTION-MCP.md` §7–8 with `leads.update_temperature` granted narrowly (caps, window).
5. Deploy the agntei branch carrying 4.9.2 and the delegation test.
6. Decide the duplicate-merge service and the engine's comp-rule additions as separate proposals.
7. Nothing in §8 is activated by any of these steps.
