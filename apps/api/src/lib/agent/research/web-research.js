// Public-web research for the read-only research agent (Intelligence 2.0, increment A).
//
// The web tools are Anthropic SERVER tools (web_search / web_fetch on the Messages
// API): the provider performs the egress, inside the same model call. LeadCommand's
// server never fetches a URL itself (FORBIDDEN_CAPABILITIES 'web_egress' still holds).
//
// Gates (all required; each fails closed):
//   AGENT_WEB_RESEARCH_ENABLED=1   offers web_search on the default (Haiku) route
//   AGENT_WEB_FETCH_ENABLED=1      additionally offers web_fetch (needs the flag above)
//   the run is not a conversational fast-path turn and not an escalated call
//
// Policy (code constants; widening them is a reviewed change):
//   * blocked_domains: court / records portals that need a login, paywalled
//     publishers, and people-search / data-broker sites (contact data the agent
//     must never surface). web_search cannot combine allowed + blocked lists, so
//     the policy is a block list, and every citation is re-checked server-side.
//   * no CAPTCHA bypass: nothing here retries, proxies or solves anything; a page
//     the provider cannot fetch is reported as unavailable, never worked around.
//   * max_uses per model call AND per run (the run budget shrinks as uses settle).
//
// Cost (price-book row: web_search_use = $0.01 per search; web fetch has no
// per-use fee, only the tokens it adds):
//   reserve  = token worst case over an inflated prompt bound (every possible
//              search / fetch result re-read by each internal sampling step)
//              + max_search_uses × $0.01
//   settle   = usage tokens × the tier + usage.server_tool_use.web_search_requests × $0.01
// A search is only ever CLAIMED (event, audit row, UI) from the usage counts.
import { paramsHash } from './pii.js'
import { round6 } from '../budget/budget-config.js'

export const WEB_FLAG = 'AGENT_WEB_RESEARCH_ENABLED'
export const WEB_FETCH_FLAG = 'AGENT_WEB_FETCH_ENABLED'

/** Price per web search (USD). Mirrors budget/price-book.js row 10 ($10 / 1k searches). */
export const WEB_SEARCH_USD = 0.01

export const WEB_LIMITS = Object.freeze({
  search_uses_per_call: 3,
  search_uses_per_run: 5,
  fetch_uses_per_call: 2,
  fetch_uses_per_run: 3,
  fetch_max_content_tokens: 6000,
  // reservation bound for ONE search result block (titles, urls, encrypted page content)
  search_result_tokens_bound: 30_000,
  // one fetched document: max_content_tokens + wrapper overhead
  fetch_result_tokens_bound: 8000,
  citations_max: 12,
})

/** Tool type versions: the basic variants (no code-execution-backed filtering, no extra fees). */
export const WEB_TOOL_TYPES = Object.freeze({ search: 'web_search_20250305', fetch: 'web_fetch_20250910' })

export const WEB_BLOCKED_DOMAINS = Object.freeze([
  // court / case portals that require an account or login
  'pacer.gov', 'uscourts.gov', 'pacer.uscourts.gov', 'courtlink.lexisnexis.com', 'research.txcourts.gov', 'efiletexas.gov', 'tylerhost.net', 'odysseyfileandserve.com', 'mycase.in.gov',
  // paywalled publishers and data services
  'wsj.com', 'nytimes.com', 'ft.com', 'bloomberg.com', 'barrons.com', 'economist.com', 'washingtonpost.com', 'businessinsider.com', 'law360.com', 'westlaw.com', 'lexisnexis.com', 'costar.com', 'loopnet.com', 'attomdata.com', 'propstream.com',
  // people-search / data brokers (contact data: never surfaced)
  'whitepages.com', 'spokeo.com', 'beenverified.com', 'truepeoplesearch.com', 'fastpeoplesearch.com', 'intelius.com', 'radaris.com', 'peoplefinders.com', 'thatsthem.com', 'mylife.com', 'instantcheckmate.com', 'truthfinder.com', 'peoplesearchnow.com', 'searchpeoplefree.com', 'clustrmaps.com', 'nuwber.com', 'usphonebook.com', 'cyberbackgroundchecks.com',
])

