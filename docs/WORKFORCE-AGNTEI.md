# Workforce × Agntei: one company, one registry, one authority, two interfaces

Status: Phase 1–2 contract (2026-10-22). Everything here is born OFF; nothing is deployed or activated without separate owner approval.

## 0. What exists (audit, 2026-10-22)

| System | Verified state |
|---|---|
| LeadCommand production | 6ff4a24a (Package A A1). Agent runtime off: emergency stop on, kind_limits {}. No Workforce, no Action Gateway, no lc_mcp_reader in production. |
| feat/workforce | rc-8.5.21.1 (028b6039) + Action MCP T2–T4 (377e0eca) + Workforce Phase A (db, engine, UI) + opaque-ids test fix. Local only. |
| Read-only MCP (`mcp/leadcommand-mcp`) | 13 tools, role lc_mcp_reader (PROPOSED, needs the pg_net fix first). stdio + loopback HTTP. |
| Action MCP + Gateway (`mcp/leadcommand-action-mcp`, `action_gateway.*`) | T1–T4 built and tested, PROPOSED, born OFF. Agent principals (`agt_…`), lcag_ credentials (HMAC digest, ≤ 90 days, a named human sponsor, owner-minted), standing `capability_grants`, single-use approvals, envelopes, R4/R5. stdio by default; `streamable-http` loopback with a per-agent Bearer. |
| Agntei (`kindleops/agntau`) | A local-first Mac app (Electron + node server + SQLite `~/.agent-command`). One operator (`local-operator`); no inbound remote API; no webhooks. Agents (`agent_…`) are rows; tasks are repository coding tasks. MCP: HTTPS / loopback-HTTP connections handed to **Claude Code runs only**, through the per-run loopback McpProxy (tokens never reach the agent). On `agntei-4.4-project-os`: per-agent `connection_access` grants up to a risk tier, local stdio MCP servers through a sandboxed bridge, typed orchestration actions (`/api/orch/*`), agent-to-agent delegation. **No LeadCommand connection exists today.** |

Consequence: integration is **Agntei → LeadCommand over the Action MCP**. LeadCommand stays the single authority for employees, missions, assignments, grants and outcomes. Agntei *reads and acts* through LeadCommand tools; it holds no second copy of Workforce state, only a link (its agent id ↔ the Workforce employee id) and a cache for display.

## 1. One employee identity

