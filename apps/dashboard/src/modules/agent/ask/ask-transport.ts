/**
 * ASK TRANSPORT — the client of the read-only research agent (8.5.9 server,
 * apps/api/src/lib/agent/research/research-routes.js):
 *
 *   GET  /api/cockpit/agent/live/ask           status: resolved models, caps, spend today / cycle, tools
 *   POST /api/cockpit/agent/live/ask           { question, context?: { campaign_id?, property_ids?[] }, wait_ms? } → 202 { run_id }
 *   GET  /api/cockpit/agent/live/ask/:run_id   the run: state, answer, latency, cost per call, audit trail
 *
 * Server order on every request: route gate (404, empty body) → Worker
 * secret → verified named user on the allowlist (403 otherwise) → rate
 * limit. The client only reads and asks; there is no write, send or offer
 * call here, and a body that says fixture:true is refused.
 *
 * Mention typeahead reads the EXISTING read endpoints only (GET): Entity
 * Graph search (properties / master owners / markets), the campaign list,
 * an owner dossier (its properties) and the Priority inbox (HOT LEADS).
 */
import { callBackend } from '../../../lib/api/backendClient'
import { classifyFailure, type AskAuditRow, type AskCall, type AskFailure, type AskRun, type AskRunState, type AskStatus, type AskTool } from './ask-model'

const BASE = '/api/cockpit/agent/live/ask'
export const ASK_ENDPOINTS = { status: BASE, ask: BASE, run: (id: string) => `${BASE}/${encodeURIComponent(id)}` } as const

export type AskResult<T> = { ok: true; data: T } | { ok: false; failure: AskFailure }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const num = (v: unknown, d = 0) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : d }
const numOrNull = (v: unknown) => { const n = typeof v === 'string' && v !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null }
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null)

function failed(res: { status: number; error?: string; message?: string; upstream?: unknown }): { ok: false; failure: AskFailure } {
  const up = obj(res.upstream)
  return { ok: false, failure: classifyFailure(res.status, str(up.error) ?? res.error ?? null, str(up.message)) }
}
const fixtureRefused = (): { ok: false; failure: AskFailure } => ({ ok: false, failure: { kind: 'unavailable', status: 200, code: 'FIXTURE_ON_LIVE_CHANNEL', message: 'A fixture arrived on the live channel and was refused.' } })

const modelRef = (v: unknown) => { const o = obj(v); const id = str(o.id); return id ? { id, display_name: str(o.display_name), from: str(o.from) } : null }

export function normalizeStatus(body: unknown): AskStatus {
  const b = obj(body)
  const m = obj(b.models); const caps = obj(b.caps); const spend = obj(b.spend); const lim = obj(b.limits)
  return {
    enabled: b.enabled === true,
    mode_ok: b.mode_ok !== false,
    models: { ok: m.ok === true, code: str(m.code), default: modelRef(m.default), escalation: modelRef(m.escalation) },
    caps: { day_usd: num(caps.day_usd), user_day_usd: num(caps.user_day_usd), cycle_usd: num(caps.cycle_usd), run_usd: num(caps.run_usd) },
    spend: { day_usd: num(spend.day_usd), cycle_usd: num(spend.cycle_usd), day_remaining_usd: num(spend.day_remaining_usd), cycle_remaining_usd: num(spend.cycle_remaining_usd) },
    runs_today: num(b.runs_today),
    daily_run_cap: numOrNull(b.daily_run_cap),
    limits: { question_max_chars: num(lim.question_max_chars, 2000), max_model_calls: numOrNull(lim.max_model_calls), max_tool_calls: numOrNull(lim.max_tool_calls) },
    tools: arr<Record<string, unknown>>(b.tools).map((t) => ({ name: String(t.name ?? ''), label: String(t.label ?? t.name ?? ''), tier: str(t.tier), side_effect: str(t.side_effect), rows_to_model: numOrNull(t.rows_to_model) })).filter((t: AskTool) => t.name),
  }
}

