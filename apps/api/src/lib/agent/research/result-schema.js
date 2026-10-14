// Typed, versioned structured results for the research agent (Intelligence 2.0, increment A).
//
// The model fills a result through ONE final tool call, present_result, instead of
// (or alongside) its markdown answer. The server validates the input here; an
// invalid or unknown result is dropped (audited) and the markdown answer stands.
// The UI renders known kinds with components and falls back to markdown.
//
// Evidence separation: every result envelope carries
//   evidence.internal    — LeadCommand records the run's read tools returned (tool names, property ids)
//   evidence.public_web  — web citations the PROVIDER observed (url, title, retrieved date)
// Model-written URLs never become citations: a URL in a result must be one the
// server saw in a web_search / web_fetch result block of this run.
//
// approval_preview is a PREVIEW only: executed is always false, and nothing in the
// research agent can approve or execute (the registry is read-only and sealed).

export const RESULT_SCHEMA = 'lc.ask.result'
export const RESULT_VERSION = 1
export const RESULT_TOOL = 'present_result'
export const RESULT_KINDS = Object.freeze(['answer', 'property_research', 'web_citations', 'conversation_summary', 'campaign_audience_preview', 'approval_preview'])
export const EVIDENCE_CLASSES = Object.freeze(['internal', 'public_web'])

const str = (max) => ({ type: 'string', maxLength: max })
const fact = { type: 'object', additionalProperties: false, properties: { label: str(80), value: str(300), evidence: { type: 'string', enum: [...EVIDENCE_CLASSES] }, source: str(120) }, required: ['label', 'value', 'evidence'] }

/** The present_result tool definition (input_schema = the union the validator enforces). */
export const RESULT_TOOL_DEF = Object.freeze({
  name: RESULT_TOOL,
  description: 'Finish the run with a typed result card. Call it at most once, as your final step, only when a kind fits; otherwise answer in Markdown. Kinds: property_research (one property: facts, each tagged internal = LeadCommand records or public_web = a web result you received this run; listing_status only from a web result), conversation_summary, campaign_audience_preview (describe an audience; never claim it was created), approval_preview (describe an action that would need operator approval; it is never executed). Put internal and public_web facts in their own evidence class; never mix them.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['property_research', 'conversation_summary', 'campaign_audience_preview', 'approval_preview'] },
      title: str(140),
      summary: str(1200),
      property_id: str(64),
      address_label: str(160),
      facts: { type: 'array', maxItems: 20, items: fact },
      listing_status: { type: 'object', additionalProperties: false, properties: { status: str(60), source_url: str(500), as_of: str(40) }, required: ['status', 'source_url'] },
      points: { type: 'array', maxItems: 12, items: str(300) },
      gaps: { type: 'array', maxItems: 12, items: str(300) },
      campaign_id: str(64),
      filters: { type: 'array', maxItems: 12, items: str(200) },
      estimated_count: { type: ['integer', 'null'], minimum: 0 },
      action: str(120),
      target: str(200),
      effect: str(400),
    },
    required: ['kind', 'title'],
  },
})

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const s = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const arrOf = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter((x) => x != null) : [])

function fail(code, detail) { return { ok: false, code, detail } }

/**
 * Validate the model's present_result input against the schema and the run's
 * observed evidence. Returns { ok: true, block } or { ok: false, code, detail }.
 * @param {unknown} input
 * @param {{ observedUrls: Set<string>, internalPropertyIds?: Set<string> }} ctx
 */