`workforce.employee` gains (additive migration `PROPOSED_20261022110000_workforce_agntei.sql`):
- `employment_type`: `autonomous_ai | operator_ai | human`. It replaces nothing: `kind ai|human` stays, and `employment_type` refines it (CHECK: human ⇔ kind human).
- `origin`: `workforce | agntei`.
- `external_system` (`agntei`), `external_install_id` (the Agntei install's stable id, text, shape-checked), `external_agent_id` (`agent_…`). Partial UNIQUE on (org, external_system, external_install_id, external_agent_id): **one Agntei agent ⇔ one employee, ever**.
- `skills text[]`, `property_specializations text[]`, `availability available|busy|off|unknown`.

**Linking is authenticated, never self-asserted:**
1. **The CEO creates the employee** in Workforce (Employees → "Register an Agntei agent"): role, department, manager, markets, employment_type `operator_ai`. Status `pending_link`. No grants.
2. **The owner mints the agent's Action Gateway principal** with the existing owner scripts (`mcp/leadcommand-action-mcp/scripts/mint-agent-credential.mjs`, which prints the digest + the owner SQL). The employee row is bound to it (`action_principal_id`) by an owner-only definer function, `workforce.employee_bind_principal(employee_id, agent_id)`. The principal's sponsor is the CEO user.
3. **In Agntei,** the operator adds the "LeadCommand Workforce" connection (loopback HTTP to the Action MCP, Bearer = that agent's token) and grants it to that one Agntei agent (`connection_access`).
4. **On its first call** the agent invokes `workforce_link_self { external_install_id, external_agent_id }`. The gateway has already authenticated the principal. Binding happens once:
   - if the employee is `pending_link` and has no external ref → bind and set status `active`;
   - if the same ref is presented again → no-op;
   - a different ref → refused with `IDENTITY_MISMATCH`, recorded, and the grant auto-suspended.
5. **Registration grants nothing.** `capability_grants` remain owner-minted rows. The Workforce Authority Center shows *proposed* grants for the employee's role (display only).

The acting employee is always resolved **from the authenticated principal** (`action_principal_id`), never from tool arguments. Any `employee_id` / `actor` argument naming someone else is refused (`FORGED_CONTEXT`, the gateway's existing forged-context rule).

## 2. Workforce actions on the Action Gateway (new catalog entries, T1 / internal)

They are added to `GW/catalog.js` plus their domain writers (SECURITY DEFINER, lease- and principal-bound), registered in `action_gateway.extensions` like the T2 / T34 additions. All are T1 (internal only). None reaches send / offer / stage / campaign.

| Tool (MCP name `leadcommand_workforce_*`) | Class | Effect |
|---|---|---|
| `workforce_whoami` | read | employee, role, department, manager, markets, grants (live), the tier ceiling, open assignments |
| `workforce_link_self` | write (once) | §1 step 4 |
| `workforce_list_assignments` | read | assignments where assignee = me, or mission participant / ownership visible to me |
| `workforce_get_mission` | read | a mission I participate in, or that my sponsor (the CEO) requested |
| `workforce_open_mission` | internal | the CEO's directive relayed by an operator-directed agent. `requested_by` = the principal's sponsor (a named human), `origin=agntei`, `owner` = the COO. The COO plans it; with `assign_to_self=true` the first assignment goes to the caller — or, for an EXTERNAL acquisition-type caller relaying a triage, the DELEGATED plan (implementation note 8) |
| `workforce_claim_assignment` | internal | lease an assignment assigned to me (execution_mode `external`); takes the resource claim; refuses `CLAIM_HELD` |
| `workforce_report_progress` | internal | heartbeat + progress + evidence refs, lease-bound |
| `workforce_complete_assignment` | internal | finish with an output + evidence. `outcome_class=verified` requires ≥ 1 evidence ref that the gateway can **resolve** (a runtime job of this mission, a gateway intent/outcome of this principal, or a canonical record id the agent read through a logged tool call). Otherwise it is stored as `partial` / `unknown`, never "verified" |
| `workforce_request_research` | internal | `property.research` through `agent.runtime_enqueue` (the existing T1 `create_research_job` path), linked to the assignment, which then waits on the job |
| `workforce_handoff` | internal | transfer an assignment to another employee or back to the COO. Recorded event + exec_message; the new owner's mode applies. Never triggers seller-facing work |
| `workforce_escalate` | internal | a CEO-queue item with reasons |

The same gateway pipeline applies to every call (identity → kill switches → capability/grant → scope → policy → intent+idempotency → authorization → execute → audit). The **Workforce engine itself** (autonomous employees) does not use credentials: it calls the same store / definer functions in-process, and the **authority engine (`lib/workforce/authority`) is shared**. So a given action gets the same authorization decision from either entry point, and a parity test asserts it.

## 3. Execution modes (one engine)

`workforce.assignment.execution_mode`: `internal | external`.
- **`internal`:** claimed by `workforce.dispatch` (autonomous employees, the R2 runtime).
- **`external`:** never claimed by dispatch. It waits for its assignee's agent to claim it through `workforce_claim_assignment`. The UI shows "Waiting for <agent> (Agntei)": truthful, with the last-seen heartbeat. An external lease expires and is reaped like any other.
- **Mode transitions:** `workforce_handoff` or the COO reassignment sets the assignee and recomputes the mode from the new assignee's `employment_type`. Progress (output, evidence) is preserved. A recorded `wf.assignment.handed_off` event. No new seller-facing action can be created by a transition (static + behavioural test).
- **Human ownership:** an assignment on a resource with an active human resource claim, or a thread whose `inbox_thread_state` manual owner / manual_override is set, refuses AI claims (`HUMAN_OWNED`).

## 4. Visibility

- **Workforce:** an origin badge (Agntei / Workforce), employment type, a truthful status. *Working* only while a lease is held with a heartbeat < 2 min; *waiting* (on a job / approval / hold / an external agent) with the reason; *idle*. Per-employee action history = workforce events + `action_gateway.action_audit_events` for that principal.
- **Agntei:** a "LeadCommand Workforce" panel, read through the same MCP tools from Agntei's own MCP client (`connections/mcp-client.ts`, using the operator's connection): the linked identity, live grants, assigned missions and assignments, pending approvals and escalations, completed outputs with links to ops.leadcommand.ai records. No second store.

## 5. Budget accounting

- The existing `agent.spend_ledger` (reserve/settle) is the ledger for model and research spend.
- Workforce adds `workforce.budget` (org / department / mission / employee × day / month caps), read by the authority engine before enqueueing paid work. KPI `value_per_usd` is unknown until realized outcomes exist.
- An Agntei agent's own model spend stays in Agntei's `spend` table; the agent reports it in `workforce_report_progress.cost` (shown as *reported*, not verified).

## 6. First milestone (proof)

On a disposable PG + PostgREST + the local Action MCP (HTTP loopback) + a headless Agntei engine (`pnpm start`, its own temp data dir):
1. The CEO registers an operator_ai employee; the owner mints and binds the principal.
2. The Agntei agent links (`workforce_link_self`) and is visible in Workforce.
3. A CEO directive is relayed from Agntei (`workforce_open_mission`); the mission appears in Workforce with origin agntei.
4. The COO plans it (internal kinds) and assigns the research step to the Agntei employee (external).
5. The agent claims it, reads permitted data (the read tools), calls `workforce_request_research` (a real R2 job), and the job completes.
6. It completes the assignment with resolvable evidence → verified.
7. The COO mission_review composes the report; the COO exec_message.
8. The mission reads as completed from Workforce (the API) and from Agntei (the panel via MCP). Identical canonical outcome.
9. No send_queue / offer / stage write (asserted).

Plus adversarial checks:
- a forged employee_id argument → refused
- a second Agntei agent with the same ref → refused
- an expired or revoked grant → refused
- a claim on a human-owned thread → refused
- two agents on one resource → CLAIM_HELD
- an engine crash mid-lease → reap → resume
- handoff external → internal → completed by dispatch
- the emergency stop → everything refused

The agent's reasoning is a **scripted agent** driving Agntei's real MCP client (labelled as such); a live Claude Code run is an optional, owner-approved step.

## Implementation notes (LeadCommand side, `feat/workforce-agntei`)

Migration `supabase/migrations/PROPOSED_20261022110000_workforce_agntei.sql` (+ pretest / posttest / rollback / rollback_posttest; manifest id `workforce_agntei`). Preconditions RAISE without the Workforce foundation or the Action Gateway #26 + #27 (extension registry). It composes with #28 (rows only). Born OFF.

**MCP tools** (Action MCP, `leadcommand_<gateway name>`, all T1, `_meta['leadcommand/risk']` = `read` or `internal_write`, `seller_facing: false`, `destructiveHint: false`; reads `readOnlyHint: true`). The bare `workforce_*` gateway names are NOT callable over MCP.

| MCP tool | Input (closed schema) | Result highlights |
|---|---|---|
| `leadcommand_workforce_whoami` | `{}` | `employee` (role, department, markets, employment_type, origin, status, external ids), `manager`, `grants[]` (live, suspended flag), `tier_ceiling`, `open_assignments[]`, `linked` |
| `leadcommand_workforce_list_assignments` | `{ status?, mission_id?, include_mission_peers?, limit≤100 }` | `assignments[]` (own, full), `mission_peers[]` (summary) |
| `leadcommand_workforce_get_mission` | `{ mission_id }` | `mission`, `assignments[]`, `visible_because` participant / sponsor_requested |
| `leadcommand_workforce_link_self` | `{ client_request_id, external_install_id ^[A-Za-z0-9][A-Za-z0-9_.:-]{7,79}$, external_agent_id ^agent_[A-Za-z0-9_-]{3,64}$ }` | `LINKED` / `ALREADY_LINKED`; refused `IDENTITY_MISMATCH`, `EXTERNAL_REF_ALREADY_LINKED` (both suspend the principal's Workforce grants), `LINK_WINDOW_CLOSED`, `BINDING_*` |
| `leadcommand_workforce_open_mission` | `{ client_request_id, directive 3..2000, assign_to_self? }` | `MISSION_OPENED {mission_id, created, origin:'agntei', plan_job_id}`; `DIRECTIVE_REFUSED` / `DIRECTIVE_UNCLEAR` / `STATUS_IS_A_QUESTION` / `EMERGENCY_STOP` |
| `leadcommand_workforce_claim_assignment` | `{ client_request_id, assignment_id, lease_seconds 60..3600 }` | `CLAIMED {attempt, lease_until}`: pass `attempt` as `claim_attempt` later; refused `CLAIM_HELD`, `HUMAN_OWNED`, `NOT_ASSIGNEE`, `NOT_EXTERNAL`, `NOT_DUE`, `WAITING_ON_JOB`, authority codes (`MARKET_OUT_OF_SCOPE`, `AUTOMATION_HOLD`, …), `AUTHORITY_ESCALATE` |
| `leadcommand_workforce_report_progress` | `{ client_request_id, assignment_id, claim_attempt, progress?{percent,phase,note}, output?, evidence?[], cost?{usd,model} }` | `PROGRESS_RECORDED`; `LEASE_LOST` (stale generation, nothing applied) |
| `leadcommand_workforce_complete_assignment` | `{ client_request_id, assignment_id, claim_attempt, outcome_class? verified\|partial\|unknown, output{summary,findings[],next_steps[],recommendation}, evidence?[{type job\|intent\|thread\|property\|opportunity, id, note?}] }` | `ASSIGNMENT_COMPLETED {outcome_class, evidence_resolved, evidence_total}` |
| `leadcommand_workforce_request_research` | `{ client_request_id, assignment_id, claim_attempt, property_id? }` | `RESEARCH_REQUESTED {job_id, deduped}`: one job per (mission, property); the assignment returns to the agent when the job finishes (claim it again) |
| `leadcommand_workforce_handoff` | `{ client_request_id, assignment_id, to_employee_id \| to_coo, claim_attempt?, note? }` | `HANDED_OFF {to_employee_id, execution_mode}` |
| `leadcommand_workforce_escalate` | `{ client_request_id, assignment_id, reasons[1..8], note? }` | `ESCALATED {escalation_assignment_id}` |

Any `employee_id`, `actor`, `assignee*`, `requested_by`, `on_behalf_of`, `lease_owner`, … argument is `FORGED_CONTEXT`.

Deviations / decisions:
1. **Resource type.** Workforce intents use `resource_type 'system'`, id `workforce:<assignment|link|missions>` (the #26 CHECK is unchanged). Consequence: Workforce grants must not carry a `markets` scope (a system resource is in no market); market scope is the Workforce authority engine's (`employee.markets`).
2. **IDENTITY_MISMATCH** records through `grant_note_failure` and then suspends EVERY live `workforce.*` grant of the principal (stricter than "the grant"). The same for `EXTERNAL_REF_ALREADY_LINKED`.
3. **Owner additions 2026-10-22:** `employee_bind_principal(org, employee, agent, owner, link_window default 24 h ≤ 7 d, binding_valid_until default = credential expiry)` and `employee_unbind(org, employee, owner, reason)`; `BINDING_EXPIRED` / `BINDING_REVOKED` refuse every call (audited), an external lease never outlives the binding (clamped) and is released + reaped on unbind / detected expiry. A re-link of the same identity is a no-op even outside the window; the window governs the FIRST link. Lease generations: `claim_attempt` (the reaper bumps `attempt`). `on_external_timeout wait|reassign_internal` + `external_wait_seconds` (default wait, 3600 s) on the assignment, set by `workforce.assignment_set_external_policy`; the dispatch pass applies it (escalation once per assignee × attempt; reassignment through `assignment_transfer`, recorded).
4. **The sponsor of an Agntei principal must be the CEO user** (enforced by the bind). Workforce actions on the gateway are for `origin = agntei` employees only.
5. **External research return.** A completed job hands an external assignment back as `ready` with `output.research {job_id, result ≤ 12 KB}`; the claim itself resolves a finished job (no dispatch tick needed). Evidence `via`: `mission_job`, `principal_job`, `principal_intent(_job)`, `logged_read` (gateway reads now audit `record_refs` of the thread / property they name).
6. **Host switch.** The Workforce tools answer `capability_unavailable / WORKFORCE_DISABLED` unless the Action MCP host sets `LEADCOMMAND_ACTION_MCP_WORKFORCE_ENABLED=true` (→ the engine's own `WORKFORCE_ENABLED`).
7. **API.** "Register an Agntei agent" = `POST /employees {op:'register_agntei', employee}` (no new route file). The employee profile adds `activity`, `link`, `link_steps` (CEO only), `history {events, gateway}`.
8. **The live Claude Code milestone (2026-10-22).**
   - *Delegated triage* (`coo/playbooks.js`): an external (`operator_ai`) employee whose charter covers both `intel.active_opportunities` and `research.property` (an acquisition-type employee) relaying `opportunity_triage` / `offer_activity` with `assign_to_self` gets ONE research + recommendation step (`research.property`, `input.mode = delegated_review`, the candidates the internal `opps` read surfaced, its fixed assignee), then the COO's `memory` step; a directive naming no market is scoped to the relaying employee's markets. The candidate read that drives the plan is never an external agent's (it cannot return the structured candidates the expansion needs). Every other relay keeps the first-step rule (the scripted research-analyst milestone is unchanged).
   - *Staffing*: automatic staffing never parks an inline READ capability on an `operator_ai` employee (it would stall while its agent is offline); it falls back to the department head. External employees get internal work (research) by staffing and anything else only by explicit routing.
   - *Bounded pagination* (`actions/workforce/page.js`): whoami / list_assignments / get_mission / read_conversation_context answer inside ~5,600 characters of JSON (a client such as Agntei shows its model at most 8,000 per result). Lists page with `page.next_cursor`; a row too large on its own shows its largest members as `{_paged, read_with}` stubs; `list_assignments {assignment_id, part, cursor}` and `get_mission {part, cursor}` page one member. The conversation read always returns the permission state and facts whole and pages messages with `messages_page.older_cursor`. Nothing is cut silently; evidence refs are only ever moved behind a stub.
   - *Opaque property refs*: agent-facing Workforce reads keep a property ref as its `pid_` ref (decoded to digits it was masked as a phone number and could not be cited or researched).
