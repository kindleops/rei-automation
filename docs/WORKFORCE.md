# LeadCommand Workforce — architecture and Phase A contract

Status: Phase A (foundation). Branch `feat/workforce` on `612d1ef7`, which is rc-8.5.21.1 (`028b6039`) plus Action MCP T2–T4 (`377e0eca`).
Everything here is born OFF. Nothing here sends a seller message, places an offer, launches a campaign, or changes production.

## 0. What Workforce is, and what it is not

Workforce owns **coordination**:
- employees (AI and human) and the org hierarchy
- missions, assignments and their dependencies
- delegation, resource ownership and organizational memory
- KPIs and the executive conversation

Workforce never owns business records. Every fact it reports and every change it makes goes through the existing authoritative service:

| Concern | Authority (reused, never reimplemented) |
|---|---|
| Durable execution, leases, retries, budgets, emergency stop | R2 runtime `agent.research_job` + `agent.runtime_*` (PROPOSED_20261012140000_intel_runtime.sql), tick `POST /api/internal/agent/runtime/tick` |
| Research | `property.research` kind (missions/property-research-*.js), `mission.research` (ask-service) |
| Lead / property / thread context | deal-context-service.js `listDealContexts` / `getDealContextByProperty`, thread-context-service.js `loadThreadContext`, entity-graph-service.js |
| Stage | universal-lead-state-registry.js (`LIFECYCLE_STAGE_*`), resolve-seller-stage-transition.js (the only stage writer: Workforce never writes stage in Phase A) |
| Valuation / MAO / economics | deal-decision-service.js `getDealDecision`, offerReadiness.js `authoritativeMaxOffer` / `evaluateOfferReadiness`, valuation-offer-authority.js `resolveValuationSpendability`, laneValuation.js |
| Conversation action state | agent/operations/action-center.js `deriveActionState`, `agent.conversation_action_state` |
| Holds and exclusions | domain/holds/automation-hold-core.js (Hartford / Maxwell static exclusion + the registry when present), suppression |
| Operator work items | `agent.ops_work_item` (lease-bound writers) |
| Agent identity for mutations, standing grants, approvals, envelopes | Action Gateway (`action_gateway.*`, docs/ACTION-MCP.md): `agent_principals`, `capability_grants`, `approval_request`, D6 human decide |
| Seller messages | decideAndCompose / playbook v3 → canonical dispatch. **Not reachable from Workforce in Phase A.** |

## 1. Organization

Departments are a closed set (`department_key`):
- `executive` (CEO, COO)
- `finance` (CFO)
- `acquisitions`
- `marketing`
- `dispositions`
- `data_intelligence`
- `operations` (Operations and Quality Supervisor)

Roles are a closed set (`role_key`): `ceo`, `coo`, `cfo`, `head_acquisitions`, `acquisition_agent`, `head_marketing`, `campaign_manager`, `head_dispositions`, `dispositions_agent`, `head_data_intelligence`, `research_analyst`, `ops_supervisor`, `human_staff`.

Each role has a static **role charter** (code, `lib/workforce/org/charters.js`) covering:
- mandate, responsibilities and KPI keys
- the Workforce capabilities it may use
- its maximum authority tier

Charters are code so a deploy reviews them. Employees are rows. Markets, segments, the manager, status and memory are data.