export function isWebEnabled(env = process.env) {
  return String(env?.[WEB_FLAG] ?? '').trim() === '1'
}
export function isWebFetchEnabled(env = process.env) {
  return isWebEnabled(env) && String(env?.[WEB_FETCH_FLAG] ?? '').trim() === '1'
}

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '') } catch { return null }
}

/** Is a URL on (or under) a blocked domain? A URL that does not parse is treated as blocked. */
export function isBlockedUrl(url, blocked = WEB_BLOCKED_DOMAINS) {
  const h = hostOf(url)
  if (!h) return true
  if (!/^https?:$/i.test(new URL(String(url)).protocol)) return true
  return blocked.some((d) => h === d || h.endsWith(`.${d}`))
}

/**
 * The server-tool definitions for one model call, or [] when web research is off or
 * the run's web budget is spent.
 * @param {{ env?: object, used?: { searches: number, fetches: number } }} opts
 */
export function webToolsFor({ env = process.env, used = { searches: 0, fetches: 0 } } = {}) {
  if (!isWebEnabled(env)) return []
  const out = []
  const searchLeft = Math.max(0, WEB_LIMITS.search_uses_per_run - (used.searches || 0))
  if (searchLeft > 0) out.push({ type: WEB_TOOL_TYPES.search, name: 'web_search', max_uses: Math.min(WEB_LIMITS.search_uses_per_call, searchLeft), blocked_domains: [...WEB_BLOCKED_DOMAINS] })
  const fetchLeft = Math.max(0, WEB_LIMITS.fetch_uses_per_run - (used.fetches || 0))
  if (isWebFetchEnabled(env) && fetchLeft > 0) {
    out.push({ type: WEB_TOOL_TYPES.fetch, name: 'web_fetch', max_uses: Math.min(WEB_LIMITS.fetch_uses_per_call, fetchLeft), blocked_domains: [...WEB_BLOCKED_DOMAINS], max_content_tokens: WEB_LIMITS.fetch_max_content_tokens, citations: { enabled: true } })
  }
  return out
}

/** max_uses offered in one request's tools ({ searches, fetches }). */
export function offeredUses(tools = []) {
  let searches = 0
  let fetches = 0
  for (const t of tools || []) {
    if (t?.name === 'web_search' && /^web_search_/.test(String(t.type || ''))) searches += Number(t.max_uses) || 0
    if (t?.name === 'web_fetch' && /^web_fetch_/.test(String(t.type || ''))) fetches += Number(t.max_uses) || 0
  }
  return { searches, fetches }
}

/**
 * Worst-case additions for a call that offers web tools.
 * The provider runs an internal loop: each search / fetch result joins the
 * context and the NEXT internal sampling step re-reads everything before it. With
 * N = uses and R = per-result bound, the extra prompt tokens are bounded by
 *   N·P (P = the base prompt, re-read once per extra step) + R·N(N+1)/2.
 * Returns { extra_prompt_tokens, fee_usd }.
 */
export function webWorstCase({ promptTokensBound, offered }) {
  const s = Math.max(0, offered?.searches || 0)
  const f = Math.max(0, offered?.fetches || 0)
  const n = s + f
  if (n === 0) return { extra_prompt_tokens: 0, fee_usd: 0 }
  const r = Math.max(WEB_LIMITS.search_result_tokens_bound, WEB_LIMITS.fetch_result_tokens_bound)
  const extra = n * Math.max(0, promptTokensBound) + Math.ceil((r * n * (n + 1)) / 2)
  return { extra_prompt_tokens: extra, fee_usd: round6(s * WEB_SEARCH_USD) }
}

