// LeadCommand Global AI Agent — streaming activity / event contracts (S1).
//
// Pure ESM, no imports. Source of truth: global-ai-agent-architecture.md §5.3
// (one event stream `agent.run_event`) and entity-graph-deep-research-design.md
// §4.3 (research event types, used verbatim; run_id = the research run).
//
// Rules the UI can rely on (enforced server-side by lib/agent/runtime/event-log.js):
//  * `event_id` is global and monotonic — it is the SSE id and the replay cursor.
//  * `seq` is per run, starts at 1 and is gapless. A gap means "refetch".
//  * Every event is appended by the code that performed the operation, in the
//    same transaction as the state change it describes. If no event arrived,
//    nothing is happening — the UI must never invent a step or a progress tick.
//  * Payloads are sanitized at insert with the per-type field whitelist below.
//    No credentials, internal hosts, stack traces, full phones/emails, raw SMS,
//    raw page text, or model thinking. `decision` summaries are user-facing
//    structured outputs (≤ 240 chars), never chain-of-thought.
//  * Every `label` on task.started / tool.started is rendered from a registered
//    operation template (OPERATION_LABEL_TEMPLATES) — labels map 1:1 to real
//    operation types.
//  * Fixture events carry `fixture: true`. Production events never do.

/**
 * Event envelope.
 * @typedef {Object} AgentEvent
 * @property {number} event_id            global, monotonic; SSE id + replay cursor
 * @property {string} run_id
 * @property {number} seq                 per-run, gapless, from 1
 * @property {string} type                one of EVENT_TYPES
 * @property {string} at                  ISO timestamp (server clock)
 * @property {number} attempt             task/tool attempt (1-based); retries never duplicate attempt 1
 * @property {'operator'|'internal'} visibility   internal events are never streamed to the UI
 * @property {string|null} property_id
 * @property {string|null} task_id
 * @property {string|null} tool_call_id
 * @property {Object} payload             sanitized per EVENT_PAYLOAD_FIELDS[type]
 * @property {true} [fixture]             present (true) only on fixture events
 * @property {number} [fixture_t_ms]      fixture only: recorded offset from the scenario start, for the player
 */

export const EVENT_SUMMARY_MAX_CHARS = 240

/** Event families (for UI grouping/filters). */
export const EVENT_FAMILIES = Object.freeze([
  'run',
  'message',
  'context',
  'plan',
  'tool',
  'approval',
  'artifact',
  'ui',
  'undo',
  'usage',
  'job',
  'property',
  'task',
  'source',
  'observation',
  'finding',
  'brief',
  'decision',
])

const COUNTERS = ['counters', 'accrued_usd']

/**
 * Per-type payload field whitelist. Anything not listed is dropped at insert.
 * This map IS the payload-shape contract for the UI.
 */
