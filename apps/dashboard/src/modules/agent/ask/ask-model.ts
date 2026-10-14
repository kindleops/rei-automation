/**
 * ASK MODEL — the pure half of the Cursor-grade research composer.
 *
 * Everything the composer and run view decide is here, free of React and the
 * network, so it is unit-tested directly: slash commands, @-mention parsing,
 * the question + context sent to POST /api/cockpit/agent/live/ask, the step
 * timeline reduced from the run's audit rows, the budget meter, model labels,
 * citations and follow-ups, failure classification and the key map.
 *
 * Read-only by construction: the server registry holds read tools only. The
 * UI has no send / offer / write affordance; nothing here builds one.
 */

/* ── server shapes (apps/api/src/lib/agent/research/research-routes.js) ── */

export interface AskModelRef { id: string; display_name: string | null; from?: string | null }
export interface AskTool { name: string; label: string; tier?: string | null; side_effect?: string | null; rows_to_model?: number | null }

export interface AskStatus {
  enabled: boolean
  mode_ok: boolean
  models: { ok: boolean; code: string | null; default: AskModelRef | null; escalation: AskModelRef | null }
  caps: { day_usd: number; user_day_usd: number; cycle_usd: number; run_usd: number }
  spend: { day_usd: number; cycle_usd: number; day_remaining_usd: number; cycle_remaining_usd: number }
  runs_today: number
  daily_run_cap: number | null
  limits: { question_max_chars: number; max_model_calls: number | null; max_tool_calls: number | null }
  tools: AskTool[]
}

export interface AskAuditRow { at: string | null; kind: string; name: string | null; params_sha256?: string | null; rows_returned: number | null; cost_usd: number | null; latency_ms: number | null; outcome: string | null }
export interface AskCall { model: string; cost_usd: number | null; latency_ms: number | null; stop: string | null; input_tokens: number | null; output_tokens: number | null; route: string | null }

export type AskRunState = 'running' | 'completed' | 'failed' | 'refused' | 'cancelled'
/** The server's persisted WHY for a refused / failed run (research_run.doc.refusal): codes only. */
export interface AskRefusal { code: string; layer: string | null; reason: string | null; phase: string | null; transport: string | null; billed: string | null; route: string | null; binding_cap: string | null; after_ms: number | null }
/* ── typed results (server: research/result-schema.js, lc.ask.result v1) ── */
export interface WebCitation { url: string; title: string | null; retrieved_at: string | null; page_age?: string | null; source?: string | null }
export interface ResultFact { label: string; value: string; evidence: 'internal' | 'public_web'; source: string | null }
export type ResultBlock =
  | { kind: 'answer'; markdown: string }
  | { kind: 'web_citations'; citations: WebCitation[] }
  | { kind: 'property_research'; title: string; summary: string | null; property_id: string | null; address_label: string | null; facts: ResultFact[]; listing_status: { status: string; source_url: string; as_of: string | null } | null; gaps: string[] }
  | { kind: 'conversation_summary'; title: string; summary: string | null; points: string[] }
  | { kind: 'campaign_audience_preview'; title: string; summary: string | null; filters: string[]; estimated_count: number | null }
  | { kind: 'approval_preview'; title: string; summary: string | null; action: string; target: string | null; effect: string | null; executed: false }
  | { kind: string; [k: string]: unknown }
export interface AskResultEnvelope { schema: 'lc.ask.result'; version: 1; blocks: ResultBlock[]; evidence: { internal: { tools: string[]; property_ids: string[] }; public_web: WebCitation[] } }
export const RESULT_KINDS_RENDERED = ['answer', 'web_citations', 'property_research'] as const

export function normalizeResult(v: unknown): AskResultEnvelope | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  if (!o || o.schema !== 'lc.ask.result' || o.version !== 1 || !Array.isArray(o.blocks)) return null
  const ev = (o.evidence && typeof o.evidence === 'object' ? o.evidence : {}) as Record<string, unknown>
  const internal = (ev.internal && typeof ev.internal === 'object' ? ev.internal : {}) as Record<string, unknown>
  const blocks = (o.blocks as unknown[]).filter((b): b is ResultBlock => Boolean(b && typeof b === 'object' && typeof (b as { kind?: unknown }).kind === 'string'))
  const cites = (x: unknown): WebCitation[] => (Array.isArray(x) ? x : []).filter((c) => c && typeof c === 'object' && typeof (c as WebCitation).url === 'string' && /^https?:\/\//i.test((c as WebCitation).url)).map((c) => ({ url: (c as WebCitation).url, title: typeof (c as WebCitation).title === 'string' ? (c as WebCitation).title : null, retrieved_at: typeof (c as WebCitation).retrieved_at === 'string' ? (c as WebCitation).retrieved_at : null, page_age: typeof (c as WebCitation).page_age === 'string' ? (c as WebCitation).page_age : null, source: typeof (c as WebCitation).source === 'string' ? (c as WebCitation).source : null }))
  return {
    schema: 'lc.ask.result',
    version: 1,
    blocks: blocks.map((b) => (b.kind === 'web_citations' ? { kind: 'web_citations', citations: cites((b as { citations?: unknown }).citations) } : b)),
    evidence: { internal: { tools: Array.isArray(internal.tools) ? internal.tools.map(String) : [], property_ids: Array.isArray(internal.property_ids) ? internal.property_ids.map(String) : [] }, public_web: cites(ev.public_web) },
  }
}

/* ── live run events (server: research/run-events.js) ─────────────────────
 * Every event is a server fact at the moment it happened. The status line is a
 * pure function of them — no timers, no percentages, no guessed phases. */
