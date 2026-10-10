// Agent persistence — repository interfaces + in-memory adapter (S1).
//
// S1 persists NOTHING to a database. Every service takes a `store` that
// implements the interface below; the only implementation is this in-memory
// (or fixture-seeded) adapter. The PROPOSED `agent` schema
// (supabase/migrations/PROPOSED_20261008200000_agent_schema.sql, NOT applied)
// is the durable target with identical semantics.
//
// Transactions: `store.transaction(fn)` serializes callers (emulating
// SELECT … FOR UPDATE on the run row) and rolls back every table on throw, so
// "state change + event insert in the same transaction" holds: if the state
// change fails, the event does not exist, and vice versa.
//
// @typedef {Object} AgentStoreTx
// @property {Map<string,Object>} runs           agent.run
// @property {Array<Object>} events              agent.run_event (append-only)
// @property {Map<string,Object>} toolCalls      agent.tool_call
// @property {Map<string,Object>} approvals      agent.approval
// @property {Array<Object>} ledger              agent.usage_ledger (append-only)
// @property {Map<string,Object>} artifacts      agent.artifact
// @property {Array<Object>} audit               agent.action_audit (append-only)
// @property {Map<string,Object>} idempotency    idempotency_ledger (scope agent.*)
// @property {Map<string,Object>} researchJobs   research.job (1:1 extension of agent.run)
// @property {Map<string,Object>} researchTasks  research.task
// @property {Map<string,Object>} findings       research.finding
// @property {Map<string,Object>} conflicts      research.finding_conflict (S3)
// @property {Object} counters                   sequence generators
//
// @typedef {Object} AgentStore
// @property {(fn: (tx: AgentStoreTx) => any) => Promise<any>} transaction
// @property {() => AgentStoreTx} read           read-only view (no locking)
// @property {(cb: (events: Object[]) => void) => () => void} onCommit
// @property {'memory'|'file'} kind
//
// S3: runtime/file-store.js is a durable local-dev adapter with this exact
// interface (JSON file under a gitignored dir; survives an API restart).

export function emptyState() {
  return {
    runs: new Map(),
    events: [],
    toolCalls: new Map(),
    approvals: new Map(),
    ledger: [],
    artifacts: new Map(),
    audit: [],
    idempotency: new Map(),
    researchJobs: new Map(),
    researchTasks: new Map(),
    findings: new Map(),
    conflicts: new Map(),
    counters: { event_id: 0, ledger_id: 0, audit_id: 0, seq: {} },
  }
}

function cloneState(state) {
  // structuredClone preserves Maps; functions are never stored in state.
  return structuredClone(state)
}

/** @returns {AgentStore} */
export function createInMemoryAgentStore() {
  let state = emptyState()
  let chain = Promise.resolve()
  const listeners = new Set()

  async function transaction(fn) {
    const run = async () => {
      const before = cloneState(state)
      const eventCountBefore = state.events.length
      try {
        const result = await fn(state)
        const committed = state.events.slice(eventCountBefore)
        if (committed.length) for (const cb of listeners) {
          try { cb(committed) } catch { /* listener errors never roll back a commit */ }
        }
        return result
      } catch (error) {
        state = before
        throw error
      }
    }
    const p = chain.then(run, run)
    chain = p.then(() => undefined, () => undefined)
    return p
  }

  return {
    kind: 'memory',
    transaction,
    read: () => state,
    onCommit(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/** Error with a stable machine code (refusals, guard failures). */
export class AgentError extends Error {
  constructor(code, message, details = {}) {
    super(message || code)
    this.name = 'AgentError'
    this.code = code
    this.details = details
  }
}