export const EVENT_PAYLOAD_FIELDS = Object.freeze({
  // ── run ────────────────────────────────────────────────────────────────
  'run.created': ['kind', 'title', 'objective_summary', 'budget_cap_usd', 'parent_run_id', 'depth'],
  'run.state': ['from', 'to', 'reason', ...COUNTERS],
  'run.completed': ['state', 'summary', ...COUNTERS],
  'run.failed': ['error_code', 'retryable', ...COUNTERS],
  'run.cancel_requested': ['requested_by', 'scope'],
  'run.cancelled': ['summary', 'after_cancel_settled_usd', ...COUNTERS],
  'run.budget_exhausted': ['binding_cap', ...COUNTERS],

  // ── message (no thinking, ever) ────────────────────────────────────────
  'message.operator': ['turn_id', 'text', 'client_msg_id'],
  'message.delta': ['turn_id', 'text'],
  'message.completed': ['turn_id', 'text'],
  decision: ['summary', 'basis_finding_ids', 'basis_refs', 'criterion'],

  // ── context ────────────────────────────────────────────────────────────
  'context.attached': ['app', 'object_refs', 'filter_summary', 'selection_count'],
  'context.detached': ['app', 'object_refs'],

  // ── plan ───────────────────────────────────────────────────────────────
  'plan.proposed': ['artifact_id', 'plan_hash_prefix', 'steps', 'estimate'],
  'plan.approved': ['artifact_id', 'plan_hash_prefix'],
  'plan.rejected': ['artifact_id', 'reason'],
  'plan.step_state': ['artifact_id', 'step_index', 'state'],
  // research planner (DR §4.3)
  'plan.task_added': ['task_id', 'operation', 'label', 'adapter_id', 'source_id', 'finding_type', 'depends_on', 'billable'],
  'plan.skipped_fresh': ['finding_type', 'cited_finding_id', 'canonical_ref', 'fresh_until', 'label'],

  // ── tool ───────────────────────────────────────────────────────────────
  'tool.proposed': ['tool', 'tool_version', 'tier', 'target_refs', 'intent_basis'],
  'tool.started': ['tool', 'tool_version', 'tier', 'operation', 'label', 'target_refs'],
  'tool.completed': ['tool', 'rows', 'duration_ms', 'cost_usd', 'result_summary', 'incomplete'],
  'tool.refused': ['tool', 'refusal_code', 'message'],
  'tool.failed': ['tool', 'error_code', 'retryable'],
  'tool.outcome_unknown': ['tool', 'readback_scheduled'],

  // ── approval ───────────────────────────────────────────────────────────
  'approval.requested': ['approval'],
  'approval.granted': ['approval_id', 'payload_hash_prefix', 'approver_display'],
  'approval.denied': ['approval_id', 'payload_hash_prefix', 'reason'],
  'approval.expired': ['approval_id', 'payload_hash_prefix'],
  'approval.invalidated': ['approval_id', 'payload_hash_prefix', 'drift'],
  'approval.consumed': ['approval_id', 'payload_hash_prefix'],

  // ── artifact ───────────────────────────────────────────────────────────
  'artifact.created': ['artifact_id', 'kind', 'version', 'title', 'status'],
  'artifact.updated': ['artifact_id', 'kind', 'version', 'status'],
  'artifact.applied': ['artifact_id', 'kind', 'version'],
  'artifact.superseded': ['artifact_id', 'superseded_by'],

  // ── ui (client applies via app registry; never auto-applied to pinned panes) ──
  'ui.intent': ['intent', 'destination', 'object_refs', 'params', 'label', 'draft_only'],

  // ── undo ───────────────────────────────────────────────────────────────
  'undo.available': ['tool_call_id', 'until', 'summary'],
  'undo.executed': ['tool_call_id', 'summary'],
  'undo.refused': ['tool_call_id', 'diff'],

  // ── usage / budget ─────────────────────────────────────────────────────
  'usage.reserved': ['reserve_id', 'op_type', 'route', 'provider', 'model', 'worst_case_usd', 'remaining_usd'],
  'usage.settled': ['reserve_id', 'op_type', 'route', 'provider', 'model', 'tokens', 'actual_usd', 'accrued_usd', 'remaining_usd'],
  'budget.stopped': ['binding_cap', 'next_op', 'worst_case_usd', 'remaining_usd'],

  // ── research job (DR §4.3, verbatim) ───────────────────────────────────
  'job.created': ['depth', 'property_count', 'estimate', 'cap'],
  'job.confirmed': ['depth', 'property_count', 'estimate', 'cap', 'scope_sentence'],
  'job.phase': ['phase'],
  'job.paused': COUNTERS,
  'job.resumed': COUNTERS,
  'job.cancel_requested': ['requested_by'],
  'job.cancelled': ['summary', ...COUNTERS],
  'job.budget_exhausted': ['binding_cap', ...COUNTERS],
  'job.completed': ['state', 'summary', ...COUNTERS],
  'job.failed': ['error_code', ...COUNTERS],
  'job.property_state': ['state', 'phase', 'opportunity_class', 'contact_readiness_class', 'display_address', 'counters'],

  // ── research task + source ─────────────────────────────────────────────
  'task.started': ['operation', 'label', 'source_id', 'adapter_id', 'finding_type'],
  'task.completed': ['duration_ms', 'cost_usd', 'finding_count'],
  'task.blocked': ['reason', 'duration_ms', 'alternatives'],
  'task.failed': ['error_code', 'duration_ms', 'retry_at'],
  'task.unavailable': ['reason', 'retry_at'],
  'task.needs_input': ['question', 'options'],
  'task.cancelled': ['after_cancel'],
  'source.searched': ['source_id', 'host', 'http_class', 'retrieved_at', 'fetch_id', 'purpose'],
  'source.opened': ['source_id', 'host', 'http_class', 'retrieved_at', 'fetch_id', 'purpose'],
  'source.retrieved': ['source_id', 'host', 'http_class', 'bytes', 'retrieved_at', 'fetch_id', 'purpose'],
  'source.blocked': ['source_id', 'host', 'reason', 'message', 'alternatives', 'retry_at'],
  'source.failed': ['source_id', 'host', 'reason', 'retry_at'],
  'observation.extracted': ['observation_ids', 'finding_type', 'display_value', 'citation'],
  'finding.upserted': ['finding'],
  'finding.conflict': ['conflict_group_id', 'finding_type', 'members', 'rule', 'resolution_state', 'best_supported', 'reason', 'remaining_uncertainty', 'follow_up'], // S3: +best_supported..follow_up (additive)

  // ── brief ──────────────────────────────────────────────────────────────
  'brief.section': ['section_key', 'label', 'claims', 'claim_count', 'finding_refs', 'property_id'], // S3: +property_id (additive)
  'brief.completed': ['opportunity_class', 'contact_readiness_class', 'sections_missing'],
})

