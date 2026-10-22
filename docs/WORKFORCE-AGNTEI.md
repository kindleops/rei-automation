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
| `workforce_open_mission` | internal | the CEO's directive relayed by an operator-directed agent. `requested_by` = the principal's sponsor (a named human), `origin=agntei`, `owner` = the COO. The COO plans it; with `assign_to_self=true` the first assignment goes to the caller |
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
