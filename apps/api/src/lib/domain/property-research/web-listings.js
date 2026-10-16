// ─── PUBLIC-WEB GAP RESEARCH (8.5.20-b) ──────────────────────────────────────
// The question the property.research mission hands to the EXISTING research ask
// service (Anthropic web_search via the agent web tool; gated by
// AGENT_WEB_RESEARCH_ENABLED; blocked-domain policy and server-observed citations
// from research/web-research.js), and the parser for its answer.
//
// Rules:
//   • only property + market facts are asked for (listing status, list price, days on
//     market, price reductions, zoning / permitting / flood notes) — never people;
//   • every parsed item must cite a URL the PROVIDER observed (a URL the model only
//     wrote in prose is dropped);
//   • a web price is ALWAYS a listing (evidence_kind 'listing'), never a sale.
const TOPIC_RE = /^(subject_listing|nearby_listing|zoning|permitting|flood|development|hoa|tax)$/

/** The bounded question for the gaps the internal dossier could not fill. */
export function buildWebQuestion(dossier, { gaps = null } = {}) {
  const s = dossier?.sections || {}
  const addr = [s.identity?.address?.value, s.identity?.city?.value, s.identity?.state?.value, s.identity?.zip?.value].filter(Boolean).join(', ')
  const want = (gaps || dossier?.gaps || []).filter((g) => ['listing_status', 'zoning', 'flood_exposure', 'entitled_density'].includes(g))
  if (!addr) return null
  const asks = [
    'Is this property currently listed for sale, pending, or recently sold according to public listing sites? Give status, list price, days on market and price reductions if shown.',
    'List up to 5 active or pending listings of similar property types within about 1 mile (status, list price, days on market).',
    want.includes('zoning') || want.includes('entitled_density') ? "What zoning district applies and what density does it allow (from the city/county zoning map or code)?" : null,
    want.includes('flood_exposure') ? 'Is it in a FEMA special flood hazard area?' : null,
  ].filter(Boolean)
  return [
    `Public-web property research for: ${addr}.`,
    'Use web search only for PROPERTY and MARKET facts. Never look up or report people, owners, phone numbers or e-mails.',
    ...asks.map((q, i) => `${i + 1}. ${q}`),
    'Listings are NOT sales: report list prices only as listings.',
    'End your answer with ONE JSON block: {"items":[{"topic":"subject_listing|nearby_listing|zoning|permitting|flood|development","status":"active|pending|contingent|off_market|withdrawn|expired|sold_reported|unknown","list_price":null,"days_on_market":null,"price_reductions":null,"value":null,"url":"<the page you read>"}]}. Use null when unknown. Only include items you found on a page.',
  ].join('\n')
}

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(String(v).replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : null
}
const firstJson = (text) => {
  const s = String(text || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  for (const c of [fenced?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean)) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch { /* next */ }
  }
  return null
}
const normUrl = (u) => { try { const x = new URL(String(u)); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}` } catch { return null } }

/**
 * @param {string} answer             the ask service's answer_md
 * @param {Array<{url:string, retrieved_at?:string}>} citations  server-observed citations of the run
 * @returns {{ listings: Array<object>, notes: Array<object>, dropped_uncited: number }}
 */
export function parseWebAnswer(answer, citations = []) {
  const observed = new Map((citations || []).map((c) => [normUrl(c.url), c]).filter(([k]) => k))
  const parsed = firstJson(answer)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  const listings = []
  const notes = []
  let dropped = 0
  for (const it of items.slice(0, 20)) {
    const topic = String(it?.topic || '').toLowerCase()
    if (!TOPIC_RE.test(topic)) continue
    const cite = observed.get(normUrl(it?.url))
    if (!cite) { dropped += 1; continue }
    if (topic === 'subject_listing' || topic === 'nearby_listing') {
      listings.push({ evidence_kind: 'listing', is_subject: topic === 'subject_listing', status: String(it.status || 'unknown').toLowerCase(), list_price: num(it.list_price), days_on_market: num(it.days_on_market), price_reductions: num(it.price_reductions), url: cite.url, retrieved_at: cite.retrieved_at || null })
    } else {
      notes.push({ topic, value: it.value == null ? null : String(it.value).slice(0, 240), url: cite.url, retrieved_at: cite.retrieved_at || null, confidence: 0.4 })
    }
  }
  return { listings, notes, dropped_uncited: dropped }
}
