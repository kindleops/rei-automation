import type { CommandResult } from '../../domain/command-center/command.types'
import { miPath, type MiRouteState } from './mi-route-state'

/**
 * MARKET INTELLIGENCE COMMANDS for the Command Deck (brief §35). Pure: query →
 * results. A fixed grammar, no NLP; place names are resolved by the app's own
 * geography search when it opens (ambiguous names show every match there).
 *
 *   market 55411 · market Dallas · mi Harris County
 *   rank zip by investor purchases [in Texas]
 *   compare Dallas Houston  ·  compare 75217, 75227, 75216
 *   screen Texas investor share > 15
 */

/** Phrases → metric registry ids (ids only; the registry owns every definition). */
const METRIC_WORDS: Array<[RegExp, string]> = [
  [/^investor (purchase )?share$|^investor %$/, 'investor_purchase_share'],
  [/^investor (purchases?|activity|buys?)$|^investors$/, 'investor_purchase_count'],
  [/^cash (share|%)$/, 'cash_purchase_share'],
  [/^cash( purchases?)?$/, 'cash_purchase_count'],
  [/^(sales|volume|sales volume|sales count)$/, 'sales_count'],
  [/^(median )?price$|^median sale price$/, 'median_sale_price'],
  [/^(ppsf|price per (sq ?ft|square foot)|\$\/sq ?ft)$/, 'median_ppsf'],
  [/^(ppu|price per unit|price\/unit)$/, 'median_price_per_unit'],
  [/^(entity|entity[- ]owned|entity ownership)$/, 'entity_owned_count'],
  [/^(growth|sales growth|sales change)$/, 'sales_growth'],
  [/^(buyers|buyer activity|company buyers)$/, 'company_buyer_count'],
  [/^(sellers|seller records|seller universe)$/, 'seller_record_count'],
  [/^(reachable|sms|sms[- ]eligible)$/, 'sms_eligible_count'],
  [/^(income|household income|median income)$/, 'median_household_income'],
  [/^tax delinquen(t|cy)$/, 'tax_delinquent_share'],
  [/^(mf|multifamily) sales$/, 'mf_sale_count'],
]
const PCT_METRICS = new Set(['investor_purchase_share', 'cash_purchase_share', 'sales_growth', 'tax_delinquent_share'])
const LEVEL_WORDS: Record<string, string> = { zip: 'zip', zips: 'zip', 'zip codes': 'zip', city: 'city', cities: 'city', county: 'county', counties: 'county', market: 'market', markets: 'market', state: 'state', states: 'state' }