/** All registered event types. Appending an unregistered type is refused. */
export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_PAYLOAD_FIELDS))

export function eventFamily(type) {
  const t = String(type || '')
  if (t === 'decision') return 'decision'
  if (t === 'budget.stopped') return 'usage'
  return t.split('.')[0]
}

/**
 * Operation label templates. Every `label` on task.started / tool.started /
 * plan.task_added is rendered from exactly one of these; the event log
 * refuses a label that does not re-render from its declared `operation`.
 */
export const OPERATION_LABEL_TEMPLATES = Object.freeze({
  'research.check': 'Checking {jurisdiction} {finding_label} ({source_name})',
  'research.match_parcel': 'Matching parcel in {source_name}',
  'research.extract': 'Extracting {finding_label} from {source_name}',
  'research.cross_check': 'Cross-checking {finding_label}: {source_name} vs {other_source_name}',
  'research.manual_link': 'Manual check needed: {source_name}',
  'research.synthesize_section': 'Writing brief section: {section_label}',
  'research.reuse_fresh': 'Reusing fresh {finding_label} ({source_name})',
  'tool.invoke': '{tool_label}',
})

/**
 * Render an operation label. Throws if the operation is unknown or a
 * placeholder is missing — a label can never be free text.
 * @param {string} operation
 * @param {Record<string,string|number>} vars
 */
export function renderOperationLabel(operation, vars = {}) {
  const template = OPERATION_LABEL_TEMPLATES[operation]
  if (!template) throw new Error(`UNKNOWN_OPERATION:${operation}`)
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    const value = vars[key]
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`OPERATION_LABEL_MISSING_VAR:${operation}:${key}`)
    }
    return String(value)
  })
}

/** Event types whose payload must carry `operation` + `label` (1:1 label rule). */
export const LABELLED_EVENT_TYPES = Object.freeze(['task.started', 'tool.started', 'plan.task_added'])

/**
 * Snapshot returned by GET /…/runs/:id (reduced server-side from events) so a
 * reloaded client can resume with Last-Event-ID = last_event_id.
 * @typedef {Object} RunSnapshot
 * @property {string} run_id
 * @property {string} kind
 * @property {string} state
 * @property {string|null} phase
 * @property {number} last_event_id
 * @property {number} last_seq
 * @property {Object} counters
 * @property {Object|null} cost
 * @property {boolean} fixture
 */

/**
 * Long-poll / replay response shape for GET …/events?after=<event_id>.
 * @typedef {Object} EventPage
 * @property {AgentEvent[]} events        ordered by event_id ascending
 * @property {number} cursor              last event_id in this page (or the request cursor)
 * @property {boolean} done               run reached a terminal state and the log is drained
 * @property {boolean} fixture
 */

/** Hard sanitizer patterns (also used by the server sanitizer). */
export const SANITIZE_FORBIDDEN_KEYS = Object.freeze([
  'thinking',
  'thinking_text',
  'reasoning',
  'chain_of_thought',
  'raw_text',
  'raw_html',
  'stack',
  'stack_trace',
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'approval_token',
])