const STATES: AskRunState[] = ['running', 'completed', 'failed', 'refused', 'cancelled']
export function normalizeRun(body: unknown): AskRun | null {
  const b = obj(body)
  const run_id = str(b.run_id)
  if (!run_id) return null
  const state = (STATES as string[]).includes(String(b.state)) ? (b.state as AskRunState) : 'running'
  const ans = obj(b.answer)
  const c = obj(b.counters); const m = obj(b.models)
  return {
    run_id,
    state,
    outcome: str(b.outcome),
    created_at: str(b.created_at),
    ended_at: str(b.ended_at),
    latency_ms: numOrNull(b.latency_ms),
    cost_usd: num(b.cost_usd),
    models: { default: str(m.default), escalation: str(m.escalation) },
    counters: { model_calls: num(c.model_calls), escalated_calls: num(c.escalated_calls), escalated_usd: num(c.escalated_usd), tool_calls: num(c.tool_calls) },
    answer: typeof ans.answer_md === 'string' ? { answer_md: ans.answer_md, property_ids: arr(ans.property_ids).map(String), persisted: ans.persisted !== false } : null,
    calls: arr<Record<string, unknown>>(b.calls).map((x): AskCall => ({ model: String(x.model ?? ''), cost_usd: numOrNull(x.cost_usd), latency_ms: numOrNull(x.latency_ms), stop: str(x.stop), input_tokens: numOrNull(x.input_tokens), output_tokens: numOrNull(x.output_tokens), route: str(x.route) })),
    audit: arr<Record<string, unknown>>(b.audit).map((x): AskAuditRow => ({ at: str(x.at), kind: String(x.kind ?? ''), name: str(x.name), params_sha256: str(x.params_sha256), rows_returned: numOrNull(x.rows_returned), cost_usd: numOrNull(x.cost_usd), latency_ms: numOrNull(x.latency_ms), outcome: str(x.outcome) })),
  }
}

export async function fetchAskStatus(signal?: AbortSignal): Promise<AskResult<AskStatus>> {
  const res = await callBackend<unknown>(ASK_ENDPOINTS.status, { signal, timeoutMs: 12_000 })
  if (!res.ok) return failed(res)
  if (obj(res.data).fixture === true) return fixtureRefused()
  return { ok: true, data: normalizeStatus(res.data) }
}

/** Start a run. wait_ms 0: the server answers 202 { run_id } as soon as the run is durably recorded. */
export async function postAsk(question: string, context: { campaign_id?: string; property_ids?: string[] }): Promise<AskResult<{ run_id: string }>> {
  const res = await callBackend<unknown>(ASK_ENDPOINTS.ask, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, context, wait_ms: 0 }), timeoutMs: 30_000 })
  if (!res.ok) return failed(res)
  const b = obj(res.data)
  if (b.fixture === true) return fixtureRefused()
  const run_id = str(b.run_id)
  if (!run_id) return { ok: false, failure: { kind: 'unavailable', status: res.status, code: 'NO_RUN_ID', message: 'The server did not return a run.' } }
  return { ok: true, data: { run_id } }
}

export async function fetchAskRun(runId: string, signal?: AbortSignal): Promise<AskResult<AskRun>> {
  const res = await callBackend<unknown>(ASK_ENDPOINTS.run(runId), { signal, timeoutMs: 15_000 })
  if (!res.ok) return failed(res)
  if (obj(res.data).fixture === true) return fixtureRefused()
  const run = normalizeRun(res.data)
  if (!run) return { ok: false, failure: { kind: 'unavailable', status: res.status, code: 'RUN_SHAPE', message: 'Unexpected run response.' } }
  return { ok: true, data: run }
}

/* ── mention typeahead: existing READ endpoints only ───────────────────── */

export interface MentionHit { kind: 'property' | 'campaign' | 'owner' | 'market' | 'hot_leads'; id: string; label: string; detail: string | null }