export function metricOfPhrase(phrase: string): string | null {
  const p = phrase.toLowerCase().replace(/\s+/g, ' ').trim()
  for (const [re, id] of METRIC_WORDS) if (re.test(p)) return id
  return null
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

const result = (id: string, title: string, subtitle: string, state: Partial<MiRouteState>, score = 1058): CommandResult => ({
  id: `mi:${id}`, type: 'system_action', title, subtitle, icon: 'grid', score, route: miPath(state),
  meta: { provider: 'market_intelligence', groupLabel: 'Market Intelligence', hint: 'Open' },
})
const beside = (id: string, title: string, subtitle: string, state: Partial<MiRouteState>, score = 1052): CommandResult => ({
  id: `mi:${id}:beside`, type: 'system_action', title, subtitle, icon: 'grid', score,
  payload: { __workspace: { kind: 'beside', path: miPath(state), label: 'Market Intelligence' } },
  meta: { provider: 'market_intelligence', groupLabel: 'Market Intelligence', hint: 'Beside' },
})

/** "> 15", ">= 100", "under 150k", "at least 20%". Pure. */
export function parseComparison(text: string, metric: string): { op: 'gte' | 'lte' | 'gt' | 'lt'; value: number } | null {
  const m = /^(>=|<=|>|<|≥|≤|over|above|under|below|at least|at most)\s*\$?([\d.,]+)\s*(%|k|m)?$/i.exec(norm(text))
  if (!m) return null
  const opWord = m[1].toLowerCase()
  const op = opWord === '>=' || opWord === '≥' || opWord === 'at least' ? 'gte' : opWord === '<=' || opWord === '≤' || opWord === 'at most' ? 'lte' : opWord === '>' || opWord === 'over' || opWord === 'above' ? 'gt' : 'lt'
  let value = Number(m[2].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  const suf = (m[3] || '').toLowerCase()
  if (suf === 'k') value *= 1e3
  if (suf === 'm') value *= 1e6
  if (PCT_METRICS.has(metric) && (suf === '%' || value > 1)) value /= 100
  return { op, value }
}

export function marketIntelDeckCommands(query: string): CommandResult[] {
  const raw = norm(query)
  const q = raw.toLowerCase()
  if (q.length < 3) return []
  const out: CommandResult[] = []

  let m = /^(?:market|mi|market intel(?:ligence)?)\s+(.+)$/i.exec(raw)
  if (m) {
    const place = m[1].trim()
    const zip = /^\d{5}$/.test(place)
    const st: Partial<MiRouteState> = zip ? { geo: `zip:${place}` } : { q: place }
    out.push(result(`market:${place}`, `Market Intelligence: ${place}`, zip ? 'Open the ZIP dossier' : 'Find the geography and open its dossier', st))
    out.push(beside(`market:${place}`, `Market Intelligence beside: ${place}`, 'Opens beside the current pane', st))
    return out
  }

  m = /^rank\s+(zips?|zip codes|cities|city|counties|county|markets?|states?)\s+by\s+(.+?)(?:\s+in\s+(.+))?$/i.exec(raw)
  if (m) {
    const level = LEVEL_WORDS[m[1].toLowerCase()]
    const metric = metricOfPhrase(m[2])
    if (level && metric) {
      const st: Partial<MiRouteState> = { tab: 'rankings', rl: level, rm: metric, ...(m[3] ? { q: m[3].trim() } : {}) }
      out.push(result(`rank:${level}:${metric}:${m[3] ?? ''}`, `Rank ${m[1].toLowerCase()} by ${m[2].trim()}${m[3] ? ` in ${m[3].trim()}` : ''}`, 'Market Intelligence rankings', st))
    }
    return out
  }

  m = /^compare\s+(.+)$/i.exec(raw)
  if (m) {
    const body = m[1]
    const names = (/,|\bvs\.?\b|\band\b|\|/i.test(body) ? body.split(/,|\bvs\.?\b|\band\b|\|/i) : body.split(/\s+/)).map((s) => s.trim()).filter(Boolean).slice(0, 6)
    if (names.length >= 2) out.push(result(`compare:${names.join('|')}`, `Compare ${names.join(' · ')}`, 'Same period, asset class and rules for every geography', { tab: 'compare', cq: names }))
    return out
  }

  m = /^screen\s+(.+?)\s*((?:>=|<=|>|<|≥|≤|over|above|under|below|at least|at most)\s*\$?[\d.,]+\s*(?:%|k|m)?)$/i.exec(raw)
  if (m) {
    // The metric is the longest trailing phrase the registry knows; the place is what precedes it.
    const words = m[1].split(' ')
    for (let k = Math.min(4, words.length - 1); k >= 1; k -= 1) {
      const phrase = words.slice(words.length - k).join(' ')
      const metric = metricOfPhrase(phrase)
      if (!metric) continue
      const cmp = parseComparison(m[2], metric)
      if (!cmp) break
      const place = words.slice(0, words.length - k).join(' ')
      out.push(result(`screen:${place}:${metric}:${cmp.op}:${cmp.value}`, `Screen ${place}: ${phrase} ${m[2].trim()}`, 'ZIPs inside the place that pass the filter', { tab: 'screener', sl: 'zip', q: place, sf: [{ metric, ...cmp }] }))
      break
    }
    return out
  }

  if (/^(market intel|market intelligence|markets?|heatmap|screener)$/.test(q)) {
    out.push(result('open', 'Open Market Intelligence', 'Where to hunt, what is happening there, and why', {}))
    out.push(beside('open', 'Open Market Intelligence beside', 'Opens beside the current pane', {}))
  }
  return out
}