The seed (migration seed + `lib/workforce/org/seed.js`) creates the executive staff:
- CEO = the owner (a human row bound to the owner's user id)
- COO "Atlas", CFO "Ledger", plus one head per department, the Ops Supervisor, and one research analyst
- **No acquisition agents are seeded with markets.** The CEO (or COO, through a proposal) creates them per market from the UI or API.

## 2. Data model (schema `workforce`, one migration, PROPOSED)

File: `supabase/migrations/PROPOSED_20261022100000_workforce_foundation.sql` (+ `_rollback`, `_pretest`, `_posttest`, `_rollback_posttest`). The S3/R2 conventions apply verbatim:
- revoke-all defaults
- RLS ENABLED + FORCED
- `agent_api` writes only through SECURITY DEFINER functions
- `authenticated` reads through `agent.can_read_org(org_id)`
- every jsonb column has `CHECK (agent.payload_is_clean(col))`
- every human-text column has `CHECK (agent.payload_string_violation(col, 'text', 0) IS NULL)`, or the equivalent phone/email refusal; verify the actual signature in the S3 file
- property ids in jsonb use the mission codec (`pid_…`, missions/mission-codec.js)

| Table | Key columns | Notes |
|---|---|---|
| `workforce.employee` | `employee_id text pk ^emp_[a-z0-9_]{3,40}$`, `org_id`, `kind ai\|human`, `role_key`, `department_key`, `display_name`, `employee_code` (e.g. `ACQ-01`), `manager_employee_id` (FK), `user_id uuid` (humans; the CEO row = owner), `action_principal_id text` (nullable link to `action_gateway.agent_principals.agent_id`; mutations need it), `status active\|paused\|retired`, `markets text[]`, `segments jsonb`, `tier_ceiling T1\|T2` (Phase A max T2, CHECK), `spend_day_cap_usd numeric ≤ 5`, `heartbeat_at`, `last_activity_at`, `created_by uuid` (named operator) | the CEO row has `kind=human, role_key=ceo`, and it is the only `ceo` row (partial unique index) |
| `workforce.mission` | `mission_id text pk ^wfm_<uuid>$`, `org_id`, `title`, `directive` (CEO text, phone/email refused), `objective jsonb` (normalized intent), `playbook_key`, `owner_employee_id` (the COO), `requested_by uuid` (named operator), `status planning\|active\|waiting\|blocked\|completed\|failed\|cancelled`, `priority 0..100`, `due_at`, `plan jsonb` + `plan_version int`, `report jsonb` (verified results; see §6), `idempotency_key` unique per org, `created_at/updated_at/completed_at` | one directive submission = one mission. A replayed submission returns the same mission |
| `workforce.assignment` | `assignment_id text pk ^wfa_<uuid>$`, `mission_id` FK, `parent_assignment_id`, `step_key` (unique per mission), `capability_key` (closed catalog §4), `assignee_employee_id`, `delegated_by_employee_id`, `status pending\|ready\|leased\|running\|waiting_job\|waiting_approval\|blocked\|completed\|failed\|cancelled`, `depends_on text[]` (step keys), `input jsonb`, `output jsonb`, `outcome_class verified\|partial\|unknown\|refused`, `evidence jsonb` (source refs), `runtime_job_id text` (`mjob_…` it is waiting on), `resource_type`, `resource_key`, `attempt`, `max_attempts ≤ 5`, `next_attempt_at`, `lease_token uuid`, `lease_until`, `last_error jsonb`, timestamps | the durable unit of delegated work. Survives restarts. Transfer = re-assign + event |
| `workforce.resource_claim` | `org_id`, `resource_type thread\|property\|opportunity\|campaign`, `resource_key`, `employee_id`, `assignment_id`, `claimed_at`, `expires_at`, `released_at` | partial unique index on (org, type, key) WHERE released_at IS NULL. Two agents can never hold one seller or property at once. Expired claims are reapable |
| `workforce.event` | `event_id bigserial`, `org_id`, `at`, `mission_id`, `assignment_id`, `employee_id`, `type ^wf\.[a-z_.]+$`, `payload jsonb ≤ 8KB` | append-only (guard trigger): the Operations feed |
| `workforce.exec_message` | `message_id`, `org_id`, `mission_id null`, `author ceo\|coo`, `author_user_id` / `author_employee_id`, `content text ≤ 8000` (phone/email refused), `refs jsonb` (record links), `created_at` | the Executive Command conversation. Not seller SMS |
| `workforce.memory_fact` | `fact_id uuid`, `org_id`, `scope company\|department\|employee\|mission\|property\|market`, `scope_key`, `fact_key`, `value jsonb`, `epistemic verified\|interpretation\|ceo_policy`, `confidence 0..1 null`, `source_refs jsonb NOT NULL` (verified ⇒ ≥ 1 ref), `author_employee_id` / `author_user_id`, `valid_from`, `superseded_by uuid`, `superseded_at` | supersede-only, never update `value`. One live fact per (org, scope, scope_key, fact_key, epistemic). `ceo_policy` can be authored only by the CEO user. An `interpretation` never becomes `verified` without a source ref |
| `workforce.authority_policy` | `policy_id`, `org_id`, `role_key` or `employee_id`, `action_key` (a Workforce capability key or an Action Gateway action name), `scope jsonb` {markets, property_types, resource_types}, `limits jsonb` {per_day, max_usd, max_price}, `risk ≤ low\|medium\|high`, `min_confidence`, `review ceo\|coo\|none`, `valid_from/valid_until`, `status active\|revoked`, `created_by` (CEO user only), version + supersedes | the Delegation & Authority Engine's policy table. In Phase A it is **declarative**: the engine evaluates it for internal (T1) Workforce capabilities and *proposes* Action Gateway `capability_grants`. It never creates grants. Grants stay owner-created (principal_guard) |
| `workforce.settings` | `org_id pk`, `exec_review_price_usd` default 5,000,000, `escalation jsonb` | the CEO-configurable escalation thresholds |
| `workforce.kpi_snapshot` | `org_id`, `subject_type employee\|department\|org`, `subject_key`, `kpi_key`, `window`, `value numeric NULL`, `status known\|unknown`, `source jsonb`, `computed_at` | unknown is a first-class value, never 0 |

Writer functions (SECURITY DEFINER, `agent_api`), at minimum:
- `workforce.mission_open(...)`: idempotent
- `workforce.mission_set_plan(mission_id, plan, plan_version_expected)`: optimistic version
- `workforce.mission_transition(mission_id, to, report?)`
- `workforce.assignment_create(...)`: idempotent on (mission, step_key)
- `workforce.assignment_claim(org, owner, limit, lease_seconds)`: FOR UPDATE SKIP LOCKED over `ready` (or past `next_attempt_at`) rows whose dependencies are all completed. Sets the lease
- `workforce.assignment_progress(assignment_id, lease_token, patch)`
- `workforce.assignment_finish(assignment_id, lease_token, status, output, outcome_class, evidence, error, retry_after_seconds)`
- `workforce.assignment_wait_job(assignment_id, lease_token, runtime_job_id)`
- `workforce.assignment_reap(now)`: expired leases → ready with attempt+1, or failed past max
- `workforce.assignment_transfer(assignment_id, to_employee, by)`
- `workforce.resource_claim_acquire(...)` / `_release` / `_reap`
- `workforce.event_append(...)`
- `workforce.exec_message_append(...)`
- `workforce.memory_assert(...)`: supersede semantics
- `workforce.employee_upsert(...)`: CEO-authored. Through the API, ceo rows only by the owner
- `workforce.employee_heartbeat(...)`
- `workforce.policy_put(...)` / `_revoke`
- `workforce.kpi_put(...)`

The SQL enforces assignment transitions (`workforce.assignment_transition_ok`) through a guard trigger. Runtime state can be written only through the functions (the same pattern as the R2 guard).

## 3. Execution engine (24/7, durable, event-driven)

Workforce adds **three R2 runtime kinds**. All are born unarmed: absent from `kind_limits` means the DB never claims them. Each also needs `WORKFORCE_ENABLED=1`.

- **`workforce.coo_plan`** (event job, one per mission):
  1. Interpret the directive into `objective` + `playbook_key` (§5).
  2. Write the plan (a DAG of steps from the playbook).
  3. Create the assignments (idempotent).
  4. Set the mission `active`.
  5. Append the `wf.mission.planned` event and a COO `exec_message` summarizing the plan.
- **`workforce.dispatch`** (scheduled every 60s, and enqueued as an event whenever an assignment becomes ready):
  1. `assignment_reap`, `resource_claim_reap`.
  2. Claim ≤ N ready assignments.
  3. For each: check authority (§4.2) and holds and exclusions; then either run the capability inline (read-only capabilities, bounded by `tick_budget_ms`) or enqueue the existing runtime kind and park the assignment as `waiting_job`.
  4. `waiting_job` assignments are re-checked each pass against `agent.research_job` state. Completed → output = the job result (verified); failed → retry or failed.
  5. When every assignment of a mission is terminal, enqueue `workforce.mission_review`.
- **`workforce.mission_review`** (event job): the COO assembles the report from assignment outputs only (§6). It writes `mission.report`, completes the mission and posts the COO executive summary. Nothing in the report may come from a step that did not complete with `outcome_class ∈ {verified, partial}`; anything else is listed as pending, refused or unknown.

Crash and restart: all state lives in the DB. Leases expire and get reaped; a replayed event is idempotent (mission, step_key and the runtime idempotency keys). There are no in-process loops.

Requested-by: every Workforce runtime job's `requested_by` is the named operator who issued the directive (the R2 rule). The acting employee is attribution (`input.employee_id`), not authority.

Seller-facing timing rules don't apply in Phase A, because nothing seller-facing exists.

## 4. Capabilities and authority

### 4.1 The closed Workforce capability catalog (Phase A, `lib/workforce/capabilities/catalog.js`)

Every capability is either **read** (inline, no side effect) or **internal** (writes only Workforce rows or enqueues an existing internal runtime kind). There is no `send`, `offer`, `stage_write`, `campaign_launch` or `contact` capability in Phase A.

| key | class | role(s) | implementation |
|---|---|---|---|
| `intel.active_opportunities` | read | acquisitions, data_intelligence | deal-context `listDealContexts` / pipeline-command `getPipelineCommandOverview`, filtered to current markets, excluding suppressed, held and excluded |
| `intel.conversation_state` | read | acquisitions, ops | `loadThreadContext` + `deriveActionState` + holds + suppression |
| `intel.acquisition_decision` | read | acquisitions, finance | `getDealDecision` (no writes: never `ensurePropertyAcquisitionDecision`) |
| `finance.review_opportunity` | read | finance (CFO) | an independent check over the decision: valuation spendability, MAO present and authoritative, lane, comp evidence count and recency, confidence, ask-vs-MAO gap. Verdict `supported \| challenge \| insufficient_evidence` with reasons |
| `research.property` | internal | data_intelligence, acquisitions | enqueue `property.research` (existing kind, its own budget) and wait |
| `acq.rank_opportunities` | read | head_acquisitions | the ranking hierarchy (contact/identity → pressure → deal quality), EV only when calibrated inputs exist, otherwise `unknown` |
| `acq.next_action` | read | acquisition_agent | the next action per opportunity derived from stage + action state + holds + CFO verdict: one of `research`, `underwrite`, `await_seller`, `prepare_offer_recommendation` (internal only), `operator_review`, `hold`, `none` |
| `work.assign` | internal | coo, heads | create a follow-on Workforce assignment for an employee (including the human CEO queue) |
| `ops.raise_work_item` | internal | ops_supervisor | `agent.ops_work_item` through the existing writer when operations is enabled; otherwise a Workforce assignment for the CEO |
| `memory.assert` | internal | any | `workforce.memory_assert` (interpretations only for AI; verified needs a source ref) |

### 4.2 Delegation & Authority Engine (`lib/workforce/authority/`)

`authorize({ employee, capability, resource, context })` returns `allow | escalate | deny` plus reasons. In order:
1. **Kill switches:** `WORKFORCE_ENABLED`, the runtime emergency stop, employee status.
2. **The capability is in the charter** of the employee's role.
3. **Class ≤ the employee's tier ceiling.** Phase A internal = T1.
4. **Resource scope:** the market is in `employee.markets` for market-scoped roles.
5. **Holds, exclusions and suppression** for the resource. Hartford and Maxwell are always excluded.
6. **An active `authority_policy`** covering it (role or employee, action, scope, limits). With no policy, the charter default applies: read = allow, internal = allow up to the daily caps.
7. **Escalation rules.** A price ≥ `exec_review_price_usd`, valuation uncertainty, title ambiguity and similar give `escalate`. Escalation creates an assignment for the CEO (human) with the reasons. It is not a silent block.

Anything T2+ (Action Gateway mutations) goes through the **Action Gateway**, with the employee's `action_principal_id`. Phase A ships no T2 call path. The engine also exposes `proposeGrants(policy)`, which renders the `capability_grants` rows an owner would mint. It is display only.

## 5. The COO

`lib/workforce/coo/`:
- **`interpret.js`**: directive → `{ intent, markets?, count?, horizon?, focus? }`. A deterministic parser over a closed intent set comes first:
  - `opportunity_triage` ("find the N most promising … get them moving")
  - `market_diagnosis` ("why aren't Dallas campaigns producing …")
  - `conversation_revival` ("get every eligible seller conversation moving")
  - `offer_activity` ("increase profitable offer activity")
  - `status_review`
  - `unknown` → ask one clarifying question as a COO message; never guess

  An optional model call goes through the existing provider pattern (reserve/settle on the job). Its output is schema-validated against the same closed set and can only *choose among* playbooks; it can't create steps.
- **`playbooks.js`**: intent → a step DAG of catalog capabilities with assignee roles. Phase A fully implements `opportunity_triage` (the first demonstration):
  1. `intel.active_opportunities` (acq head)
  2. per candidate, `intel.conversation_state` + `intel.acquisition_decision`
  3. `research.property` where evidence is missing or stale (only within budget)
  4. `finance.review_opportunity` (CFO)
  5. `acq.rank_opportunities`
  6. `acq.next_action` per top N
  7. `work.assign` per next action
  8. `memory.assert` of the ranking as an interpretation

  The other intents get plans with the steps that exist, and are honest about the steps that don't.
- **`respond.js`**: the COO executive message. It describes the plan, the assignment states and the report. It never claims completion for a non-terminal assignment.
- **`staffing.js`**: picks the assignee for a role (by markets, the open-assignment count, and active status).

## 6. Reports and the honesty contract

A mission report has these sections, each item carrying record refs (property / thread / opportunity / job / assignment ids for linking):
- `completed[]`
- `pending[]`
- `escalations[]`
- `refused[]` (with reasons)
- `unknowns[]`
- `ranked[]`: rank, refs, the score components, the CFO verdict, the next action, the assignment id
- `costs` (from `agent.spend_ledger` via the job ids)

Tests assert that:
- every `completed` item maps to a terminal-success assignment;
- every number traces to a step output;
- an unknown is rendered as unknown.

## 7. API (`apps/api/src/app/api/cockpit/workforce/...`, thin routes → `lib/workforce/routes.js`)

All routes 404 unless `AGENT_ENABLED` and `WORKFORCE_ENABLED=1`; agent allowlist auth like the agent routes. Mutating routes use the named operator from the session (never from the body).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cockpit/workforce/overview` | org summary: departments, employees with status and open counts, missions by status, last events, runtime health, flags |
| GET/POST | `/api/cockpit/workforce/employees` | list / create or update (CEO) |
| GET | `/api/cockpit/workforce/employees/[id]` | profile: charter, authority, memory, assignments, KPIs, cost |
| GET/POST | `/api/cockpit/workforce/missions` | list / submit a directive. POST `{directive, client_request_id}` opens the mission, enqueues `workforce.coo_plan`, and returns `{mission}` |
| GET | `/api/cockpit/workforce/missions/[id]` | mission + plan + assignments + events + report |
| POST | `/api/cockpit/workforce/missions/[id]/cancel` | |
| GET | `/api/cockpit/workforce/assignments?status=&employee=` | the work queue |
| GET | `/api/cockpit/workforce/events?after=&mission=` | the operations feed (cursor) |
| GET/POST | `/api/cockpit/workforce/command` | the executive conversation. POST `{content, client_request_id}` either opens a mission (an actionable directive) or answers a status question from live data. It returns `{messages, mission?}` |
| GET/POST | `/api/cockpit/workforce/authority` | policies, settings, proposed grants; CEO put / revoke |
| GET | `/api/cockpit/workforce/kpis` | KPIs, unknown-aware |
| GET | `/api/cockpit/workforce/reports` | mission reports + the daily brief (reuses `conversation.review_digest` output where it exists) |

Response envelope: `{ ok: true, data }` / `{ ok: false, error, message }`, like the other cockpit routes.

## 8. Dashboard app (`apps/dashboard/src/modules/workforce/`)

- **Registered app:** `id: 'workforce'`, route `/workforce`, group `operations`, `desktop: true`, `desktopRail: true`, `mobile: false` (Phase A). `context: { propertyId: 'locator', threadKey: 'locator', opportunityId: 'query:opp' }`, only the keys it really reads.
- **Sections:** Executive Command (COO chat), Organization, Employees, Missions, Operations (events), Work Queue, Intelligence, Financial Performance, Authority Center, Reports.
- **Record refs** open through `openObjectBeside` / `handleObjectClick` (property → Deal Intelligence, thread → Inbox, opportunity → Pipeline). That is the split-screen contract.
- **Visual:** LC tokens only, the pane material (`--lc-pane-mat-*`), never accent tints for semantics. Dense, cinematic, live (`LCLive`), real states. A fixtures mode (`VITE_LC_WF_FIXTURES=1`) exists for proofs only and is labelled FIXTURE in the UI.

## 9. Flags (born-off registry)

| Flag | Default | Effect |
|---|---|---|
| `WORKFORCE_ENABLED` (env) | off | routes 404, handlers not registered |
| `kind_limits['workforce.*']` | absent | the DB never claims Workforce jobs |
| `runtime_schedule 'workforce-dispatch'` | seeded `enabled=false` | |
| `WORKFORCE_MODEL_INTERPRET` (env) | off | deterministic interpreter only |

Add these to `tests/critical/rc-8.5.21-born-off.test.mjs` (or a sibling `workforce-born-off.test.mjs` in the same style), and to the Worker `AGENT_FORWARDED_VARS` only when a deploy is approved.

## 10. Phases

- **A (this branch):** the foundation + the first demonstration on a disposable DB with production-shaped fixtures, plus a read-only production preview through RO credentials when the owner approves.
- **B:** connect underwriting refresh, follow-up preparation (drafts only) and campaign analysis, behind flags.
- **C:** multi-agent department coordination, KPIs computed from analytics_performance, reassignment.
- **D:** delegated seller-facing authority through Action Gateway grants + envelopes, after its own qualification. The current failed autonomous-messaging qualification is not bypassed.
- **E:** hybrid human/AI organization.

## 11. Store interface (the contract between the DB layer and the engine)

`lib/workforce/store/index.js` exports `createWorkforcePgStore({ pool })` and `createWorkforceMemoryStore({ now })`. Both implement the same async interface, and both have the same semantics (idempotency, transition rules, lease checks, supersede rules, unique resource claims). The memory twin is the engine's unit-test store, so the two must not diverge: a shared conformance test file (`tests/critical/workforce-store-conformance.test.mjs`) runs the same cases against both, with PG via `agent-pg-harness` (skipped with a reason when no PG).

Ids are generated by the store: `emp_` (caller-provided slug), `wfm_<uuid>`, `wfa_<uuid>`. Times are ISO strings in, ISO strings out. Errors are thrown as `WorkforceStoreError { code }`, where code ∈ `NOT_FOUND`, `CONFLICT`, `LEASE_LOST`, `ILLEGAL_TRANSITION`, `PAYLOAD_REFUSED`, `CLAIM_HELD`, `VERSION_MISMATCH`, `FORBIDDEN`.

```
// org / employees
listEmployees({ org_id, status? }) → Employee[]
getEmployee({ org_id, employee_id }) → Employee | null
upsertEmployee({ org_id, employee, actor_user_id }) → Employee           // idempotent on employee_id
heartbeatEmployee({ org_id, employee_id, at? }) → void
// missions
openMission({ org_id, title, directive, requested_by, owner_employee_id, priority?, due_at?, idempotency_key }) → { mission, created: boolean }
getMission({ org_id, mission_id }) → Mission | null
listMissions({ org_id, status?, limit?, before? }) → Mission[]
setMissionPlan({ org_id, mission_id, objective, playbook_key, plan, expected_version }) → Mission   // plan_version+1
transitionMission({ org_id, mission_id, to, report? }) → Mission
// assignments
createAssignment({ org_id, mission_id, step_key, capability_key, assignee_employee_id, delegated_by_employee_id, depends_on?, input?, resource_type?, resource_key?, max_attempts?, parent_assignment_id? }) → { assignment, created }
getAssignment({ org_id, assignment_id }) → Assignment | null
listAssignments({ org_id, mission_id?, status?, assignee_employee_id?, limit? }) → Assignment[]
claimAssignments({ org_id, owner, limit, lease_seconds, now? }) → Assignment[]   // only ready/retry-due rows whose depends_on steps are all 'completed'; pending→ready promotion happens inside
progressAssignment({ org_id, assignment_id, lease_token, patch }) → Assignment   // patch: { status?: 'running', output? (merge), evidence? }
waitAssignmentOnJob({ org_id, assignment_id, lease_token, runtime_job_id }) → Assignment   // → waiting_job, lease released
resumeWaitingAssignments({ org_id, resolver }) → number      // resolver(runtime_job_id) → {state, result, error}; completed→completed(verified) ; failed→retry/failed
finishAssignment({ org_id, assignment_id, lease_token, status, output?, outcome_class, evidence?, error?, retry_after_seconds? }) → Assignment
transferAssignment({ org_id, assignment_id, to_employee_id, actor }) → Assignment
cancelMissionAssignments({ org_id, mission_id }) → number
reapAssignments({ org_id, now? }) → { requeued, failed }
// resource ownership
acquireResourceClaim({ org_id, resource_type, resource_key, employee_id, assignment_id, ttl_seconds }) → Claim   // throws CLAIM_HELD if another active holder
releaseResourceClaim({ org_id, resource_type, resource_key, assignment_id }) → void
reapResourceClaims({ org_id, now? }) → number
// events / conversation / memory
appendEvent({ org_id, type, mission_id?, assignment_id?, employee_id?, payload? }) → Event
listEvents({ org_id, after_event_id?, mission_id?, limit? }) → Event[]
appendExecMessage({ org_id, author, author_user_id?, author_employee_id?, content, refs?, mission_id? }) → ExecMessage
listExecMessages({ org_id, mission_id?, limit?, before? }) → ExecMessage[]
assertMemoryFact({ org_id, scope, scope_key, fact_key, value, epistemic, confidence?, source_refs, author_employee_id?, author_user_id? }) → Fact   // supersedes the live fact of the same identity
listMemoryFacts({ org_id, scope?, scope_key?, include_superseded? }) → Fact[]
// authority / settings / KPIs
listPolicies({ org_id, status? }) → Policy[]
putPolicy({ org_id, policy, actor_user_id }) → Policy       // CEO only (checked by the route + SQL owner check)
revokePolicy({ org_id, policy_id, actor_user_id }) → Policy
getSettings({ org_id }) → Settings
putSettings({ org_id, patch, actor_user_id }) → Settings
putKpi({ org_id, subject_type, subject_key, kpi_key, window, value, status, source }) → void
listKpis({ org_id, subject_type?, subject_key? }) → Kpi[]
```

Assignment transition table (SQL `workforce.assignment_transition_ok` and JS `ASSIGNMENT_TRANSITIONS` must be identical):
- `pending → ready | cancelled`
- `ready → leased | cancelled`
- `leased → running | ready (reap/release) | completed | failed | waiting_job | waiting_approval | blocked | cancelled`
- `running → completed | failed | ready (retry) | waiting_job | waiting_approval | blocked | cancelled`
- `waiting_job → ready | completed | failed | cancelled`
- `waiting_approval → ready | cancelled | failed`
- `blocked → ready | cancelled`
- terminal: `completed`, `failed`, `cancelled`

Mission transitions:
- `planning → active | failed | cancelled`
- `active → waiting | blocked | completed | failed | cancelled`
- `waiting → active | completed | failed | cancelled`
- `blocked → active | cancelled | failed`

### §8 implementation notes (dashboard, feat/workforce-ui)

- **Where:** `apps/dashboard/src/modules/workforce/`: `api/wf-client.ts` (every §7 call, one file), `api/wf-normalize.ts` (missing or mistyped fields become `null`, rendered "Unknown"), `model/` (pure view model: org tree, progress, plan DAG, report reconciliation, costs), `store/wf-hooks.ts` (keyed GETs on one live clock: 20 s, 4 s while a mission moves, 120 s when the pane is hidden), `ui/` (ten sections), `fixtures/` (DEV + `VITE_LC_WF_FIXTURES=1` only; every fixture body carries `fixture: true` and the live channel refuses such a body). Registered as app `workforce` at `/workforce` (desktop only, rail, group operations, minW 440).
- **Failure states:** a 404 (or the HTML 404 page) is "not enabled" with the switches, 401 session, 403 allowlist or CEO-only, 409 conflict, 422 payload refused, 423 emergency stop. Never an empty organization.
- **Mutations used:** POST `/command` (`{content, client_request_id}`), POST `/missions/[id]/cancel`, POST `/authority` revoke. POST `/missions` and POST `/employees` are typed in the client; the UI submits directives through `/command`.
- **Honesty on the client:** a report item listed as completed whose assignment is not `completed` is moved to pending and flagged; a cost total exists only when every report's cost is known; a "verified" fact without a source ref is shown as an interpretation; a KPI is known only with `status: known` and a number.
- **Fields assumed beyond §7 (all optional; absent renders Unknown):**
  - overview: `departments[] {department_key, head_employee_id, employee_count, open_assignments}`, `employees[].open_assignments`, `runtime {emergency_stop, last_tick_at, kinds_armed[], dispatch_enabled, detail}`, `flags {name: bool|string}`, `last_events[]`.
  - missions list rows: `assignment_counts {status: n}`.
  - `mission.plan = {steps: [{step_key, capability_key, label, assignee_role, assignee_employee_id, depends_on[], fan_out, unavailable_reason}]}`; fan-out assignments use `step_key` `<step>.<n>` (or `<step>:<key>`).
  - mission detail: `{mission, assignments[], events[]}`; `plan` / `report` may also sit beside `mission`.
  - assignment: `blocked_reason` (why blocked / waiting_approval), `resource_label` (the property address for a chip).
  - refs (`refs`, `evidence`, `source_refs`, `payload.refs`): `{type: property|thread|opportunity|job|assignment|mission|employee|market, id, label, property_id?, thread_key?, opportunity_id?}`, property ids decoded (a `pid_…` is decoded defensively).
  - report: `summary`, `generated_at`; items `{label, assignment_id, step_key, status, refs[], reasons[] | reason, detail}`; `ranked[] {rank, label, market, refs[], components {contact, pressure, deal_quality (0..1 or 0..100), ev_usd|null, ev_reason}, cfo_verdict {verdict, reasons[]}, next_action {action, reason}, assignment_id}`; `costs {total_usd, status known|unknown, reason, by_job[] {runtime_job_id, kind, assignment_id, usd}}`.
  - events: `?before=<event_id>` for older pages and `?limit=`; response `{events[], next_after}`.
  - employee profile: `{employee, charter {mandate, responsibilities[], kpi_keys[], capabilities[], max_tier}, authority {policies[]}, memory[], assignments[], kpis[], cost {today_usd, window_usd, window, cap_usd, status, reason}}`.
  - authority: `{policies[], settings {exec_review_price_usd, escalation{}}, proposed_grants[] {agent_id, employee_id, action, scope, limits, from_policy_id, note}, restrictions[] {kind hold|exclusion|suppression, label, reason, refs[], since}, emergency {stop, reason, since}, flags{}}`; POST body `{op: 'revoke', policy_id}` / `{op: 'put', policy}`.
  - kpis: `source.reason` explains an unknown.
  - reports: `{reports[] {mission_id, title, status, completed_at, report}, daily_brief {available, generated_at, summary, items[], code}}`.
- **Proof:** `apps/dashboard/scripts/proof/desktop/workforce-capture.mjs` (read-only: non-GET aborted, local `/api` GETs answered empty, other hosts aborted) against `VITE_LC_WF_FIXTURES=1 npx vite --port 5419`.