async function egSearch(tab: string, q: string, kind: MentionHit['kind'], size: number, signal?: AbortSignal): Promise<MentionHit[]> {
  const qs = new URLSearchParams({ q, tab, page_size: String(size) })
  const res = await callBackend<unknown>(`/api/cockpit/entity-graph/search?${qs.toString()}`, { signal, timeoutMs: 8000 })
  if (!res.ok) return []
  return arr<Record<string, unknown>>(obj(res.data).results).slice(0, size).map((r) => {
    const d = obj(r.details)
    return { kind, id: String(r.entityId ?? ''), label: String(r.title ?? r.entityId ?? ''), detail: str(r.subtitle) ?? str(d.marketLabel) }
  }).filter((h) => h.id)
}

let campaignCache: { at: number; rows: MentionHit[] } | null = null
async function campaigns(q: string, signal?: AbortSignal): Promise<MentionHit[]> {
  if (!campaignCache || Date.now() - campaignCache.at > 5 * 60_000) {
    const res = await callBackend<unknown>('/api/cockpit/campaigns', { signal, timeoutMs: 10_000 })
    if (!res.ok) return []
    campaignCache = { at: Date.now(), rows: arr<Record<string, unknown>>(obj(res.data).campaigns).map((c) => ({ kind: 'campaign' as const, id: String(c.id ?? ''), label: String(c.campaign_name ?? c.name ?? c.id ?? ''), detail: str(c.status) })).filter((c) => c.id) }
  }
  const t = q.toLowerCase()
  return campaignCache.rows.filter((c) => !t || c.label.toLowerCase().includes(t)).slice(0, 6)
}

export async function searchMentions(kind: MentionHit['kind'] | null, term: string, signal?: AbortSignal): Promise<MentionHit[]> {
  const q = term.trim()
  const jobs: Array<Promise<MentionHit[]>> = []
  const wantServer = q.length >= 2
  if ((kind === null || kind === 'property') && wantServer) jobs.push(egSearch('properties', q, 'property', kind ? 8 : 4, signal))
  if (kind === null || kind === 'campaign') jobs.push(kind === 'campaign' || wantServer ? campaigns(q, signal) : Promise.resolve([]))
  if ((kind === null || kind === 'owner') && wantServer) jobs.push(egSearch('master_owners', q, 'owner', kind ? 8 : 3, signal))
  if ((kind === null || kind === 'market') && (wantServer || kind === 'market')) jobs.push(egSearch('markets', q || 'a', 'market', kind ? 8 : 3, signal))
  const settled = await Promise.allSettled(jobs)
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
}

/** An owner's properties (≤ 10), from its existing dossier read. */
export async function resolveOwnerProperties(ownerId: string, signal?: AbortSignal): Promise<string[]> {
  const res = await callBackend<unknown>(`/api/cockpit/entity-graph/owner/${encodeURIComponent(ownerId)}`, { signal, timeoutMs: 12_000 })
  if (!res.ok) return []
  const b = obj(res.data)
  const d = obj(b.dossier ?? b.data ?? b)
  return [...new Set(arr<Record<string, unknown>>(d.properties).map((p) => String(p.property_id ?? p.propertyId ?? p.id ?? '')).filter((id) => /^[A-Za-z0-9_.:-]{1,64}$/.test(id)))].slice(0, 10)
}

/** The Priority (HOT LEADS) inbox properties (≤ 10). A GET never marks anything read. */
export async function resolveHotLeadProperties(signal?: AbortSignal): Promise<string[]> {
  const res = await callBackend<unknown>('/api/cockpit/inbox/threads?bucket=hot_leads&limit=10', { signal, timeoutMs: 15_000 })
  if (!res.ok) return []
  const d = obj(obj(res.data).data)
  const threads = arr<Record<string, unknown>>(d.threads ?? obj(res.data).threads)
  return [...new Set(threads.map((t) => String(t.property_id ?? t.propertyId ?? '')).filter((id) => /^[A-Za-z0-9_.:-]{1,64}$/.test(id)))].slice(0, 10)
}
