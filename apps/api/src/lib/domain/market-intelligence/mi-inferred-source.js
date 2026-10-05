/**
 * MARKET INTELLIGENCE: reading the INFERRED-INVESTOR extension of the market summary
 * (PROPOSED_20261005140000_market_intel_inferred_investor.sql). Rules: mi-inferred-investor.js.
 *
 * Exposed ONLY when both hold:
 *   1. the schema has every inferred column (catalog check that never selects a possibly
 *      missing column, same as the core summary guard), and
 *   2. the ready build carries notes.inferred_investor (written by the build's i:validate
 *      unit; a build made before the extension, or whose inferred chain failed, has none).
 * Otherwise every inferred metric is 'unavailable' with the reason, and nothing else changes:
 * the core summary never depends on these tables.
 *
 * Reads: one (level, period, asset) slice per request (cached like the core slices), the stack
 * table and the stack activity once per build.
 */
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js'
import { lenderClass } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { ASSET_CODE } from './mi-asset-classes.js'
import { TIERS, emptyMatrix, validationStats, inferredInvestorLabel, LINK_RULE, TIER_RULE } from './mi-inferred-investor.js'

const VAL_COLS = TIERS.flatMap((t) => [`v_${t}_known`, `v_${t}_inv`])
export const INFERRED_COLUMNS = Object.freeze({
  mi_geo_period_inferred: ['build_id', 'geo_level', 'geo_key', 'period', 'asset', 'sale_count', 'linked_count', 'strong_n', 'likely_n', 'trust_n', 'absentee_n', 'no_signal_n', 'stack3_n', ...VAL_COLS],
  mi_owner_stack: ['build_id', 'stack_id', 'props_n', 'corp_n', 'oos_n', 'trust_n', 'linked_n', 'named_n', 'label', 'label_n'],
  mi_owner_stack_activity: ['build_id', 'comp_id', 'stack_id', 'sold_on', 'zip', 'state', 'city_key', 'asset'],
})

const SLICE_COLS = INFERRED_COLUMNS.mi_geo_period_inferred.filter((c) => !['build_id', 'geo_level', 'period', 'asset'].includes(c)).join(', ')
export const INFERRED_SQL = Object.freeze({
  slice: `select ${SLICE_COLS} from public.mi_geo_period_inferred where build_id = $1 and geo_level = $2 and period = $3 and asset = $4`,
  stacks: `select stack_id, props_n, corp_n, oos_n, trust_n, linked_n, named_n, label, label_n from public.mi_owner_stack where build_id = $1`,
  activity: `select stack_id, (sold_on - date '2000-01-01')::int as d, zip, state, city_key, asset from public.mi_owner_stack_activity where build_id = $1`,
})

/** Pure: which inferred columns are missing from catalog rows ({t, c}). */
export function missingInferredColumns(rows) {
  const have = new Set((rows || []).map((r) => `${r.t}.${r.c}`))
  const missing = []
  for (const [t, cols] of Object.entries(INFERRED_COLUMNS)) for (const c of cols) if (!have.has(`${t}.${c}`)) missing.push(`${t}.${c}`)
  return missing
}

/** Public bodies (down-payment / housing agencies, governments) appear as recorded co-buyers; never a portfolio owner. */
const PUBLIC_BODY = /\b(agency|authority|housing finance|department|county of|city of|state of|commission|idaho housing|tribe|tribal|nation)\b/i
const int = (v) => (v === null || v === undefined ? 0 : Number(v) || 0)

/** Pure: the build's published inferred meta (from notes.inferred_investor), or null. */
export function inferredMetaOf(build) {
  const n = build?.notes?.inferred_investor
  if (!n || typeof n !== 'object' || !n.matrix) return null
  const matrix = emptyMatrix()
  for (const t of TIERS) {
    matrix[t].recorded_investor = int(n.matrix[t]?.recorded_investor)
    matrix[t].recorded_other = int(n.matrix[t]?.recorded_other)
  }
  return {
    link_rule: n.link_rule || LINK_RULE.id, tier_rule: n.tier_rule || TIER_RULE.id,
    sales: int(n.sales), linked: int(n.linked), tiers: n.tiers || {}, stacks: int(n.stacks),
    matrix, validation: validationStats(matrix),
  }
}

/** Pure: a mi_geo_period_inferred row (or undefined) → the inferred aggregate for one geography. */
export function inferredAggFromRow(r, meta) {
  const matrix = emptyMatrix()
  for (const t of TIERS) {
    const known = int(r?.[`v_${t}_known`])
    const inv = int(r?.[`v_${t}_inv`])
    matrix[t].recorded_investor = inv
    matrix[t].recorded_other = known - inv
  }
  return {
    sales: int(r?.sale_count), linked: int(r?.linked_count),
    tiers: { strong: int(r?.strong_n), likely: int(r?.likely_n), trust_estate: int(r?.trust_n), absentee_only: int(r?.absentee_n), no_signal: int(r?.no_signal_n) },
    stack3: int(r?.stack3_n),
    local: validationStats(matrix),
    validation: meta?.validation ?? null,
  }
}