/** Server-tool request counts from a provider usage object (never estimated). */
export function webUsage(usage = {}) {
  const st = usage?.server_tool_use || {}
  return { searches: Math.max(0, Number(st.web_search_requests) || 0), fetches: Math.max(0, Number(st.web_fetch_requests) || 0) }
}

export const webFeeUsd = (usage) => round6(webUsage(usage).searches * WEB_SEARCH_USD)

const clip = (s, n) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null)

/**
 * What the provider actually did in one message: each server_tool_use block paired
 * with its result block. Citations are server-observed results only (a URL the
 * model writes in prose is never a citation), blocked domains dropped.
 * @returns {{ uses: Array<{ id: string, tool: 'web_search'|'web_fetch', query: string|null, url: string|null, results: number, error: string|null, domains: string[] }>, citations: Array<{ url: string, title: string|null, page_age: string|null, retrieved_at: string, source: 'web_search'|'web_fetch' }> }}
 */
export function extractWebEvidence(message, { retrievedAt = new Date().toISOString() } = {}) {
  const content = Array.isArray(message?.content) ? message.content : []
  const uses = []
  const byId = new Map()
  for (const b of content) {
    if (b?.type === 'server_tool_use' && (b.name === 'web_search' || b.name === 'web_fetch')) {
      const u = { id: String(b.id || ''), tool: b.name, query: b.name === 'web_search' ? clip(b.input?.query, 200) : null, url: b.name === 'web_fetch' ? clip(b.input?.url, 500) : null, results: 0, error: null, domains: [] }
      uses.push(u)
      byId.set(u.id, u)
    }
  }
  const citations = []
  const seen = new Set()
  const add = (url, title, page_age, source) => {
    if (!url || seen.has(url) || isBlockedUrl(url)) return
    seen.add(url)
    if (citations.length < WEB_LIMITS.citations_max) citations.push({ url: String(url).slice(0, 500), title: clip(title, 200), page_age: clip(page_age, 40), retrieved_at: retrievedAt, source })
  }
  for (const b of content) {
    if (b?.type === 'web_search_tool_result') {
      const u = byId.get(String(b.tool_use_id || ''))
      if (Array.isArray(b.content)) {
        const rows = b.content.filter((r) => r?.type === 'web_search_result')
        if (u) { u.results = rows.length; u.domains = [...new Set(rows.map((r) => hostOf(r.url)).filter(Boolean))].slice(0, 10) }
        for (const r of rows) add(r.url, r.title, r.page_age, 'web_search')
      } else if (u) u.error = clip(b.content?.error_code, 40) || 'SEARCH_ERROR'
    }
    if (b?.type === 'web_fetch_tool_result') {
      const u = byId.get(String(b.tool_use_id || ''))
      const c = b.content || {}
      if (c.type === 'web_fetch_result') {
        if (u) { u.results = 1; u.domains = [hostOf(c.url)].filter(Boolean) }
        add(c.url, c.content?.title ?? null, c.retrieved_at ?? null, 'web_fetch')
      } else if (u) u.error = clip(c.error_code, 40) || 'FETCH_ERROR'
    }
  }
  // citations the model attached to its text (still only server-observed URLs pass)
  for (const b of content) {
    if (b?.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c?.type === 'web_search_result_location' && c.url) add(c.url, c.title, null, 'web_search')
    }
  }
  return { uses, citations }
}

/** The audit row for one provider-executed web use (kind tool_call: the existing CHECK allows it). */
export function webAuditRow(use, { feeUsd = 0 } = {}) {
  return {
    kind: 'tool_call',
    name: use.tool === 'web_search' ? 'web.search' : 'web.fetch',
    params_sha256: paramsHash(use.tool === 'web_search' ? { query: use.query } : { url: use.url }),
    rows_returned: use.results,
    cost_usd: feeUsd,
    outcome: use.error ? String(use.error).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60) : 'ok',
    doc: { provider_executed: true, domains: use.domains.slice(0, 10) },
  }
}
