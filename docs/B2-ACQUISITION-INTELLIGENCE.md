# B2: acquisition intelligence for an external (Agntei) acquisition agent

Status: the safeguard is implemented and tested. The full design (§4) is specified and not built.

## 1. The problem (found by the Sterling certification, run 5)

The Workforce COO staffs `acquisition_agent` employees with engine-computed steps:

| Step | Capability |
|---|---|
| `opps` | `intel.active_opportunities` |
| `conv.*` | `intel.conversation_state` |
| `dec.*` | `intel.acquisition_decision` |
| `next.*` | `acq.next_action` |

For internal employees these run inline (`workforce/engine/dispatch.js:289`) through authoritative services: `listDealContexts` over `v_deal_context_cards`, `storedActionState`, `checkHold`, `checkSuppression`, `loadAcquisitionScore` + `getDealDecision` + `evaluateOfferReadiness` / `authoritativeMaxOffer` / `resolveValuationSpendability`.

An external agent cannot run them. Its completion schema is closed: `{summary, findings[], next_steps[], recommendation}` (`actions/workforce/index.js:41`). Worse, **an external `opps` completion carries no `candidates`**, so `expandCandidates` produces zero slots, and `after_opps` is marked expanded. **The result is a silently empty triage.**

## 2. Can the live Reader MCP supply the inputs?

The Reader is production, read-only, PII-free and provenance-stamped. **Partially, and not from the same source.**

| Engine input | Reader | Gap |
|---|---|---|
| `opps` candidates | `search_leads` (`eg_property_facts`) | Different read model from `v_deal_context_cards`. No hold / suppression / never-revive / closed exclusions. No `opportunity_id`, no property→conversation map. |
| `conv` state | `search_action_center` (same `agent.conversation_action_state`), `get_thread_hold_status` (same hold authority) | Cannot filter by property or conversation. No thread id per property. No message count. |
| `dec` decision | `get_acquisition_score` (same `property_acquisition_scores` rows) | No `getDealDecision`; `expected_assignment_fee` withheld; no engine MAO, `offer_ready`, spendability, engine comps. |
| `rank` / `next` | pure functions | nothing to supply |

Two more limits:

- The Reader's principal is the host's operator, not the agent's: there is no market scoping by agent.
- The Reader audits to its own file, not to `action_gateway.action_audit_events`. **A completion based on Reader reads can never be gateway-verified** (at most `partial`).

**Conclusion:** the Reader is the right DISCOVERY and context tool for Sterling's judgment, through a separate, read-only connection. It must NOT be the source of the structured outputs the plan consumes. Agent-authored candidates would let an agent inject property refs, relabel markets (bypassing `MARKET_OUT_OF_SCOPE`), point `conv` at another conversation, or feed price numbers to the authority engine.

## 3. Implemented now: the safeguard

`workforce/coo/staffing.js`:

- **The rule:** `EXTERNALLY_EXECUTABLE = ['research.property']` (the one capability with a gateway execution path, `workforce_request_research`).
- **Where it applies:** an external employee (origin `agntei` / `operator_ai`) is staffed ONLY for those capabilities, in initial staffing, `assign_to_self` (`engine/handlers.js`), plan expansion (`engine/dispatch.js`) and follow-ons (`capabilities/work-assign.js`).
- **Fallback:** engine-computed steps go to internal staff, else the department head, as before.
- **Proof:** `tests/critical/workforce-staffing-external-b2.test.mjs`, plus the existing coo / engine suites (23/23).

## 4. The design to build next ("the engine computes, the agent judges")

No new database grants for the gateway, and no duplicated business logic.

1. Mark the capability objects for opps, conv, dec, rank and next `engine_computed: true`.
2. **A dispatch "prepare external" pass.** For an external assignment of an engine-computed capability:
   - the same authority as `processOne` (`assignmentResource` + `checkHold` + `authorizeAssignment`);
   - then the SAME `cap.run(capCtx, input)`;
   - persisted through a new engine-only writer `workforce.assignment_prepare(org, assignment_id, output, outcome_class, evidence)`. It touches only external pending/ready rows and never status or lease. It sets `output.prepared = {at, capability, outcome_class, sources}`.
3. **The agent reads its prepared context:** the existing `workforce_list_assignments` already returns its rows' outputs. Optionally add a thin `workforce_get_assignment_context` (pure JS, existing reads).
4. **The agent adds judgment:** findings, next steps and a recommendation under `agent_annotation`. It may research further with the Reader (discovery) and request `property.research` (gateway).
5. **Completion of a prepared row:** `outcome_class` comes from `output.prepared`, never from agent claims. `NOT_PREPARED` refuses an unprepared engine-computed row. `ensureExpansions` requires `trigger.output.prepared`.
6. **Provenance / freshness / confidence** already exist on every capability output (`source(s)`, `computed_at`, `age_days`, `confidence`, `outcome_class`). Re-prepare after a TTL shorter than `external_wait_seconds`.
7. **PII:** capability outputs are ids / codes / timestamps only (`shared.js`, the payload guard). One divergence from the Reader: the projection exposes `opportunity_id` and `conversation_id` UUIDs. That is an owner decision.

**Tests to extend:**

- `workforce-engine`
- `workforce-capabilities`
- `workforce-coo:98`
- `workforce-agntei-flow-pg:43, 134`
- `workforce-authority-parity`
- `workforce-store-conformance`
- `workforce-migration-pg`
- `workforce-agntei-unit:54`
- `workforce-no-send-imports`
- `action-gateway-unit`
- `action-gateway-tools-pg`