export type AskEventType = 'run_start' | 'model_call_start' | 'model_call_end' | 'tool_start' | 'tool_end' | 'web_search' | 'text_delta' | 'result' | 'completed' | 'failed' | 'cancelled' | 'snapshot' | 'error'
export interface AskEvent { seq: number; type: AskEventType; at?: string; [k: string]: unknown }
export const TERMINAL_EVENT_TYPES: ReadonlyArray<AskEventType> = ['completed', 'failed', 'cancelled']

export interface LiveView {
  /** the operator-facing status, derived from the latest event */
  status: string
  tone: 'active' | 'done' | 'bad'
  /** masked answer text streamed by the CURRENT model call */
  draft: string
  lastSeq: number
  modelCalls: number
  reads: number
  webSearches: number
  terminal: AskEvent | null
}

const REFUSAL_CLASS_LABEL: Record<string, string> = { timeout: 'timeout', provider: 'provider error', configuration: 'configuration', permission: 'permission', budget: 'budget', limit: 'limit reached', cancelled: 'cancelled', runtime: 'runtime error' }

export function liveViewOf(events: AskEvent[], tools: AskTool[] = []): LiveView {
  const label = (name: string) => tools.find((t) => t.name === name)?.label ?? null
  let status = 'Sent'
  let tone: LiveView['tone'] = 'active'
  let draft = ''
  let call = 0
  let modelCalls = 0
  let reads = 0
  let webSearches = 0
  let terminal: AskEvent | null = null
  let lastSeq = 0
  for (const e of events) {
    if (typeof e.seq === 'number' && e.seq > lastSeq && e.seq < 1_000_000) lastSeq = e.seq
    switch (e.type) {
      case 'run_start': status = 'Started'; break
      case 'model_call_start': call = Number(e.call) || call + 1; draft = ''; status = `Model call · ${shortModelName(String(e.model ?? '')) ?? 'model'}`; break
      case 'model_call_end': modelCalls += e.ok === false ? 0 : 1; if (e.ok === false) status = `Model call failed · ${String(e.outcome ?? '')}`; break
      case 'tool_start':
        status = e.tool === 'web_search' ? 'Searching web' : e.tool === 'web_fetch' ? 'Reading a web page' : `Reading LeadCommand records${label(String(e.tool)) ? ` · ${label(String(e.tool))}` : ''}`
        break
      case 'tool_end': if (e.tool !== 'web_search' && e.tool !== 'web_fetch' && e.outcome === 'ok') reads += 1; break
      case 'web_search': webSearches += Number(e.searches) || 0; status = `Searched web · ${Number(e.searches) || 0} search${Number(e.searches) === 1 ? '' : 'es'}`; break
      case 'text_delta': if (Number(e.call) === call || !call) { draft += String(e.text ?? ''); status = 'Writing' } break
      case 'result': status = 'Preparing result'; break
      case 'completed': status = 'Completed'; tone = 'done'; terminal = e; break
      case 'cancelled': status = 'Cancelled'; tone = 'bad'; terminal = e; break
      case 'failed': status = `Failed: ${REFUSAL_CLASS_LABEL[String(e.refusal_class ?? '')] ?? String(e.refusal_class ?? e.outcome ?? 'error')}`; tone = 'bad'; terminal = e; break
      default: break
    }
  }
  return { status, tone, draft, lastSeq, modelCalls, reads, webSearches, terminal }
}

/** Step rows from live events (while running; the audit-built timeline replaces them at the end). */
export function liveStepsOf(events: AskEvent[], tools: AskTool[] = []): TimelineStep[] {
  const label = (name: string) => tools.find((t) => t.name === name)?.label ?? name.replace(/[._]/g, ' ')
  const out: TimelineStep[] = []
  for (const e of events) {
    const key = `ev:${e.seq}`
    if (e.type === 'model_call_end') {
      const tokens = e.input_tokens != null ? `${Number(e.input_tokens).toLocaleString('en-US')} in · ${Number(e.output_tokens ?? 0).toLocaleString('en-US')} out` : null
      out.push({ key, kind: e.ok === false ? 'error' : 'model', title: e.ok === false ? 'Model call failed' : e.stop === 'tool_use' ? 'Planned next reads' : 'Wrote the answer', name: shortModelName(String(e.model ?? '')), rows: null, latency_ms: typeof e.latency_ms === 'number' ? e.latency_ms : null, cost_usd: typeof e.cost_usd === 'number' ? e.cost_usd : null, outcome: String(e.stop ?? e.outcome ?? ''), ok: e.ok !== false, at: e.at ?? null, detail: tokens })
    } else if (e.type === 'tool_end') {
      const tool = String(e.tool ?? '')
      const web = tool === 'web_search' || tool === 'web_fetch'
      const ok = e.outcome === 'ok'
      out.push({ key, kind: e.refused ? 'refused' : 'tool', title: web ? (tool === 'web_search' ? 'Searched the public web' : 'Read a public web page') : label(tool), name: web ? tool.replace('_', '.') : tool, rows: typeof e.rows === 'number' ? e.rows : null, latency_ms: typeof e.latency_ms === 'number' ? e.latency_ms : null, cost_usd: null, outcome: String(e.outcome ?? ''), ok, at: e.at ?? null, detail: ok ? (web ? 'Provider-executed · public web (not LeadCommand data)' : null) : `Source unavailable (${String(e.outcome)}) — not evidence of absence` })
    }
  }
  return out
}

export interface AskRun {
  run_id: string
  state: AskRunState
  outcome: string | null
  mode?: 'conversation' | 'research' | null
  refusal_class?: string | null
  result?: AskResultEnvelope | null
  created_at: string | null
  ended_at: string | null
  latency_ms: number | null
  cost_usd: number
  models: { default: string | null; escalation: string | null }
  counters: { model_calls: number; escalated_calls: number; escalated_usd: number; tool_calls: number; web_searches?: number }
  answer: { answer_md: string; property_ids: string[]; persisted?: boolean } | null
  calls: AskCall[]
  audit: AskAuditRow[]
  refusal?: AskRefusal | null
}