export function validateResultInput(input, { observedUrls = new Set(), internalPropertyIds = new Set() } = {}) {
  if (!isObj(input)) return fail('RESULT_NOT_OBJECT')
  const kind = input.kind
  if (!RESULT_KINDS.includes(kind) || kind === 'answer' || kind === 'web_citations') return fail('RESULT_KIND_UNKNOWN', String(kind).slice(0, 40))
  const allowed = new Set(Object.keys(RESULT_TOOL_DEF.input_schema.properties))
  for (const k of Object.keys(input)) if (!allowed.has(k)) return fail('RESULT_FIELD_UNKNOWN', k.slice(0, 40))
  const title = s(input.title, 140)
  if (!title) return fail('RESULT_TITLE_REQUIRED')
  const base = { kind, title, summary: s(input.summary, 1200) }
  if (kind === 'property_research') {
    const facts = []
    for (const f of Array.isArray(input.facts) ? input.facts.slice(0, 20) : []) {
      if (!isObj(f)) return fail('RESULT_FACT_SHAPE')
      const label = s(f.label, 80); const value = s(f.value, 300)
      if (!label || !value || !EVIDENCE_CLASSES.includes(f.evidence)) return fail('RESULT_FACT_SHAPE', label || 'fact')
      const source = s(f.source, 120)
      // a public_web fact must name a URL this run actually observed
      if (f.evidence === 'public_web' && !(source && observedUrls.has(source))) return fail('RESULT_WEB_SOURCE_UNOBSERVED', label)
      facts.push({ label, value, evidence: f.evidence, source })
    }
    let listing = null
    if (input.listing_status != null) {
      const l = input.listing_status
      if (!isObj(l) || !s(l.status, 60) || !s(l.source_url, 500)) return fail('RESULT_LISTING_SHAPE')
      if (!observedUrls.has(l.source_url)) return fail('RESULT_WEB_SOURCE_UNOBSERVED', 'listing_status')
      listing = { status: s(l.status, 60), source_url: l.source_url, as_of: s(l.as_of, 40) }
    }
    const pid = s(input.property_id, 64)
    if (pid && !/^[A-Za-z0-9_.:-]{1,64}$/.test(pid)) return fail('RESULT_PROPERTY_ID_SHAPE')
    return { ok: true, block: { ...base, property_id: pid, property_id_read: pid ? internalPropertyIds.has(pid) : false, address_label: s(input.address_label, 160), facts, listing_status: listing, gaps: arrOf(input.gaps, 12, (x) => s(x, 300)) } }
  }
  if (kind === 'conversation_summary') return { ok: true, block: { ...base, points: arrOf(input.points, 12, (x) => s(x, 300)) } }
  if (kind === 'campaign_audience_preview') {
    const n = input.estimated_count
    if (n != null && !(Number.isInteger(n) && n >= 0)) return fail('RESULT_COUNT_SHAPE')
    return { ok: true, block: { ...base, campaign_id: s(input.campaign_id, 64), filters: arrOf(input.filters, 12, (x) => s(x, 200)), estimated_count: n ?? null, created: false } }
  }
  // approval_preview
  const action = s(input.action, 120)
  if (!action) return fail('RESULT_ACTION_REQUIRED')
  return { ok: true, block: { ...base, action, target: s(input.target, 200), effect: s(input.effect, 400), requires_approval: true, executed: false } }
}

/**
 * The envelope stored with the run and sent to the UI. Server-built: the plain
 * answer block and the web_citations block come from what the server observed;
 * only the optional typed block comes from the (validated) model input.
 */
export function buildResult({ answerMd = '', typed = null, citations = [], internal = { tools: [], property_ids: [] } }) {
  const blocks = []
  if (typed) blocks.push(typed)
  if (answerMd) blocks.push({ kind: 'answer', markdown: answerMd })
  if (citations.length) blocks.push({ kind: 'web_citations', citations: citations.map((c) => ({ url: c.url, title: c.title, retrieved_at: c.retrieved_at, page_age: c.page_age ?? null, source: c.source })) })
  return {
    schema: RESULT_SCHEMA,
    version: RESULT_VERSION,
    blocks,
    evidence: {
      internal: { tools: [...new Set(internal.tools || [])].slice(0, 30), property_ids: [...new Set(internal.property_ids || [])].slice(0, 50) },
      public_web: citations.map((c) => ({ url: c.url, title: c.title, retrieved_at: c.retrieved_at })),
    },
  }
}

/** Structural check of a stored / received envelope (the UI's contract). */
export function isValidEnvelope(env) {
  if (!isObj(env) || env.schema !== RESULT_SCHEMA || env.version !== RESULT_VERSION || !Array.isArray(env.blocks)) return false
  if (!isObj(env.evidence) || !isObj(env.evidence.internal) || !Array.isArray(env.evidence.public_web)) return false
  return env.blocks.every((b) => isObj(b) && RESULT_KINDS.includes(b.kind))
}
