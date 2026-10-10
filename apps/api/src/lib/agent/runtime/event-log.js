// THE agent event stream (architecture §5.3, DR §4.3) — append-only.
//
//  * event_id: global, monotonic (SSE id + replay cursor)
//  * seq: per run, gapless, from 1
//  * appended INSIDE the caller's transaction (appendEventTx) so the event and
//    the state change commit or roll back together
//  * payload sanitized at insert with the per-type whitelist
//  * labels on task.started / tool.started / plan.task_added are rendered here
//    from a registered operation template; a caller-supplied label that does
//    not re-render is refused (labels map 1:1 to real operation types)
//  * task-scoped events are idempotent on (run_id, task_id, type, attempt)
//  * fixture events are refused unless the log was created for fixtures
import { EVENT_PAYLOAD_FIELDS, LABELLED_EVENT_TYPES, renderOperationLabel } from '../contracts/events.js'
import { sanitizeEventPayload } from './sanitize.js'
import { AgentError } from './store.js'

const TASK_SCOPED_PREFIXES = ['task.', 'source.', 'observation.']

function isTaskScoped(type, task_id) {
  return Boolean(task_id) && TASK_SCOPED_PREFIXES.some((p) => type.startsWith(p))
}

/**
 * Append one event inside an open transaction.
 * @param {import('./store.js').AgentStoreTx} tx
 * @param {Object} input
 * @param {{ allowFixture?: boolean, now?: () => Date }} [opts]
 */
export function appendEventTx(tx, input, opts = {}) {
  const {
    run_id,
    type,
    payload = {},
    property_id = null,
    task_id = null,
    tool_call_id = null,
    attempt = 1,
    visibility = 'operator',
    label_vars = null,
    fixture = false,
  } = input || {}
  if (!run_id) throw new AgentError('EVENT_RUN_REQUIRED', 'run_id is required')
  if (!EVENT_PAYLOAD_FIELDS[type]) throw new AgentError('UNREGISTERED_EVENT_TYPE', `event type ${type} is not registered`)
  if (visibility !== 'operator' && visibility !== 'internal') throw new AgentError('EVENT_VISIBILITY_INVALID', String(visibility))
  if (fixture && !opts.allowFixture) throw new AgentError('FIXTURE_EVENT_REFUSED', 'fixture events cannot enter a live event log')
  if (!tx.runs.has(run_id)) throw new AgentError('EVENT_RUN_UNKNOWN', `run ${run_id} does not exist`)
  // actor stamp (Gate B): every event carries the run's named operator (the DB re-checks equality)
  const actor_user_id = String(tx.runs.get(run_id).operator_id ?? '') || null
  if (!actor_user_id) throw new AgentError('EVENT_ACTOR_REQUIRED', `run ${run_id} has no operator`)

  const raw = { ...payload }
  if (LABELLED_EVENT_TYPES.includes(type)) {
    if (!raw.operation) throw new AgentError('EVENT_OPERATION_REQUIRED', `${type} requires a registered operation`)
    let rendered
    try {
      rendered = renderOperationLabel(raw.operation, label_vars || {})
    } catch (error) {
      throw new AgentError('EVENT_LABEL_UNRENDERABLE', error.message)
    }
    if (raw.label !== undefined && raw.label !== rendered) {
      throw new AgentError('EVENT_LABEL_MISMATCH', 'label must be rendered from the registered operation template')
    }
    raw.label = rendered
  }

  if (isTaskScoped(type, task_id)) {
    const dup = tx.events.find((e) => e.run_id === run_id && e.task_id === task_id && e.type === type && e.attempt === attempt)
    if (dup) return { event: dup, duplicate: true }
  }

  const { payload: clean } = sanitizeEventPayload(type, raw)
  tx.counters.event_id += 1
  tx.counters.seq[run_id] = (tx.counters.seq[run_id] || 0) + 1
  const now = opts.now ? opts.now() : new Date()
  const event = {
    event_id: tx.counters.event_id,
    run_id,
    seq: tx.counters.seq[run_id],
    type,
    at: now.toISOString(),
    attempt,
    visibility,
    property_id,
    task_id,
    tool_call_id,
    actor_user_id,
    payload: clean,
  }
  if (fixture) event.fixture = true
  tx.events.push(event)
  return { event, duplicate: false }
}

/**
 * Event log facade: replay, tail, long-poll. Appends go through appendEventTx
 * inside service transactions; `append` is a convenience for single-event txs.
 */
export function createEventLog({ store, allowFixture = false, now = () => new Date() } = {}) {
  if (!store) throw new Error('store required')
  const waiters = new Set()
  store.onCommit((events) => {
    for (const w of [...waiters]) {
      if (events.some((e) => (!w.run_id || e.run_id === w.run_id) && e.event_id > w.after && e.visibility === 'operator')) {
        waiters.delete(w)
        w.resolve()
      }
    }
  })

  function append(input) {
    return store.transaction((tx) => appendEventTx(tx, input, { allowFixture, now }))
  }

  /**
   * Replay operator-visible events after a cursor (exclusive).
   * @returns {{ events: Object[], cursor: number }}
   */
  function replay({ run_id = null, after = 0, limit = 500 } = {}) {
    const cursor = Number(after) || 0
    const max = Math.max(1, Math.min(Number(limit) || 500, 2000))
    const out = []
    for (const e of store.read().events) {
      if (e.event_id <= cursor) continue
      if (run_id && e.run_id !== run_id) continue
      if (e.visibility !== 'operator') continue
      out.push(e)
      if (out.length >= max) break
    }
    return { events: out, cursor: out.length ? out[out.length - 1].event_id : cursor }
  }

  /** Long-poll: resolve with new events after `after`, or an empty page at timeout. */
  async function poll({ run_id = null, after = 0, limit = 500, timeout_ms = 2000 } = {}) {
    const first = replay({ run_id, after, limit })
    if (first.events.length || timeout_ms <= 0) return first
    await new Promise((resolve) => {
      const w = { run_id, after: Number(after) || 0, resolve }
      waiters.add(w)
      const t = setTimeout(() => {
        waiters.delete(w)
        resolve()
      }, Math.min(timeout_ms, 30_000))
      void t
    })
    return replay({ run_id, after, limit })
  }

  /** Detect seq gaps for a run (should always be empty — a gap is a defect). */
  function gaps(run_id) {
    const seqs = store.read().events.filter((e) => e.run_id === run_id).map((e) => e.seq)
    const missing = []
    for (let i = 0; i < seqs.length; i += 1) if (seqs[i] !== i + 1) missing.push(i + 1)
    return missing
  }

  return { append, replay, poll, gaps, allowFixture }
}

/** SSE serialization of an event page (id = event_id, the Last-Event-ID cursor). */
export function toSse(events) {
  return events.map((e) => `id: ${e.event_id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