/* ── failures: a clean state per class, never "something went wrong" ──── */

export type AskFailureKind = 'not_allowlisted' | 'session' | 'disabled' | 'rate_limited' | 'refused' | 'invalid' | 'unavailable'
export interface AskFailure { kind: AskFailureKind; status: number; code: string; message: string }

export function classifyFailure(status: number, code: string | null | undefined, message?: string | null): AskFailure {
  const c = String(code || '').toUpperCase()
  const m = message ? String(message) : ''
  if (status === 403 || c === 'NOT_ALLOWLISTED' || c === 'OPERATOR_NOT_ALLOWED' || c === 'USER_NOT_ALLOWED') return { kind: 'not_allowlisted', status, code: c || 'FORBIDDEN', message: 'The research agent is not enabled for your account.' }
  if (status === 401 || c === 'SESSION_REQUIRED' || c === 'SESSION_INVALID' || c === 'OPERATOR_MISMATCH') return { kind: 'session', status, code: c || 'SESSION_REQUIRED', message: 'Sign in again — the agent needs a verified operator session.' }
  if (status === 404 || c === 'AGENT_DISABLED' || c === 'RESEARCH_DISABLED' || c === 'LIVE_ROUTE_NOT_MOUNTED') return { kind: 'disabled', status, code: c || 'NOT_MOUNTED', message: 'The research agent is switched off on this server.' }
  if (status === 429 || c === 'DAILY_RUN_CAP' || c.startsWith('RATE_')) return { kind: 'rate_limited', status, code: c || 'RATE_LIMITED', message: m || 'Too many agent requests — try again shortly.' }
  if (status === 423 || c === 'MODE_NOT_READ') return { kind: 'refused', status, code: c || 'REFUSED', message: m || 'The server refused this run.' }
  if (status === 422 || c === 'QUESTION_INVALID') return { kind: 'invalid', status, code: c || 'QUESTION_INVALID', message: m || 'The question is empty or too long.' }
  return { kind: 'unavailable', status, code: c || 'UNAVAILABLE', message: 'The agent did not respond. Try again.' }
}

/** A failure that blocks the whole surface (vs one run). */
export const isBlockingFailure = (f: AskFailure | null | undefined) => Boolean(f && (f.kind === 'not_allowlisted' || f.kind === 'session' || f.kind === 'disabled'))

export const FAILURE_TITLE: Record<AskFailureKind, string> = {
  not_allowlisted: 'Not enabled for your account',
  session: 'Session expired',
  disabled: 'Research agent is off',
  rate_limited: 'Slow down',
  refused: 'Refused by the server',
  invalid: 'Check the question',
  unavailable: 'Agent unavailable',
}

/* ── models: “Haiku 5.5” / “Sonnet 5.5”, from the status endpoint ──────── */