/**
 * Pure: the public label of a stack. Company names only (Buyer Match privacy): the stack's most
 * frequent RECORDED company buyer, when it names at least 2 of the stack's linked purchases and
 * at least half of the named ones, is displayable as a company and is not a lender. Otherwise
 * the stack stays unnamed. A person is never named.
 */
export function stackIdentity(s) {
  const labelN = int(s?.label_n)
  const namedN = int(s?.named_n)
  const raw = s?.label ? String(s.label) : null
  const ok = raw && labelN >= 2 && namedN > 0 && labelN / namedN >= 0.5 && !lenderClass(raw) && !PUBLIC_BODY.test(raw)
  const name = ok ? displayableCompanyName(raw) : null
  return { name, label: name || 'Unnamed owner portfolio', named: Boolean(name), evidence: name ? `${labelN} of ${namedN} recorded purchases in this stack name it` : null }
}

/**
 * Load the inferred extension for a ready build, or return null (not installed / not built).
 * `geoOf[level](row)` maps an activity row ({state, cityKey, zip}) to a geography id.
 */
export async function loadInferred({ loader, build }) {
  if (typeof loader?.inferredSchema !== 'function' || typeof loader?.inferred !== 'function') return null
  const missing = await loader.inferredSchema()
  if (missing.length) return { available: false, reason: 'not_installed', meta: null }
  const meta = inferredMetaOf(build)
  if (!meta) return { available: false, reason: build?.notes?.inferred_errors ? 'build_failed' : 'not_built', errors: build?.notes?.inferred_errors ?? null, meta: null }
  const id = build.build_id
  const [stackRows, activityRows] = [await loader.inferred('stacks', [id]), await loader.inferred('activity', [id], 20_000)]
  const stacks = new Map(stackRows.map((s) => [Number(s.stack_id), { props: int(s.props_n), corp: int(s.corp_n), oos: int(s.oos_n), trust: int(s.trust_n), linked: int(s.linked_n), ...stackIdentity(s) }]))
  const activity = activityRows.map((r) => ({ stack: Number(r.stack_id), day: Number(r.d), zip: r.zip, state: r.state, cityKey: r.city_key, asset: ASSET_CODE[r.asset] ?? 0 }))
  const slices = new Map()
  return {
    available: true, meta, stacks, activity,
    slice(level, period, asset) {
      const k = `${level}|${period}|${asset}`
      if (!slices.has(k)) {
        slices.set(k, loader.inferred('slice', [id, level, period, asset]).then((rows) => new Map(rows.map((r) => [r.geo_key, r]))))
        while (slices.size > 160) slices.delete(slices.keys().next().value)
      }
      return slices.get(k)
    },
  }
}

/** Pure: top owner-portfolio stacks for one geography and window. Companies named only. */
export function topStacks(inf, geoId, ctx, geoOf, limit = 10) {
  if (!inf?.available) return null
  const by = new Map()
  for (const a of inf.activity) {
    if (a.day < ctx.window.from || a.day > ctx.window.to) continue
    if (ctx.asset?.codes && !ctx.asset.codes.has(a.asset)) continue
    if (geoOf(a) !== geoId) continue
    const e = by.get(a.stack) || { n: 0, last: 0 }
    e.n += 1
    if (a.day > e.last) e.last = a.day
    by.set(a.stack, e)
  }
  const rows = []
  for (const [id, e] of by) {
    const s = inf.stacks.get(id)
    if (!s) continue
    rows.push({ stack: `stack:${id}`, label: s.label, named: s.named, name_evidence: s.evidence, linked_purchases: e.n, last_purchase_day: e.last,
      properties_at_mailing_address: s.props, entity_share: s.props ? s.corp / s.props : null, out_of_state_share: s.props ? s.oos / s.props : null })
  }
  rows.sort((x, y) => (y.linked_purchases - x.linked_purchases) || (y.properties_at_mailing_address - x.properties_at_mailing_address) || x.stack.localeCompare(y.stack))
  return rows.slice(0, limit)
}

/** Pure: the label line for a geography's inferred share. */
export function inferredLabelFor(agg) {
  const v = agg?.validation
  const share = agg?.linked ? (agg.tiers.strong + agg.tiers.likely) / agg.linked : null
  return inferredInvestorLabel({ share, linked: agg?.linked || 0, precision: v?.precision, validationN: v?.n || 0 })
}
