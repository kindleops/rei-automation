// Live run events for the research agent (Intelligence 2.0, increment A).
//
// Every event is emitted by the server at the moment the thing happened — never
// predicted, never timed: run_start, model_call_start / model_call_end,
// tool_start / tool_end (tool name, rows, outcome), web_search (counts from the
// provider's usage), text_delta (masked answer text as the model streams it),
// result, and exactly one terminal event: completed | failed | cancelled.
// No percentages, no estimates. Payloads carry codes, counts, tool names and
// masked text only (no tool inputs, no provider messages).
//
// The buffer is per run, in process (the API runs as one container), capped; a
// subscriber replays from a sequence number and then follows live. The poll
// endpoint (GET /ask/:run_id) stays the durable truth.

export const RUN_EVENT_TYPES = Object.freeze(['run_start', 'model_call_start', 'model_call_end', 'tool_start', 'tool_end', 'web_search', 'text_delta', 'result', 'completed', 'failed', 'cancelled'])
export const TERMINAL_EVENTS = Object.freeze(['completed', 'failed', 'cancelled'])
const MAX_EVENTS = 4000

export function createRunEvents({ now = () => Date.now() } = {}) {
  const events = []
  const listeners = new Set()
  let seq = 0
  let closed = false
  let dropped = 0
  function push(type, data = {}) {
    if (closed || !RUN_EVENT_TYPES.includes(type)) return null
    const ev = { seq: ++seq, type, at: new Date(now()).toISOString(), ...data }
    if (events.length >= MAX_EVENTS && type === 'text_delta') { dropped += 1; return null } // the final answer still arrives on the terminal event
    events.push(ev)
    for (const l of listeners) { try { l(ev) } catch { /* a broken subscriber never breaks the run */ } }
    if (TERMINAL_EVENTS.includes(type)) {
      closed = true
      for (const l of listeners) { try { l(null) } catch { /* ignore */ } }
      listeners.clear()
    }
    return ev
  }
  /** Replay events after `after`, then follow live. fn(null) marks the end. Returns unsubscribe. */
  function subscribe(after, fn) {
    for (const ev of events) if (ev.seq > after) fn(ev)
    if (closed) { fn(null); return () => {} }
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  return { push, subscribe, get closed() { return closed }, get events() { return events.slice() }, get dropped() { return dropped } }
}

/** The failure class shown to the operator ("Failed: <class>"), from the outcome code. */
export function refusalClass(code, state = null) {
  const c = String(code || '').toUpperCase()
  if (state === 'cancelled' || c === 'CANCELLED') return 'cancelled'
  if (/TIMEOUT|STALLED/.test(c)) return 'timeout'
  if (/^AGENT_(SPEND|ESCALATION)_CAP_|^DAILY_RUN_CAP$|BUDGET/.test(c)) return 'budget'
  if (/^(MODELS?_UNRESOLVED|DEFAULT_MODEL_UNRESOLVED|PROVIDER_KEY_MISSING|PROVIDER_AUTH|PROVIDER_FORBIDDEN|UNPRICED_MODEL|MODE_NOT_READ|RESEARCH_DISABLED|AGENT_DISABLED|AGENT_RESEARCH_DISABLED|AGENT_STORE_UNAVAILABLE|REGISTRY_NOT_READ_ONLY)$/.test(c)) return 'configuration'
  if (/^(IDENTITY_REQUIRED|PII_RESIDUAL|MODEL_REFUSAL)$/.test(c)) return 'permission'
  if (/^PROMPT_|^MAX_MODEL_CALLS$|^ANSWER_TRUNCATED/.test(c)) return 'limit'
  if (c.startsWith('PROVIDER_') || c === 'MODEL_REJECTED_BY_API') return 'provider'
  return c ? 'runtime' : null
}