export function shortModelName(ref: { id?: string | null; display_name?: string | null } | string | null | undefined): string | null {
  const id = typeof ref === 'string' ? ref : ref?.id ?? null
  const display = typeof ref === 'string' ? null : ref?.display_name ?? null
  const raw = (display && display.trim()) || id || ''
  if (!raw) return null
  const named = raw.replace(/^claude[\s-]+/i, '').trim()
  // an id like claude-haiku-5-5-20261001 → "Haiku 5.5"
  const m = /^(opus|sonnet|haiku|fable)[\s-]+(\d+)(?:[.\s-](\d+))?/i.exec(named)
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`
  return named
}

export interface ModelIndicator { primary: string | null; escalation: string | null; ok: boolean; note: string | null }
export function modelIndicator(status: AskStatus | null): ModelIndicator {
  if (!status) return { primary: null, escalation: null, ok: false, note: 'Resolving models…' }
  const primary = shortModelName(status.models.default)
  const escalation = shortModelName(status.models.escalation)
  if (!status.models.ok || !primary) return { primary, escalation, ok: false, note: status.models.code ? `Model unresolved (${status.models.code})` : 'Model unresolved' }
  return { primary, escalation, ok: true, note: escalation ? `Escalates to ${escalation} for multi-property synthesis or contradictions` : 'No escalation model resolved' }
}

/* ── budget meter: today's spend against the day cap (≤ $10) ───────────── */

export type BudgetTone = 'calm' | 'attn' | 'crit' | 'off'
export interface BudgetMeter { spent: number; cap: number; fraction: number; tone: BudgetTone; label: string; detail: string }
export function budgetMeter(status: AskStatus | null): BudgetMeter | null {
  if (!status) return null
  const cap = Number(status.caps.day_usd) || 0
  const spent = Math.max(0, Number(status.spend.day_usd) || 0)
  if (cap <= 0) return { spent, cap: 0, fraction: 1, tone: 'off', label: 'No budget', detail: 'The daily spend cap is not configured, so every model call is refused.' }
  const fraction = Math.min(1, spent / cap)
  const tone: BudgetTone = fraction >= 0.9 ? 'crit' : fraction >= 0.7 ? 'attn' : 'calm'
  const runs = status.daily_run_cap ? ` · ${status.runs_today}/${status.daily_run_cap} runs` : ''
  return { spent, cap, fraction, tone, label: `${usd(spent)} / ${usd(cap, 0)}`, detail: `Today ${usd(spent)} of ${usd(cap)} (UTC day)${runs} · cycle ${usd(status.spend.cycle_usd)} of ${usd(status.caps.cycle_usd)}` }
}

export function usd(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const d = digits ?? (n !== 0 && Math.abs(n) < 0.1 ? 3 : 2)
  return `$${n.toFixed(d)}`
}

export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/* ── slash commands → the server's read-only research modes ───────────── */

export type SlashId = 'research' | 'compare' | 'inconsistencies' | 'explain' | 'quick-scan'
export interface SlashCommand { id: SlashId; label: string; hint: string; /** the server mode this frames for (escalation reason or default route) */ mode: string; framing: string | null; minProperties: number }

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'research', label: '/research', hint: 'Investigate the context and cite every source', mode: 'research', minProperties: 0, framing: 'Research the context below. Gather only the evidence the question needs and cite the tool and source for every claim.' },
  { id: 'compare', label: '/compare', hint: 'Side-by-side synthesis of 2+ properties', mode: 'multi_property_synthesis', minProperties: 2, framing: 'Compare the properties in context side by side (multi-property synthesis): scores, distress evidence, equity, ownership shape and outreach readiness. Say which is strongest on the evidence and why, citing tools.' },
  { id: 'inconsistencies', label: '/inconsistencies', hint: 'Cross-source contradictions: tax, ownership, probate, preforeclosure', mode: 'contradiction_analysis', minProperties: 1, framing: 'Find cross-source inconsistencies (contradiction analysis) for the properties in context — tax, ownership, probate, preforeclosure. Report only what the tools show; unavailable is not "no".' },
  { id: 'explain', label: '/explain', hint: 'Plain-language explanation of a signal or score', mode: 'research', minProperties: 0, framing: 'Explain in plain language, for an acquisitions operator, what the evidence in context means. Keep estimated, vendor-reported, recorded and verified values distinct.' },
  { id: 'quick-scan', label: '/quick-scan', hint: 'Quick Scan the linked property — $0, no model', mode: 'quick_scan', minProperties: 1, framing: null },
]

export interface SlashParse { command: SlashCommand | null; /** the text after the command */ rest: string; /** typing a command name (popover filter) */ partial: string | null }
export function parseSlash(text: string): SlashParse {
  const m = /^\/([a-z-]*)(\s+|$)([\s\S]*)$/i.exec(text)
  if (!m) return { command: null, rest: text, partial: null }
  const name = m[1].toLowerCase()
  const complete = m[2].length > 0
  const exact = SLASH_COMMANDS.find((c) => c.id === name) ?? null
  if (exact && complete) return { command: exact, rest: m[3], partial: null }
  return { command: null, rest: text, partial: complete ? null : name }
}
export const slashMatches = (partial: string, opts: { quickScan: boolean }) => SLASH_COMMANDS.filter((c) => (c.id !== 'quick-scan' || opts.quickScan) && c.id.startsWith(partial.toLowerCase()))

/* ── @-mentions ─────────────────────────────────────────────────────────── */

export type MentionKind = 'property' | 'campaign' | 'owner' | 'market' | 'hot_leads' | 'selection'
export interface MentionChip {
  /** stable key: kind:id */
  key: string
  kind: MentionKind
  id: string
  label: string
  detail: string | null
  /** the property ids this chip contributes (resolved when attached) */
  property_ids: string[]
  /** true for the auto-attached current selection */
  auto?: boolean
}

export const MENTION_KINDS: ReadonlyArray<{ kind: Exclude<MentionKind, 'selection'>; label: string; token: string; hint: string }> = [
  { kind: 'property', label: 'Property', token: 'property', hint: 'Entity Graph property search' },
  { kind: 'campaign', label: 'Campaign', token: 'campaign', hint: 'Campaign by name' },
  { kind: 'owner', label: 'Owner', token: 'owner', hint: 'Master owner → their properties' },
  { kind: 'market', label: 'Market', token: 'market', hint: 'Market by name' },
  { kind: 'hot_leads', label: 'HOT LEADS', token: 'hot', hint: 'The Priority inbox properties (up to 10)' },
]

export interface MentionQuery { start: number; end: number; query: string; kind: Exclude<MentionKind, 'selection'> | null; term: string }
/**
 * The @-query under the caret, if any: "@dal" → term "dal"; "@campaign spring" →
 * kind campaign, term "spring". A mention starts at the line start or after
 * whitespace and runs to the caret (spaces allowed after a kind token).
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(upto[at - 1])) return null
  const query = upto.slice(at + 1)
  if (query.length > 60 || /\n/.test(query)) return null
  const m = /^(property|campaign|owner|market|hot(?:[\s_-]?leads)?)(?:[\s:]+|$)([\s\S]*)$/i.exec(query)
  if (m) {
    const t = m[1].toLowerCase()
    const kind = t.startsWith('hot') ? 'hot_leads' : (t as MentionQuery['kind'])
    return { start: at, end: caret, query, kind, term: m[2].trim() }
  }
  // a bare term stops at the first space (a sentence continues after a mention)
  if (/\s/.test(query)) return null
  return { start: at, end: caret, query, kind: null, term: query }
}

/** Replace the @-query with nothing (the chip carries it) — returns the new text and caret. */
export function removeMentionText(text: string, q: MentionQuery): { text: string; caret: number } {
  const before = text.slice(0, q.start).replace(/[ \t]+$/, '')
  const after = text.slice(q.end).replace(/^[ \t]+/, '')
  const joined = before && after ? `${before} ${after}` : before ? `${before} ` : after
  return { text: joined, caret: before ? before.length + 1 : 0 }
}

export function addChip(chips: MentionChip[], chip: MentionChip): MentionChip[] {
  if (chips.some((c) => c.key === chip.key)) return chips
  return [...chips, chip]
}

const mask = (id: string) => `••${id.replace(/[^a-z0-9]/gi, '').slice(-4)}`
export const maskedPropertyLabel = (id: string) => `Property ${mask(id)}`

/* ── the request: question + context, exactly what POST /ask accepts ───── */

export const QUESTION_MAX = 2000
export const MAX_CONTEXT_PROPERTIES = 10

export interface AskRequest { question: string; context: { campaign_id?: string; property_ids?: string[] }; notes: string[] }
const UUID = /^[0-9a-fA-F-]{36}$/

export function composeAsk(input: { text: string; command: SlashCommand | null; chips: MentionChip[]; previousQuestion?: string | null }): AskRequest {
  const notes: string[] = []
  const lines: string[] = []
  const ids: string[] = []
  const push = (id: string) => { if (!ids.includes(id)) ids.push(id) }
  let campaign: string | null = null
  const extraCampaigns: string[] = []
  for (const c of input.chips) {
    if (c.kind === 'campaign') {
      if (!campaign && UUID.test(c.id)) campaign = c.id
      else extraCampaigns.push(c.label)
      continue
    }
    for (const p of c.property_ids) push(p)
    if (c.kind === 'owner') lines.push(`Owner in context: master owner record ${c.id}${c.property_ids.length ? ` (its properties are in context)` : ' (no properties resolved)'}.`)
    if (c.kind === 'market') lines.push(`Market in context: ${c.label}.`)
    if (c.kind === 'hot_leads') lines.push(`Inbox HOT LEADS in context: ${c.property_ids.length} propert${c.property_ids.length === 1 ? 'y' : 'ies'} from the Priority inbox.`)
    if (c.kind === 'selection' && c.detail) lines.push(`Entity Graph selection in context (${c.detail}).`)
  }
  if (extraCampaigns.length) { lines.push(`Also mentioned campaigns: ${extraCampaigns.join(', ')} (only one campaign can be read per run).`); notes.push('Only the first campaign is read; the others are named in the question.') }
  const property_ids = ids.slice(0, MAX_CONTEXT_PROPERTIES)
  if (ids.length > MAX_CONTEXT_PROPERTIES) notes.push(`The server reads ${MAX_CONTEXT_PROPERTIES} properties per run — ${ids.length - MAX_CONTEXT_PROPERTIES} were left out.`)
  if (input.command && input.command.minProperties > property_ids.length) notes.push(`${input.command.label} works best with ${input.command.minProperties}+ properties in context.`)
  const body = input.text.trim()
  const parts = [
    input.command?.framing ?? null,
    lines.length ? lines.join('\n') : null,
    input.previousQuestion ? `Follow-up to the earlier question: “${input.previousQuestion.slice(0, 200)}”` : null,
    body || (input.command ? null : ''),
  ].filter((x): x is string => Boolean(x))
  let question = parts.join('\n\n')
  if (question.length > QUESTION_MAX) { question = question.slice(0, QUESTION_MAX); notes.push(`The question was cut to ${QUESTION_MAX} characters.`) }
  const context: AskRequest['context'] = {}
  if (campaign) context.campaign_id = campaign
  if (property_ids.length) context.property_ids = property_ids
  return { question, context, notes }
}

/* ── the step timeline (Cursor's tool-use log) from the audit rows ─────── */

export type StepKind = 'model' | 'tool' | 'refused' | 'escalation' | 'declined' | 'budget' | 'error'
export interface TimelineStep {
  key: string
  kind: StepKind
  title: string
  /** the tool's machine name (mono), or the model */
  name: string | null
  rows: number | null
  latency_ms: number | null
  cost_usd: number | null
  outcome: string | null
  ok: boolean
  at: string | null
  detail: string | null
}

const ESCALATION_REASON_LABEL: Record<string, string> = { multi_property_synthesis: 'multi-property synthesis', contradiction_analysis: 'contradiction analysis' }
export const escalationReasonLabel = (r: string | null | undefined) => (r ? ESCALATION_REASON_LABEL[r] ?? r.replace(/_/g, ' ') : null)

export function buildTimeline(run: Pick<AskRun, 'audit' | 'calls'> | null, tools: AskTool[] = []): TimelineStep[] {
  if (!run) return []
  const label = (name: string | null) => tools.find((t) => t.name === name)?.label ?? (name ? name.replace(/[._]/g, ' ') : 'Tool')
  const calls = run.calls ?? []
  let callIx = 0
  const out: TimelineStep[] = []
  run.audit.forEach((a, i) => {
    const key = `${i}:${a.kind}:${a.name ?? ''}`
    switch (a.kind) {
      case 'model_call': {
        const c = calls[callIx++]
        const escalated = c?.route === 'escalation'
        const tokens = c && (c.input_tokens || c.output_tokens) ? `${(c.input_tokens ?? 0).toLocaleString('en-US')} in · ${(c.output_tokens ?? 0).toLocaleString('en-US')} out` : null
        out.push({ key, kind: 'model', title: escalated ? 'Deeper analysis' : a.outcome === 'tool_use' ? 'Planned next reads' : 'Wrote the answer', name: shortModelName(a.name), rows: null, latency_ms: a.latency_ms, cost_usd: a.cost_usd, outcome: a.outcome, ok: true, at: a.at, detail: tokens })
        break
      }
      case 'tool_call': {
        const ok = a.outcome === 'ok'
        if (a.name === 'present_result') break // the typed card itself, not a read
        const web = a.name === 'web.search' || a.name === 'web.fetch'
        out.push({ key, kind: 'tool', title: web ? (a.name === 'web.search' ? 'Searched the public web' : 'Read a public web page') : label(a.name), name: a.name, rows: a.rows_returned, latency_ms: a.latency_ms, cost_usd: web ? a.cost_usd : null, outcome: a.outcome, ok, at: a.at, detail: ok ? (web ? 'Provider-executed · public web (not LeadCommand data)' : null) : `Source unavailable (${a.outcome}) — not evidence of absence` })
        break
      }
      case 'tool_refused':
        out.push({ key, kind: 'refused', title: `Refused ${label(a.name)}`, name: a.name, rows: 0, latency_ms: null, cost_usd: null, outcome: a.outcome, ok: false, at: a.at, detail: a.outcome })
        break
      case 'escalation':
        out.push({ key, kind: 'escalation', title: `Escalated to ${shortModelName(a.name) ?? 'the deeper model'}`, name: shortModelName(a.name), rows: null, latency_ms: null, cost_usd: null, outcome: a.outcome, ok: true, at: a.at, detail: escalationReasonLabel(a.outcome) })
        break
      case 'escalation_declined':
        out.push({ key, kind: 'declined', title: 'Escalation declined', name: shortModelName(a.name), rows: null, latency_ms: null, cost_usd: null, outcome: a.outcome, ok: true, at: a.at, detail: a.outcome })
        break
      case 'budget_refused':
        out.push({ key, kind: 'budget', title: 'Budget refused the call', name: shortModelName(a.name), rows: null, latency_ms: null, cost_usd: 0, outcome: a.outcome, ok: false, at: a.at, detail: a.outcome })
        break
      case 'model_refused':
        out.push({ key, kind: 'error', title: 'Model call failed', name: shortModelName(a.name), rows: null, latency_ms: a.latency_ms, cost_usd: a.cost_usd, outcome: a.outcome, ok: false, at: a.at, detail: a.outcome })
        break
      default:
        break // run_start / run_end are the run header, not steps
    }
  })
  return out
}

export interface TimelineSummary { tools: number; rows: number; models: number; failed: number }
export function summarizeTimeline(steps: TimelineStep[]): TimelineSummary {
  let tools = 0; let rows = 0; let models = 0; let failed = 0
  for (const s of steps) {
    if (s.kind === 'tool') { tools += 1; rows += s.rows ?? 0 }
    if (s.kind === 'model') models += 1
    if (!s.ok) failed += 1
  }
  return { tools, rows, models, failed }
}

export interface EscalationBadge { model: string | null; reason: string | null; calls: number; usd: number }
export function escalationOf(run: AskRun | null): EscalationBadge | null {
  if (!run) return null
  const e = run.audit.find((a) => a.kind === 'escalation')
  if (!e && !run.counters.escalated_calls) return null
  return { model: shortModelName(e?.name ?? run.models.escalation), reason: escalationReasonLabel(e?.outcome ?? null), calls: run.counters.escalated_calls, usd: run.counters.escalated_usd }
}

/** A run's outcome in operator words (null = a normal completion). */
export function outcomeCopy(run: Pick<AskRun, 'state' | 'outcome'>): string | null {
  const o = run.outcome || ''
  if (run.state === 'running') return null
  switch (o) {
    case 'completed': case '': return run.state === 'completed' ? null : run.state
    case 'ANSWER_TRUNCATED_MAX_TOKENS': return 'The answer hit the length limit and was cut short.'
    case 'MAX_MODEL_CALLS': return 'Stopped at the per-run model-call limit; the answer uses what was gathered.'
    case 'RUN_TIMEOUT': return 'The run hit its 4-minute limit.'
    case 'CANCELLED': return 'Cancelled.'
    case 'AGENT_DISABLED': return 'The agent was switched off during the run.'
    case 'MODEL_REFUSAL': return 'The model declined to answer.'
    case 'PROMPT_HARD_CAP': return 'The gathered evidence grew past the prompt cap.'
    case 'MODEL_UNRESOLVED': case 'MODELS_UNRESOLVED': case 'DEFAULT_MODEL_UNRESOLVED': return 'No listed, priced model is resolved on the server.'
    default:
      if (/BUDGET|CAP_/.test(o)) return `A spend cap refused the run (${o}).`
      return run.state === 'completed' ? null : `${run.state === 'refused' ? 'Refused' : 'Failed'} · ${o}`
  }
}

/* ── run failures: one truthful state per class (R1, 10-12) ─────────────────
 * A refused / failed run used to surface as "Refused · PROVIDER_TIMEOUT" — the
 * operator could not tell a provider outage from a spend cap or a misconfigured
 * key. Each class below has its own title and plain-language cause; the server's
 * persisted refusal detail (reason / phase / transport) is shown as the fine print. */

export type RunFailureKind = 'timeout' | 'provider' | 'configuration' | 'permission' | 'budget'
export interface RunFailure { kind: RunFailureKind; title: string; message: string; code: string; detail: string | null }

export const RUN_FAILURE_TITLE: Record<RunFailureKind, string> = {
  timeout: 'Model provider timed out',
  provider: 'Model provider error',
  configuration: 'Agent configuration problem',
  permission: 'Refused by a permission rule',
  budget: 'Spend budget reached',
}

const TIMEOUT_COPY: Record<string, string> = {
  PROVIDER_CONNECT_TIMEOUT: 'The server could not open a connection to the model provider in time. Nothing was answered; the reserved spend stays counted until it is reconciled.',
  PROVIDER_HEADERS_TIMEOUT: 'The model provider accepted the request but did not start answering in time. The reserved spend stays counted until it is reconciled.',
  PROVIDER_READ_TIMEOUT: 'The answer was still streaming when the 90-second per-call limit ended it.',
  PROVIDER_STREAM_STALLED: 'The model provider stopped sending mid-answer, so the call was ended.',
  PROVIDER_TIMEOUT: 'The model call ran out of time before an answer arrived.',
  RUN_TIMEOUT: 'The run hit its 4-minute limit.',
}
const PROVIDER_COPY: Record<string, string> = {
  PROVIDER_UNREACHABLE: 'The server could not reach the model provider (network).',
  PROVIDER_STREAM_INTERRUPTED: 'The connection to the model provider broke mid-answer.',
  PROVIDER_UNAVAILABLE: 'The model provider is overloaded or unavailable right now.',
  PROVIDER_RATE_LIMITED: 'The model provider is rate-limiting this key; try again shortly.',
  PROVIDER_BAD_REQUEST: 'The model provider rejected the request.',
  MODEL_REJECTED_BY_API: 'The model provider no longer accepts the resolved model; the server will re-resolve models on the next run.',
  PROVIDER_ABORTED: 'The model call was cancelled.',
  PROVIDER_ERROR: 'The model provider returned an unexpected error.',
}
const CONFIG_COPY: Record<string, string> = {
  MODELS_UNRESOLVED: 'The server could not list the models its key can use, so no model can be called.',
  DEFAULT_MODEL_UNRESOLVED: 'None of the configured model candidates is listed and priced for this key.',
  MODEL_UNRESOLVED: 'No listed, priced model is resolved on the server.',
  PROVIDER_KEY_MISSING: 'The model provider key is not configured on the server.',
  PROVIDER_AUTH: 'The model provider rejected the server\'s API key.',
  PROVIDER_FORBIDDEN: 'The model provider key is not permitted to use this model.',
  UNPRICED_MODEL: 'The resolved model has no price entry, so it is never spent on.',
  MODE_NOT_READ: 'The agent mode ceiling is not read-only, so research is refused.',
  RESEARCH_DISABLED: 'Research is switched off on this server.',
  AGENT_DISABLED: 'The agent kill switch is off.',
  AGENT_RESEARCH_DISABLED: 'Research spending is switched off in the database.',
  AGENT_STORE_UNAVAILABLE: 'The agent\'s audit / budget store is unavailable, so no call is made.',
  REGISTRY_NOT_READ_ONLY: 'The tool registry is not sealed read-only.',
}
const PERMISSION_COPY: Record<string, string> = {
  IDENTITY_REQUIRED: 'A verified, named operator session is required.',
  PII_RESIDUAL: 'Contact data could not be removed from the request, so it was not sent.',
  MODEL_REFUSAL: 'The model declined to answer this question.',
}
const REASON_COPY: Record<string, string> = {
  PROVIDER_AUTH: 'the provider rejected the API key',
  PROVIDER_FORBIDDEN: 'the key is not permitted',
  PROVIDER_UNREACHABLE: 'the provider was unreachable',
  PROVIDER_KEY_MISSING: 'no API key is configured',
  LIST_FAILED: 'the model listing failed',
  NO_CANDIDATE_QUALIFIED: 'no configured candidate qualified',
}

function failureDetail(run: Pick<AskRun, 'refusal'>): string | null {
  const r = run.refusal
  if (!r) return null
  const parts: string[] = []
  if (r.reason) parts.push(REASON_COPY[r.reason] ? `${REASON_COPY[r.reason]} (${r.reason})` : r.reason)
  if (r.phase) parts.push(r.phase === 'connect' ? 'before the provider answered' : r.phase === 'stream' ? 'while the answer streamed' : r.phase)
  if (r.transport) parts.push(`transport ${r.transport}`)
  if (r.after_ms != null) parts.push(`after ${dur(r.after_ms)}`)
  if (r.binding_cap) parts.push(`cap ${r.binding_cap}`)
  return parts.length ? parts.join(' · ') : null
}

/** The failure class of a terminal, unsuccessful run — null for completed / cancelled / running. */
export function runFailureOf(run: Pick<AskRun, 'state' | 'outcome' | 'refusal'> | null | undefined): RunFailure | null {
  if (!run || (run.state !== 'refused' && run.state !== 'failed')) return null
  const code = String(run.outcome || run.refusal?.code || '').toUpperCase()
  const detail = failureDetail(run)
  const mk = (kind: RunFailureKind, message: string): RunFailure => ({ kind, title: RUN_FAILURE_TITLE[kind], message, code, detail })
  if (TIMEOUT_COPY[code]) return mk('timeout', TIMEOUT_COPY[code])
  if (/^AGENT_(SPEND|ESCALATION)_CAP_/.test(code) || code === 'DAILY_RUN_CAP') return mk('budget', `A spend cap refused the model call before anything was spent${run.refusal?.binding_cap ? ` (${run.refusal.binding_cap})` : ''}. It resets with the UTC day / billing cycle, or the owner can raise it.`)
  if (CONFIG_COPY[code]) return mk('configuration', CONFIG_COPY[code])
  if (PERMISSION_COPY[code]) return mk('permission', PERMISSION_COPY[code])
  if (PROVIDER_COPY[code]) return mk('provider', PROVIDER_COPY[code])
  if (code.startsWith('PROVIDER_')) return mk('provider', PROVIDER_COPY.PROVIDER_ERROR)
  if (code.startsWith('PROMPT_') || code === 'MAX_MODEL_CALLS') return null // limits: the outcome note explains them
  return mk('provider', `The run stopped (${code || 'unknown'}).`)
}

export const isTerminalRun = (run: Pick<AskRun, 'state'> | null | undefined) => Boolean(run && run.state !== 'running')

/* ── citations: evidence cards that deep-link ──────────────────────────── */

export interface Citation { key: string; kind: 'property' | 'campaign' | 'eg_filter' | 'market'; title: string; detail: string; href: string; cited: boolean }

export function egPropertiesFilterHref(ids: string[]): string {
  const ff = JSON.stringify([{ field_key: 'properties.property_id', operator: 'in', value: ids.slice(0, 200) }])
  return `/entity-graph?eg_tab=properties&eg_ff=${encodeURIComponent(ff)}`
}

export function citationsOf(run: AskRun | null, chips: MentionChip[], labels: Record<string, string> = {}): Citation[] {
  if (!run) return []
  const answer = run.answer?.answer_md ?? ''
  const read = run.answer?.property_ids ?? []
  const fromChips = chips.flatMap((c) => c.property_ids)
  const ids = [...new Set([...read, ...fromChips.filter((id) => answer.includes(id))])]
  const chipLabel = (id: string) => chips.find((c) => c.kind === 'property' && c.id === id)?.label
  const out: Citation[] = ids.slice(0, 12).map((id) => ({
    key: `property:${id}`,
    kind: 'property',
    title: labels[id] ?? chipLabel(id) ?? maskedPropertyLabel(id),
    detail: answer.includes(id) ? 'Cited in the answer · open in Entity Graph' : 'Read by the agent · open in Entity Graph',
    href: `/entity-graph/property/${encodeURIComponent(id)}`,
    cited: answer.includes(id),
  }))
  if (ids.length > 1) out.push({ key: 'eg:filter', kind: 'eg_filter', title: `All ${ids.length} properties`, detail: 'Open as an Entity Graph filter', href: egPropertiesFilterHref(ids), cited: false })
  for (const c of chips) {
    if (c.kind === 'campaign' && UUID.test(c.id)) out.push({ key: `campaign:${c.id}`, kind: 'campaign', title: c.label, detail: 'Campaign in context · open in Campaign Command', href: `/campaign-command?campaign=${encodeURIComponent(c.id)}`, cited: answer.includes(c.id) })
    if (c.kind === 'market') out.push({ key: `market:${c.id}`, kind: 'market', title: c.label, detail: 'Market in context · open in Entity Graph', href: `/entity-graph?eg_tab=markets&eg_q=${encodeURIComponent(c.label)}`, cited: false })
  }
  return out
}

/** The read tools the run used (for the “Sources” line). */
export function sourcesOf(run: AskRun | null): string[] {
  if (!run) return []
  return [...new Set(run.audit.filter((a) => a.kind === 'tool_call' && a.outcome === 'ok' && a.name && a.name !== 'present_result').map((a) => a.name as string))]
}

/* ── follow-up suggestions (they fill the composer; nothing auto-sends) ── */

export interface FollowUp { id: string; label: string; text: string }
export function followUpsOf(run: AskRun | null, chips: MentionChip[], command: SlashId | null): FollowUp[] {
  if (!run || run.state === 'running') return []
  const n = new Set(chips.flatMap((c) => c.property_ids).concat(run.answer?.property_ids ?? [])).size
  const hasCampaign = chips.some((c) => c.kind === 'campaign')
  const out: FollowUp[] = []
  // the server does not carry earlier answers into a new run: this re-asks, it does not "remember"
  if (run.outcome === 'ANSWER_TRUNCATED_MAX_TOKENS') out.push({ id: 'gaps', label: 'Ask again for the gaps only', text: 'List only the gaps and unavailable sources for this context.' })
  if (n >= 2 && command !== 'compare') out.push({ id: 'compare', label: `Compare these ${n} properties`, text: '/compare ' })
  if (n >= 1 && command !== 'inconsistencies') out.push({ id: 'inconsistencies', label: n === 1 ? 'Check this property for inconsistencies' : 'Check them for inconsistencies', text: '/inconsistencies ' })
  if (hasCampaign) out.push({ id: 'campaign-top', label: 'Strongest targets in this campaign', text: 'Which properties in this campaign have the strongest distress evidence, and what is it?' })
  if (command !== 'explain') out.push({ id: 'explain', label: 'Explain the evidence in plain terms', text: '/explain ' })
  return out.slice(0, 3)
}

/* ── thread titles ──────────────────────────────────────────────────────── */

export function threadTitle(text: string, command: SlashId | null, chips: MentionChip[]): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t) return t.length > 64 ? `${t.slice(0, 61)}…` : t
  const cmd = command ? SLASH_COMMANDS.find((c) => c.id === command)?.label : null
  const subject = chips[0]?.label
  return [cmd, subject].filter(Boolean).join(' · ') || 'New question'
}

/* ── the key map (pure; the components only dispatch) ──────────────────── */

export interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }
export type ComposerKeyAction = 'send' | 'newline' | 'popover-next' | 'popover-prev' | 'popover-pick' | 'popover-close' | 'close' | 'remove-last-chip' | 'stop' | null

export function composerKeyAction(e: KeyLike, s: { popoverOpen: boolean; empty: boolean; running: boolean; chips: number }): ComposerKeyAction {
  if (e.isComposing) return null
  const mod = Boolean(e.metaKey || e.ctrlKey)
  if (s.popoverOpen) {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) return 'popover-next'
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) return 'popover-prev'
    if ((e.key === 'Enter' && !mod && !e.shiftKey) || e.key === 'Tab') return 'popover-pick'
    if (e.key === 'Escape') return 'popover-close'
  }
  if (e.key === 'Enter' && mod) return 'send'
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) return 'send'
  if (e.key === 'Enter') return 'newline'
  if (e.key === 'Escape') return 'close'
  if (e.key === 'Backspace' && mod && s.running) return 'stop'
  if (e.key === 'Backspace' && s.empty && s.chips > 0 && !mod) return 'remove-last-chip'
  return null
}

export type GlobalKeyAction = 'focus-dock' | 'toggle-palette' | 'focus-composer' | null
/** ⌘L anywhere: open + focus the docked composer. ⌘⇧L: the floating palette. ⌘K inside the agent: focus its composer (outside, ⌘K stays the Command Deck). */
export function globalKeyAction(e: KeyLike, s: { insideAgent: boolean }): GlobalKeyAction {
  const mod = Boolean(e.metaKey || e.ctrlKey)
  if (!mod || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'l') return e.shiftKey ? 'toggle-palette' : 'focus-dock'
  if (k === 'k' && !e.shiftKey && s.insideAgent) return 'focus-composer'
  return null
}
