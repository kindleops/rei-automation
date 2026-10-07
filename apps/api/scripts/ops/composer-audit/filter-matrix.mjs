#!/usr/bin/env node
/**
 * COMPOSER FILTER MATRIX (2026-10-07) — read-only audit of every catalog field.
 *
 *   node --env-file=.env.local --import ./scripts/ops/composer-audit/register-live.mjs \
 *     scripts/ops/composer-audit/filter-matrix.mjs --out=<csv> [--only=key,key] [--market="Dallas, TX"]
 *
 * Per field: mapping, graph fill vs source fill over the SAME properties (full
 * population, not a sample), value agreement where both sides have a value,
 * the Composer's own count (PostgREST + applyGraphFilter, timed nationally and
 * in one market) vs an independent count from the source table over the graph's
 * properties, and a status. SQL goes through psql with statement_timeout=30s
 * and default_transaction_read_only=on; the URL is read from /tmp/.dburl and
 * never printed. Writes nothing.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { CAMPAIGN_FIELD_CATALOG } from '@/lib/domain/campaigns/campaign-field-catalog.js'
import { applyGraphFilter, graphColumnForField, PROJECTION_PENDING_COLUMNS } from '@/lib/domain/campaigns/campaign-graph-filter-plan.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true] }))
const OUT = args.out || '/tmp/FILTER_MATRIX.csv'
const MARKET = args.market || 'Dallas, TX'
const ONLY = args.only ? new Set(String(args.only).split(',')) : null
const DBURL = readFileSync('/tmp/.dburl', 'utf8').trim()
const PROD_TIMEOUT_MS = 8000

function sql(text) {
  // The URL travels in an env var, never in argv, so no error message can print it.
  try {
    const out = execFileSync('sh', ['-c', 'psql "$AUDIT_DBURL" -X -q -v ON_ERROR_STOP=1 -A -t -F "$(printf \'\\t\')" -P pager=off -f -'], {
      input: text,
      env: { ...process.env, AUDIT_DBURL: DBURL, PGOPTIONS: '-c statement_timeout=30s -c default_transaction_read_only=on' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.split('\n').filter((line) => line.length).map((line) => line.split('\t'))
  } catch (error) {
    throw new Error(`sql failed: ${String(error.stderr || '').trim().slice(0, 200)}`)
  }
}
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`

// graph column -> { join, expr (source value as text-comparable), kind }
const P = (c) => ({ join: 'p', expr: `p.${c}` })
const SRC = {
  property_id: { join: 'p', expr: 'p.property_id', kind: 'text' },
  master_owner_id: { join: 'p', expr: 'p.master_owner_id', kind: 'text' },
  market: { ...P('market'), kind: 'text' },
  state: { ...P('property_address_state'), kind: 'text' },
  property_zip: { join: 'p', expr: 'left(p.property_address_zip, 5)', graphExpr: 'left(g.property_zip, 5)', kind: 'text' },
  property_city: { ...P('property_address_city'), kind: 'text' },
  property_county_name: { ...P('property_address_county_name'), kind: 'text' },
  property_type: { ...P('property_type'), kind: 'text' },
  property_class: { ...P('property_class'), kind: 'text' },
  units_count: { ...P('units_count'), kind: 'num' },
  tax_delinquent: { ...P('tax_delinquent'), kind: 'bool' },
  active_lien: { ...P('active_lien'), kind: 'bool' },
  property_flags_text: { join: 'p', expr: "COALESCE(NULLIF(p.property_flags_text, ''), NULLIF(p.podio_tags, ''))", kind: 'list' },
  building_condition: { ...P('building_condition'), kind: 'text' },
  rehab_level: { join: 'p', expr: "COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, ''))", kind: 'text' },
  owner_type: { ...P('owner_type'), kind: 'text' },
  owner_type_guess: { ...P('owner_type_guess'), kind: 'text' },
  is_corporate_owner: { ...P('is_corporate_owner'), kind: 'bool' },
  out_of_state_owner: { ...P('out_of_state_owner'), kind: 'bool' },
  estimated_value: { ...P('estimated_value'), kind: 'num' },
  equity_amount: { ...P('equity_amount'), kind: 'num' },
  equity_percent: { ...P('equity_percent'), kind: 'num' },
  cash_offer: { ...P('cash_offer'), kind: 'num' },
  acquisition_score: { ...P('final_acquisition_score'), kind: 'num' },
  beds: { ...P('total_bedrooms'), kind: 'num' },
  baths: { ...P('total_baths'), kind: 'num' },
  building_sqft: { ...P('building_square_feet'), kind: 'num' },
  year_built: { ...P('year_built'), kind: 'num' },
  lot_sqft: { ...P('lot_square_feet'), kind: 'num' },
  total_loan_balance: { ...P('total_loan_balance'), kind: 'num' },
  ownership_years: { ...P('ownership_years'), kind: 'num' },
  tax_delinquent_year: { ...P('tax_delinquent_year'), kind: 'num' },
  building_quality: { ...P('building_quality'), kind: 'text' },
  estimated_repair_cost: { ...P('estimated_repair_cost'), kind: 'num' },
  timezone: { ...P('timezone'), kind: 'text' },
  contact_window: { ...P('contact_window'), kind: 'text' },
  aos_score: { join: 'pas', expr: 'pas.aos_score', kind: 'num' },
  decision_tier: { join: 'pas', expr: 'pas.decision_tier', kind: 'text' },
  acquisition_confidence: { join: 'pas', expr: 'pas.confidence', kind: 'num' },
  transaction_probability_365: { join: 'pas', expr: 'pas.transaction_probability_365', kind: 'num' },
  best_strategy: { join: 'pas', expr: 'pas.best_strategy', kind: 'text' },
  priority_tier: { join: 'mo', expr: 'mo.priority_tier', kind: 'text' },
  follow_up_cadence: { join: 'mo', expr: 'mo.follow_up_cadence', kind: 'text' },
  language: { join: 'o', expr: 'o.language_preference', kind: 'text' },
  gender: { join: 'o', expr: 'o.gender', kind: 'text' },
  marital_status: { join: 'o', expr: 'o.marital_status', kind: 'text' },
  education_model: { join: 'o', expr: 'o.education_model', kind: 'text' },
  occupation_group: { join: 'o', expr: 'o.occupation_group', kind: 'text' },
  income: { join: 'o', expr: 'o.est_household_income', kind: 'text' },
  net_asset_value: { join: 'o', expr: 'o.net_asset_value', kind: 'text' },
  buying_power: { join: 'o', expr: 'o.buying_power', kind: 'text' },
  age_bucket: { join: 'o', expr: "CASE WHEN o.month_of_birth ~ '^(19|20)[0-9]{4}$' THEN 'has_mob' END", kind: 'fill_only' },
  matching_flags_text: { join: 'o', expr: "NULLIF(array_to_string(o.person_flags, '; '), '')", kind: 'list' },
  phone_type: { join: 'ph', expr: "CASE WHEN ph.phone_type IN ('W','Wireless','mobile') THEN 'W' WHEN ph.phone_type IN ('L','Landline','landline') THEN 'L' END", kind: 'text' },
  phone_owner: { join: 'ph', expr: 'ph.phone_owner', kind: 'text' },
  phone_activity_status: { join: 'ph', expr: 'ph.activity_status', kind: 'text' },
  usage_12_months: { join: 'ph', expr: 'ph.usage_12_months', kind: 'text' },
  usage_2_months: { join: 'ph', expr: 'ph.usage_2_months', kind: 'text' },
}
const DERIVED = new Set(['sms_eligible', 'email_eligible', 'never_contacted', 'last_outbound_at', 'latest_contact_at', 'touch_count', 'current_touch_number', 'true_post_contact_suppression', 'pending_prior_touch', 'active_queue_item'])
const ROUTING = new Set(['sender_covered', 'routing_tier', 'sender_market'])
const DEMOGRAPHIC = new Set(['language', 'gender', 'marital_status', 'education_model', 'occupation_group', 'income', 'net_asset_value', 'buying_power', 'age_bucket', 'matching_flags_text'])

const JOINS = {
  p: 'LEFT JOIN public.properties p ON p.property_id = g.property_id',
  pas: 'LEFT JOIN (SELECT DISTINCT ON (property_id) * FROM public.property_acquisition_scores ORDER BY property_id, computed_at DESC NULLS LAST) pas ON pas.property_id = g.property_id',
  mo: 'LEFT JOIN public.master_owners mo ON mo.master_owner_id = g.master_owner_id',
  o: 'LEFT JOIN seller.owner o ON o.individual_key = g.seller_person_key',
  ph: "LEFT JOIN (SELECT DISTINCT ON (canonical_e164) * FROM public.phones ORDER BY canonical_e164, best_phone_score DESC NULLS LAST) ph ON ph.canonical_e164 = '+1' || g.canonical_e164",
}

function norm(kind, e) {
  if (kind === 'num') return `round((${e})::numeric, 2)`
  if (kind === 'bool') return `(${e})::boolean`
  if (kind === 'list') return `regexp_replace(lower(btrim((${e})::text)), '[[:space:]]*;[[:space:]]*', ';', 'g')`
  return `lower(btrim((${e})::text))`
}
const nonEmpty = (e) => `NULLIF(btrim((${e})::text), '') IS NOT NULL`

function fillStats(columns) {
  // one statement per join: graph fill, source fill, both, agree, graph-only
  const byJoin = {}
  for (const col of columns) {
    const src = SRC[col]
    if (!src) continue
    ;(byJoin[src.join] ||= []).push(col)
  }
  const stats = {}
  const total = Number(sql('SELECT count(*) FROM public.campaign_target_graph')[0][0])
  // Exact graph fill: one scan of the graph alone.
  const exactCols = columns.filter(Boolean)
  const exactRow = sql(`SELECT ${exactCols.map((c) => `count(*) FILTER (WHERE NULLIF(btrim(g.${c}::text), '') IS NOT NULL)`).join(', ')} FROM public.campaign_target_graph g`)[0]
  const exactFill = Object.fromEntries(exactCols.map((c, i) => [c, Number(exactRow[i])]))
  const chunks = []
  for (const [join, cols] of Object.entries(byJoin)) for (let i = 0; i < cols.length; i += 6) chunks.push([join, cols.slice(i, i + 6)])
  for (const [join, cols] of chunks) {
    const parts = []
    for (const col of cols) {
      const src = SRC[col]
      const g = src.graphExpr || `g.${col}`
      parts.push(
        `count(*) FILTER (WHERE ${nonEmpty(g)})`,
        `count(*) FILTER (WHERE ${nonEmpty(src.expr)})`,
        `count(*) FILTER (WHERE ${nonEmpty(g)} AND ${nonEmpty(src.expr)})`,
        src.kind === 'fill_only' ? '0' : `count(*) FILTER (WHERE ${nonEmpty(g)} AND ${nonEmpty(src.expr)} AND ${norm(src.kind, g)} IS NOT DISTINCT FROM ${norm(src.kind, src.expr)})`,
        `count(*) FILTER (WHERE ${nonEmpty(g)} AND NOT ${nonEmpty(src.expr)})`,
      )
    }
    parts.push('count(*)')
    const started = Date.now()
    let row
    try {
      // A 5% block sample of the graph joined by key: the full join of 176k graph rows
      // to the wide properties heap takes >30 s. Fill % from ~9k rows is ±1 pt.
      ;[row] = sql(`SELECT ${parts.join(', ')} FROM public.campaign_target_graph g TABLESAMPLE SYSTEM (5) REPEATABLE (42) ${JOINS[join]}`)
      if (!row) throw new Error('no row returned')
    } catch (error) {
      process.stderr.write(`fill ${join} ${cols.join(',')}: ${error.message}\n`)
      for (const col of cols) stats[col] = { total, gf: null, sf: null, both: null, agree: null, gOnly: null, kind: SRC[col].kind, error: error.message }
      continue
    }
    process.stderr.write(`fill ${join}: ${cols.join(',')} in ${Date.now() - started} ms\n`)
    cols.forEach((col, i) => {
      const [sgf, ssf, both, agree, gOnly] = row.slice(i * 5, i * 5 + 5).map(Number)
      const n = Number(row[row.length - 1])
      // sample shares scaled to the population; graph fill itself is exact
      stats[col] = { total, gf: exactFill[col], sf: Math.round((ssf / n) * total), sampleGf: Math.round((sgf / n) * total), both, agree, gOnly: Math.round((gOnly / n) * total), kind: SRC[col].kind, sampleN: n }
    })
  }
  for (const col of columns) {
    if (stats[col] || SRC[col]) continue
    stats[col] = { total, gf: exactFill[col], sf: null, both: null, agree: null, gOnly: null, kind: 'derived' }
  }
  return stats
}

function representativeValue(field, col) {
  const src = SRC[col]
  if (field.type === 'boolean') return { operator: 'is_true', value: true }
  if (field.type === 'number') {
    const [row] = sql(`SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY g.${col}) FROM public.campaign_target_graph g WHERE g.${col} IS NOT NULL`)
    return row && row[0] ? { operator: 'gte', value: Number(row[0]) } : null
  }
  if (field.type === 'date') return { operator: 'on_or_after', value: new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10) }
  if (src?.kind === 'list') {
    const rows = sql(`SELECT btrim(t) v, count(*) FROM public.campaign_target_graph g CROSS JOIN LATERAL regexp_split_to_table(g.${col}, ';') t WHERE g.${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 3`)
    return rows.length ? { operator: 'is_any_of', value: [rows[rows.length - 1][0]] } : null
  }
  const rows = sql(`SELECT g.${col}::text, count(*) FROM public.campaign_target_graph g WHERE NULLIF(btrim(g.${col}::text), '') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 2`)
  return rows.length ? { operator: 'is_any_of', value: [rows[rows.length - 1][0]] } : null
}

function independentCount(col, rep) {
  const src = SRC[col]
  if (!src || src.kind === 'fill_only' || !rep) return null
  const e = src.expr
  let where
  if (rep.operator === 'is_true') where = `(${e})::boolean IS TRUE`
  else if (rep.operator === 'gte') where = `(${e})::numeric >= ${Number(rep.value)}`
  else if (src.kind === 'list') where = `(${e}) ~* ${lit(`(^|;)[[:space:]]*${String(rep.value[0]).replace(/[.*+?$|(){}[\]\\^]/g, '\\$&')}[[:space:]]*(;|$)`)}`
  else where = `lower(btrim((${e})::text)) = lower(${lit(rep.value[0])})`
  const [row] = sql(`SELECT count(*) FROM public.campaign_target_graph g ${JOINS[src.join]} WHERE ${where}`)
  return Number(row[0])
}

async function composerCount(supabase, field, col, rep, market = null) {
  let q = supabase.from('campaign_target_graph').select('graph_id', { count: 'exact', head: true }).not('property_id', 'is', null)
  if (market) q = q.eq('market', market)
  q = applyGraphFilter(q, { field_key: field.key, fieldDefinition: field, operator: rep.operator, value: rep.value, graph_column: col })
  const started = Date.now()
  const { count, error } = await q
  return { count: error ? null : count, ms: Date.now() - started, error: error ? error.message || error.code || 'error' : null }
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null)
const csv = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const fields = CAMPAIGN_FIELD_CATALOG.filter((f) => !ONLY || ONLY.has(f.key))
  const facetKeys = new Set(sql('SELECT DISTINCT field_key FROM public.campaign_target_graph_facets').map((r) => r[0]))
  const columns = [...new Set(fields.map((f) => graphColumnForField(f.key)).filter(Boolean))]
  const graphCols = new Set(sql("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='campaign_target_graph'").map((r) => r[0]))
  const stats = fillStats(columns.filter((c) => graphCols.has(c)))
  const header = ['field_key', 'label', 'type', 'operators', 'in_builder', 'graph_column', 'unmapped_handling', 'graph_fill_pct', 'source_fill_pct', 'source_basis', 'fill_mismatch', 'agreement_pct', 'graph_only_rows', 'test_value', 'composer_count_national', 'independent_count', 'counts_agree', 'latency_ms_national', 'composer_count_market', 'latency_ms_market', 'options_source', 'ui_reflection', 'status', 'notes']
  const lines = [header.join(',')]
  for (const field of fields) {
    const col = graphColumnForField(field.key)
    const inBuilder = field.supported_in_preview && !field.retired
    const ops = field.operators.map((o) => o.key).join('|')
    const row = { field_key: field.key, label: field.label, type: field.type, operators: ops, in_builder: inBuilder ? 'yes' : 'no (hidden)' }
    const notes = []
    let status = 'OK'
    if (!col) {
      row.graph_column = ''
      row.unmapped_handling = inBuilder ? 'offered but refused by name (Reach + Build list it)' : (field.retired ? 'retired: hidden; a saved filter is refused by name' : 'hidden from builder (restrictCatalogToSupported); a saved filter is refused by name')
      status = 'UNMAPPED'
      row.ui_reflection = inBuilder ? 'refused with reason (desktop: disabled; mobile: "Can’t narrow — remove")' : 'not offered'
    } else {
      row.graph_column = col
      const s = stats[col]
      if (!s) { status = 'UNMAPPED'; notes.push('graph column missing'); row.unmapped_handling = 'column missing → refused (population probe)' }
      else {
        row.graph_fill_pct = pct(s.gf, s.total)
        if (s.error) notes.push(`source comparison failed: ${s.error.slice(0, 80)}`)
        if (s.sf !== null && s.sf !== undefined) {
          row.source_fill_pct = pct(s.sf, s.total)
          row.source_basis = `${SRC[col].expr.slice(0, 60)} over a 5% block sample of graph rows (n=${s.sampleN})`
          const gap = row.source_fill_pct - pct(s.sampleGf ?? s.gf, s.total)
          row.fill_mismatch = Math.abs(gap) >= 5 ? `${gap > 0 ? 'graph missing' : 'graph extra'} ${Math.abs(Math.round(gap * 10) / 10)} pts` : ''
          row.agreement_pct = s.kind === 'fill_only' ? '' : pct(s.agree, s.both)
          row.graph_only_rows = s.gOnly
          if (row.fill_mismatch && gap > 0) { status = 'STALE'; notes.push('projection incomplete (graph emptier than source)') }
          if (row.agreement_pct !== '' && row.agreement_pct !== null && row.agreement_pct < 97) { status = 'WRONG'; notes.push(`values disagree with source on ${Math.round((100 - row.agreement_pct) * 10) / 10}% of rows with both`) }
          if (s.gOnly > s.total * 0.02 && s.kind !== 'fill_only') { status = 'WRONG'; notes.push(`${s.gOnly} graph values with no source value (wrong source/join)`) }
        } else {
          row.source_basis = DERIVED.has(col) ? 'derived (message_events/send_queue/suppression)' : ROUTING.has(col) ? 'routing (sender coverage) — routing agent' : 'identity'
        }
        if (s.gf <= 1) { status = status === 'OK' ? 'STALE' : status; notes.push('graph column empty: refused as no_audience_data') }
        if (DEMOGRAPHIC.has(col)) notes.push('prospect linkage → demographics agent')
        if (ROUTING.has(col)) notes.push('sender coverage → routing agent')
        if (PROJECTION_PENDING_COLUMNS.has(col)) notes.push('pending-projection column (applies only when the probe sees values)')
      }
      if (s && s.gf > 1) {
        let rep = null
        try { rep = representativeValue(field, col) } catch (e) { notes.push(`rep value failed: ${e.message.slice(0, 80)}`) }
        if (rep) {
          row.test_value = `${rep.operator} ${Array.isArray(rep.value) ? rep.value.join('|') : rep.value}`
          const nat = await composerCount(supabase, field, col, rep)
          const mkt = await composerCount(supabase, field, col, rep, MARKET)
          row.composer_count_national = nat.count ?? `error: ${nat.error}`
          row.latency_ms_national = nat.ms
          row.composer_count_market = mkt.count ?? `error: ${mkt.error}`
          row.latency_ms_market = mkt.ms
          let ind = null
          try { ind = independentCount(col, rep) } catch (e) { notes.push(`independent count failed: ${e.message.slice(0, 80)}`) }
          row.independent_count = ind ?? ''
          if (ind !== null && nat.count !== null) {
            const diff = Math.abs(ind - nat.count)
            row.counts_agree = diff <= Math.max(5, ind * 0.01) ? 'yes' : `no (Δ ${nat.count - ind})`
            if (row.counts_agree !== 'yes' && status === 'OK') status = 'STALE'
          }
          if (nat.error || mkt.error) { status = 'SLOW'; notes.push(`count error: ${nat.error || mkt.error}`) }
          else if (Math.max(nat.ms, mkt.ms) > PROD_TIMEOUT_MS) { status = 'SLOW'; notes.push('count over the 8 s PostgREST timeout') }
        }
      }
      const facetKey = { 'properties.property_address_state': 'properties.property_state', 'properties.property_address_zip': 'properties.property_zip', 'properties.property_address_county_name': 'properties.property_county_name', 'prospects.person_flags_text': 'prospects.matching_flags' }[field.key] || field.key
      row.options_source = field.supports_options ? (facetKeys.has(facetKey) ? 'facet snapshot (has rows)' : 'facet snapshot: NO ROWS → was "No values found"; now not_counted + typed entry') : 'range/boolean input'
      if (field.supports_options && !facetKeys.has(facetKey) && inBuilder && status === 'OK') status = 'STALE'
      row.ui_reflection = row.ui_reflection || 'applied in Reach+Build count; coverage + rows removed in "Why this audience" (da96f5da); same API mobile+desktop'
    }
    row.status = status
    row.notes = notes.join('; ')
    lines.push(header.map((h) => csv(row[h])).join(','))
    process.stderr.write(`${field.key}: ${status}\n`)
  }
  writeFileSync(OUT, `${lines.join('\n')}\n`)
  process.stderr.write(`wrote ${OUT}\n`)
}

main().catch((error) => { console.error(error); process.exit(1) })
