/**
 * RUN REDUCER — the server's live event sequence (GET /ask/:run_id/events,
 * apps/api/src/lib/agent/research/run-events.js + ask-service.js) folded into
 * the execution canvas state. Pure: no timers, no clocks, no estimates.
 *
 *   run_start · model_call_start/end · tool_start/end · web_search ·
 *   text_delta · result · completed | failed | cancelled · snapshot · error
 *
 * Rules:
 *  · events are de-duplicated by seq (a reconnect replays from ?after=);
 *  · a step is "running" only between its own start and end events — nothing
 *    is ever shown as progressing without a server event saying so;
 *  · streamed text belongs to the model call that produced it; a new call
 *    starts a new draft (the final answer arrives on the terminal event);
 *  · the terminal event is authoritative for state, cost and latency.
 */
import { shortModelName, type AskEvent, type AskTool } from '../../agent/ask/ask-model'

export type RunPhase = 'idle' | 'starting' | 'thinking' | 'reading' | 'searching' | 'writing' | 'finishing' | 'completed' | 'failed' | 'cancelled'
export type StepKind = 'model' | 'tool' | 'web' | 'result' | 'refused'
export type StepState = 'running' | 'ok' | 'failed' | 'refused'

export interface RunStep {
  key: string
  kind: StepKind
  state: StepState
  title: string
  /** tool name / model id */
  name: string | null
  call: number | null
  rows: number | null
  latency_ms: number | null
  cost_usd: number | null
  tokens: { input: number; output: number } | null
  outcome: string | null
  detail: string | null
  at: string | null
  /** provider-executed public-web tool (not LeadCommand data) */
  publicWeb: boolean
}

export interface RunState {
  phase: RunPhase
  steps: RunStep[]
  /** masked answer text streamed by the current model call */
  draft: string
  /** final answer text (terminal event) */
  answer: string | null
  modelCalls: number
  toolCalls: number
  webSearches: number
  webFetches: number
  costUsd: number
  latencyMs: number | null
  outcome: string | null
  refusalClass: string | null
  terminal: AskEvent | null
  lastSeq: number
  /** a terminal reported by durable status (this process no longer held the run) */
  fromDurable: boolean
  error: string | null
  models: string[]
}

export const EMPTY_RUN: RunState = { phase: 'idle', steps: [], draft: '', answer: null, modelCalls: 0, toolCalls: 0, webSearches: 0, webFetches: 0, costUsd: 0, latencyMs: null, outcome: null, refusalClass: null, terminal: null, lastSeq: 0, fromDurable: false, error: null, models: [] }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const s = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export const isTerminalPhase = (p: RunPhase) => p === 'completed' || p === 'failed' || p === 'cancelled'

function toolTitle(tool: string, tools: AskTool[]): string {
  if (tool === 'web_search') return 'Search the public web'
  if (tool === 'web_fetch') return 'Read a public web page'
  if (tool.startsWith('cap__')) return `Capability ${tool.slice(5).replace(/__/g, '.')}`
  return tools.find((t) => t.name === tool)?.label ?? tool.replace(/[._]/g, ' ')
}

