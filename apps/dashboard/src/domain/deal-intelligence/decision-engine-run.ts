/**
 * ANALYZE — run the canonical decision engine for ONE property from the Deal
 * Intelligence decision room (POST /api/cockpit/deal-intelligence/decision/run).
 *
 * Property-scoped: a conversation is no longer required (a property opened
 * from the Map, Pipeline or search can be analyzed). The stream ends with one
 * terminal event; a run the engine REPORTED as failed ends { ok: false, error }
 * and is shown as a failure, never as "done".
 */
import { useCallback, useRef, useState } from 'react'
import { getBackendAuthHeaders, getBackendBaseUrl } from '../../lib/api/backendClient'

export type EngineRunEvent = { ok?: boolean; error?: string; stage?: string; status?: string; decision_status?: string | null }
export type EngineRunOutcome = { ok: true; decisionStatus: string | null } | { ok: false; error: string }

export const ENGINE_RUN_PATH = '/api/cockpit/deal-intelligence/decision/run'

/** Build the run URL (exported for the wiring test). */
export function engineRunUrl(base: string, s: { propertyId: string; threadKey?: string | null }): string {
  const q = new URLSearchParams({ property_id: s.propertyId })
  if (s.threadKey) q.set('thread_key', s.threadKey)
  return `${base}${ENGINE_RUN_PATH}?${q.toString()}`
}

/** Split an NDJSON buffer into events + the unterminated remainder. */
export function parseEngineChunk(buffer: string): { events: EngineRunEvent[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const events: EngineRunEvent[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line) as EngineRunEvent) } catch { /* a torn line is not an event */ }
  }
  return { events, rest }
}

/**
 * The run's outcome from every event it streamed: any { ok: false } is the
 * failure; success needs the terminal decision_ready. A stream that simply
 * stops is a failure too — never an implied success.
 */
export function engineOutcome(events: readonly EngineRunEvent[]): EngineRunOutcome {
  const failed = events.find((e) => e.ok === false)
  if (failed) return { ok: false, error: failed.error || 'engine_failed' }
  const done = [...events].reverse().find((e) => e.stage === 'decision_ready' && e.status === 'done')
  if (!done) return { ok: false, error: 'run_ended_without_a_decision' }
  return { ok: true, decisionStatus: done.decision_status ?? null }
}

export async function runPropertyEngine(
  s: { propertyId: string; threadKey?: string | null },
  onEvent?: (e: EngineRunEvent) => void,
  deps: { fetch?: typeof fetch; base?: string; headers?: Record<string, string> } = {},
): Promise<EngineRunOutcome> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.base ?? getBackendBaseUrl()
  const auth = deps.headers ?? await getBackendAuthHeaders()
  const res = await doFetch(engineRunUrl(base, s), {
    method: 'POST',
    headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ property_id: s.propertyId, thread_key: s.threadKey ?? undefined }),
  })
  if (!res.ok || !res.body) return { ok: false, error: `run_engine_http_${res.status}` }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const all: EngineRunEvent[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const { events, rest } = parseEngineChunk(buffer)
    buffer = rest
    for (const e of events) { all.push(e); onEvent?.(e) }
  }
  if (buffer.trim()) { const { events } = parseEngineChunk(`${buffer}\n`); for (const e of events) { all.push(e); onEvent?.(e) } }
  return engineOutcome(all)
}

export type EngineStep = { stage: string; label: string; status: 'pending' | 'running' | 'done' | 'error' }

const STEPS: Array<[string, string]> = [
  ['resolving_property', 'Resolve the property'],
  ['loading_comps', 'Load comparable sales'],
  ['qualifying_comps', 'Qualify comps'],
  ['measuring_buyer_demand', 'Measure buyer demand'],
  ['calculating_confidence', 'Value, offer and confidence'],
  ['persisting_decision', 'Record the decision'],
]

/** The decision room's Analyze action: one run at a time, progress, an honest error. */
export function usePropertyEngineRun(onFinished: (ok: boolean) => void) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [steps, setSteps] = useState<EngineStep[]>([])
  const busy = useRef(false)
  const run = useCallback(async (s: { propertyId: string | null | undefined; threadKey?: string | null }) => {
    if (busy.current) return
    if (!s.propertyId) { setError('property_id_required'); return }
    busy.current = true
    setRunning(true)
    setError(null)
    setSteps(STEPS.map(([stage, label]) => ({ stage, label, status: 'pending' })))
    let outcome: EngineRunOutcome
    try {
      outcome = await runPropertyEngine({ propertyId: s.propertyId, threadKey: s.threadKey ?? null }, (e) => {
        if (!e.stage) return
        setSteps((prev) => {
          const i = prev.findIndex((x) => x.stage === e.stage)
          if (i < 0) return prev
          return prev.map((x, j) => (j < i ? { ...x, status: 'done' } : j === i ? { ...x, status: e.status === 'done' ? 'done' : 'running' } : x))
        })
      })
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : 'run_engine_failed' }
    }
    if (outcome.ok) setSteps((prev) => prev.map((x) => ({ ...x, status: 'done' })))
    else {
      setError(outcome.error)
      setSteps((prev) => prev.map((x) => (x.status === 'running' ? { ...x, status: 'error' } : x)))
    }
    busy.current = false
    setRunning(false)
    onFinished(outcome.ok)
  }, [onFinished])
  return { run, running, error, steps }
}

const ERROR_TEXT: Record<string, string> = {
  property_not_found: 'The property record could not be found, so it cannot be priced.',
  property_id_required: 'This subject has no property id to analyze.',
  run_ended_without_a_decision: 'The run stopped before the engine recorded a decision.',
  unauthorized: 'Your session is not authorized to run the engine.',
}

/** Plain words for an engine-run error code. */
export function engineErrorText(code: string | null): string | null {
  if (!code) return null
  if (ERROR_TEXT[code]) return ERROR_TEXT[code]
  const http = /^run_engine_http_(\d+)$/.exec(code)
  if (http) return http[1] === '401' || http[1] === '403' ? ERROR_TEXT.unauthorized : `The engine service answered ${http[1]}.`
  return `The engine reported: ${code.replace(/_/g, ' ')}.`
}