/** Fold ONE event into the state (exported for incremental use and tests). */
export function applyEvent(prev: RunState, e: AskEvent, tools: AskTool[] = []): RunState {
  const seq = typeof e.seq === 'number' ? e.seq : 0
  // de-duplicate replays; the durable terminal (seq 1_000_000) is accepted once
  if (seq && seq <= prev.lastSeq && seq < 1_000_000) return prev
  if (prev.terminal && TERMINAL.has(e.type)) return prev
  const st: RunState = { ...prev, steps: prev.steps, lastSeq: seq && seq < 1_000_000 ? Math.max(prev.lastSeq, seq) : prev.lastSeq }
  const at = s(e.at)
  const call = num(e.call)
  const replaceStep = (match: (x: RunStep) => boolean, patch: Partial<RunStep>): boolean => {
    for (let i = st.steps.length - 1; i >= 0; i -= 1) {
      if (match(st.steps[i])) { st.steps = st.steps.map((x, j) => (j === i ? { ...x, ...patch } : x)); return true }
    }
    return false
  }
  switch (e.type) {
    case 'run_start':
      st.phase = 'starting'
      break
    case 'model_call_start': {
      const model = s(e.model)
      st.phase = 'thinking'
      st.draft = ''
      if (model && !st.models.includes(model)) st.models = [...st.models, model]
      st.steps = [...st.steps, { key: `m:${call ?? seq}`, kind: 'model', state: 'running', title: e.route === 'escalation' ? 'Escalated reasoning' : 'Reasoning', name: model, call, rows: null, latency_ms: null, cost_usd: null, tokens: null, outcome: null, detail: shortModelName(model) ?? null, at, publicWeb: false }]
      break
    }
    case 'model_call_end': {
      const ok = e.ok !== false
      if (ok) st.modelCalls += 1
      const cost = num(e.cost_usd)
      if (cost) st.costUsd = +(st.costUsd + cost).toFixed(6)
      const tokens = num(e.input_tokens) != null ? { input: num(e.input_tokens) ?? 0, output: num(e.output_tokens) ?? 0 } : null
      const stop = s(e.stop)
      const patch: Partial<RunStep> = { state: ok ? 'ok' : 'failed', latency_ms: num(e.latency_ms), cost_usd: cost, tokens, outcome: ok ? stop : s(e.outcome), title: !ok ? 'Model call failed' : stop === 'tool_use' ? 'Planned the next reads' : stop === 'end_turn' ? 'Wrote the answer' : 'Reasoning' }
      if (!replaceStep((x) => x.kind === 'model' && x.state === 'running' && (call == null || x.call === call), patch)) {
        st.steps = [...st.steps, { key: `m:${call ?? seq}`, kind: 'model', state: 'ok', title: 'Reasoning', name: s(e.model), call, rows: null, latency_ms: null, cost_usd: null, tokens: null, outcome: null, detail: null, at, publicWeb: false, ...patch }]
      }
      if (!ok) st.phase = 'thinking'
      break
    }
    case 'tool_start': {
      const tool = String(e.tool ?? '')
      const web = WEB_TOOLS.has(tool)
      st.phase = web ? 'searching' : 'reading'
      st.steps = [...st.steps, { key: `t:${seq}`, kind: web ? 'web' : 'tool', state: 'running', title: toolTitle(tool, tools), name: tool, call, rows: null, latency_ms: null, cost_usd: null, tokens: null, outcome: null, detail: web ? 'Provider-executed · public web (not LeadCommand data)' : null, at, publicWeb: web }]
      break
    }
    case 'tool_end': {
      const tool = String(e.tool ?? '')
      const web = WEB_TOOLS.has(tool)
      const outcome = s(e.outcome) ?? 'ok'
      const refused = e.refused === true
      const ok = outcome === 'ok'
      if (ok && !web) st.toolCalls += 1
      const patch: Partial<RunStep> = { state: refused ? 'refused' : ok ? 'ok' : 'failed', rows: num(e.rows), latency_ms: num(e.latency_ms), outcome, detail: refused ? `Refused by the server (${outcome})` : ok ? (web ? 'Provider-executed · public web (not LeadCommand data)' : null) : `Source unavailable (${outcome}) — not evidence of absence` }
      if (!replaceStep((x) => x.state === 'running' && x.name === tool, patch)) {
        st.steps = [...st.steps, { key: `t:${seq}`, kind: refused ? 'refused' : web ? 'web' : 'tool', state: 'ok', title: toolTitle(tool, tools), name: tool, call, rows: null, latency_ms: null, cost_usd: null, tokens: null, outcome: null, detail: null, at, publicWeb: web, ...patch }]
      }
      break
    }
    case 'web_search': {
      const searches = num(e.searches) ?? 0
      const fetches = num(e.fetches) ?? 0
      st.webSearches += searches
      st.webFetches += fetches
      st.phase = 'searching'
      st.steps = [...st.steps, { key: `w:${seq}`, kind: 'web', state: 'ok', title: `Searched the public web · ${searches} search${searches === 1 ? '' : 'es'}${fetches ? ` · ${fetches} page${fetches === 1 ? '' : 's'}` : ''}`, name: 'web_search', call, rows: num(e.results), latency_ms: null, cost_usd: null, tokens: null, outcome: 'ok', detail: num(e.citations) != null ? `${num(e.citations)} citation${num(e.citations) === 1 ? '' : 's'} kept after the server's domain checks` : null, at, publicWeb: true }]
      break
    }
    case 'text_delta':
      st.phase = 'writing'
      st.draft = prev.draft + String(e.text ?? '')
      break
    case 'result':
      st.phase = 'finishing'
      st.steps = [...st.steps, { key: `r:${seq}`, kind: 'result', state: 'ok', title: `Typed result · ${String(e.kind ?? 'answer').replace(/_/g, ' ')}`, name: s(e.kind), call: null, rows: null, latency_ms: null, cost_usd: null, tokens: null, outcome: null, detail: null, at, publicWeb: false }]
      break
    case 'completed':
    case 'failed':
    case 'cancelled': {
      st.terminal = e
      st.phase = e.type
      st.fromDurable = e.from === 'durable_status'
      st.outcome = s(e.outcome)
      st.refusalClass = s(e.refusal_class)
      st.answer = s(e.answer_md) ?? (e.type === 'completed' ? prev.draft || null : null)
      if (num(e.cost_usd) != null) st.costUsd = num(e.cost_usd) as number
      st.latencyMs = num(e.latency_ms)
      if (num(e.model_calls) != null) st.modelCalls = num(e.model_calls) as number
      if (num(e.tool_calls) != null) st.toolCalls = num(e.tool_calls) as number
      if (num(e.web_searches) != null) st.webSearches = num(e.web_searches) as number
      // anything still open when the run ended did not finish
      st.steps = st.steps.map((x) => (x.state === 'running' ? { ...x, state: 'failed', outcome: e.type === 'cancelled' ? 'CANCELLED' : 'RUN_ENDED', detail: e.type === 'cancelled' ? 'Stopped by the cancel' : 'The run ended before this step reported' } : x))
      break
    }
    case 'snapshot':
      if (prev.phase === 'idle') st.phase = 'starting'
      break
    case 'error':
      st.error = s(e.code) ?? 'STREAM_ERROR'
      break
    default:
      break
  }
  return st
}

/** Reduce a whole sequence (in arrival order). */
export function reduceRunEvents(events: readonly AskEvent[], tools: AskTool[] = []): RunState {
  let st = EMPTY_RUN
  for (const e of events) st = applyEvent(st, e, tools)
  return st
}

export const PHASE_LABEL: Record<RunPhase, string> = {
  idle: 'Queued',
  starting: 'Started',
  thinking: 'Reasoning',
  reading: 'Reading LeadCommand records',
  searching: 'Searching the public web',
  writing: 'Writing',
  finishing: 'Preparing the result',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** The single status line for a run: a pure function of the reduced events. */
export function statusLine(st: RunState): string {
  if (st.phase === 'failed') return `Failed${st.refusalClass ? ` · ${st.refusalClass}` : st.outcome ? ` · ${st.outcome}` : ''}`
  const running = [...st.steps].reverse().find((x) => x.state === 'running')
  if (running && !isTerminalPhase(st.phase)) return running.kind === 'model' ? `Reasoning${running.detail ? ` · ${running.detail}` : ''}` : running.title
  return PHASE_LABEL[st.phase]
}
