#!/usr/bin/env node
// CORPUS SCREEN — a durable, restartable, read-only screen of EVERY lead in LeadCommand (LeadCommand × agntei,
// docs/LEADCOMMAND-CORPUS-INTELLIGENCE.md). It drives the LeadCommand MCP gateway IN-PROCESS — the same
// authorization, scope, input, masking, output-schema and audit path every MCP client takes — so every page it
// reads is authorized and logged, and nothing here can write, send, queue or approve anything.
//
//   1. leadcommand_get_corpus_census      → census.json   (exact populations, coverage, duplicates, health)
//   2. leadcommand_search_lead_screen     → leads.jsonl   (one screening verdict per lead, keyset-paged)
//   3. lc_lead_screen_v1 (below)          → shortlist.json, summary.json, report.md
//
// DURABLE. state.json holds the last screened property_id (the plain keyset key, not a signed cursor) and the counts; it is rewritten atomically after every page's rows
// are flushed (append + fsync). A run that dies mid-page re-reads that page on restart and the ids already in
// leads.jsonl are skipped: every lead is screened exactly once, however often the job is retried. --fresh
// starts over. The whole corpus is never in memory: a page at a time, bounded by the tool's own limits.
//
//   live (the owner, with the reader credential — the same env as the server; scope leadcommand.pipeline.read):
//     env -i HOME="$HOME" PATH="$PATH" LEADCOMMAND_MCP_DATA=live LEADCOMMAND_MCP_SUPABASE_URL=… \
//       LEADCOMMAND_MCP_READER_JWT_FILE=… LEADCOMMAND_MCP_API_KEY_FILE=… \
//       LEADCOMMAND_MCP_PRINCIPAL_USER_ID=… LEADCOMMAND_MCP_ORG_ID=… LEADCOMMAND_MCP_SCOPES="leadcommand.pipeline.read" \
//       node --import ./src/loader/register.mjs scripts/corpus-screen.mjs --out ~/lc-screen [--market "Tulsa, OK"] [--page 500]
//   fixture (synthetic data, anywhere):
//     node --import ./src/loader/register.mjs scripts/corpus-screen.mjs --fixture --out /tmp/lc-screen
//
// THE SCREEN IS A SCREEN. Its verdict says which leads deserve the EXPENSIVE reads (the conversation, the
// Decision Engine, comps, contact status: scripts/investigate-leads.mjs takes the shortlist's ids). It is
// arithmetic over recorded labels and flags: a label is not seller intent, a flag is not contact eligibility,
// and no protected characteristic or personal vulnerability is a signal — only the lead's own record of
// contact, response, pipeline state, property facts and public distress evidence.
import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from '../src/app.mjs'
import { preflight } from './live-acceptance.mjs'

export const SCREEN_RULE = 'lc_lead_screen_v1'
export const STATE_VERSION = 1
export const CANDIDATE_MIN_SCORE = 25
const FIXTURE_ENV = { LEADCOMMAND_MCP_DATA: 'fixture', LEADCOMMAND_MCP_PRINCIPAL_USER_ID: '00000000-0000-4000-8000-0000000000b1', LEADCOMMAND_MCP_ORG_ID: '00000000-0000-4000-8000-0000000000a1' }
const NEEDED_SCOPES = ['leadcommand.pipeline.read']
const INTEREST = new Set(['interested', 'offer_interest', 'asking_price', 'property_condition', 'offer', 's2', 's3', 's4', 's5'])
const DAY = 86_400_000

/** Every point is an explicit factor with the evidence that earned it (the same discipline as lc_opportunity_rank_v1). */
export const FACTORS = Object.freeze({
  unanswered_seller_message: 40, in_conversation: 15, interest_label: 10, decision_engine_tier_a: 10, decision_engine_tier_b: 6,
  distress_2plus: 10, tax_delinquent: 5, probate: 5, preforeclosure: 8, active_lien: 3, equity_30pct_plus: 8, portfolio_owner: 4,
  sms_eligible_phone: 5, stalled_deal: 6, needs_review_unresolved: 8, reengage_after_180d: 5, signals_never_contacted: 5, no_channel: -15,
})

const age = (at, now) => (at ? (now - Date.parse(at)) / DAY : null)

/**
 * Screen one lead row (leadcommand_search_lead_screen). Deterministic; cites every point.
 * @returns {{ property_id, score, candidate, excluded: string|null, categories: string[], flags: string[], factors: Array<{factor, points, evidence}> }}
 */
export function screenLead(r, now = Date.now()) {
  const f = [], cats = new Set(), flags = new Set()
  const add = (factor, evidence) => { const p = FACTORS[factor]; if (p) f.push({ factor, points: p, evidence }) }
  const t = r.threads || {}, c = r.contact || {}, d = r.distress || {}, e = r.equity || {}, o = r.owner || {}, de = r.decision_engine || {}, cv = r.conversation || {}, p = r.pipeline || {}, lc = r.last_contact || {}
  const stage = String(cv.stage || '').toLowerCase()
  // Exclusions: a seller who stopped us, a wrong number, a suppressed thread. Never a candidate; counted apart.
  const excluded = t.opted_out ? 'opted_out' : t.wrong_number ? 'wrong_number' : t.suppressed ? 'suppressed' : ['opted_out', 'opt_out'].includes(String(c.sms_status || '').toLowerCase()) ? 'sms_status_opted_out' : null
  if (excluded) return { property_id: r.property_id, score: 0, candidate: false, excluded, categories: [], flags: [...flags], factors: [] }
  const lastContactDays = age(lc.at, now), lastInboundDays = age(t.last_inbound_at, now)
  if (t.unanswered) { add('unanswered_seller_message', `thread: inbound ${t.last_inbound_at} after outbound ${t.last_outbound_at ?? 'none'} (verify the words with the conversation read)`); cats.add('unanswered_inbound') }
  else if (t.n > 0 && t.last_inbound_at) add('in_conversation', `thread with inbound, last ${t.last_inbound_at}`)
  if (INTEREST.has(stage) || (p.stage && INTEREST.has(String(p.stage).toLowerCase()))) {
    add('interest_label', `label ${cv.stage ?? p.stage} (a label, not seller words)`)
    if (lastContactDays != null && lastContactDays > 30 && !t.unanswered) cats.add('interest_no_recent_followup')
  }
  if (de.present && /^a$/i.test(de.tier || '')) add('decision_engine_tier_a', `Decision Engine tier A, computed ${de.computed_at}`)
  else if (de.present && /^b$/i.test(de.tier || '')) add('decision_engine_tier_b', `Decision Engine tier B, computed ${de.computed_at}`)
  if (!de.present) flags.add('decision_engine_missing')
  else if (age(de.computed_at, now) > 30) flags.add('decision_engine_stale')
  if ((d.signal_count ?? 0) >= 2) add('distress_2plus', `${d.signal_count} recorded distress signals`)
  if (d.tax_delinquent) add('tax_delinquent', 'tax delinquency recorded')
  if (d.probate) add('probate', 'probate record')
  if (d.preforeclosure) add('preforeclosure', 'pre-foreclosure record')
  if (d.active_lien) add('active_lien', 'active lien recorded')
  if ((e.known_pct ?? -1) >= 30) add('equity_30pct_plus', `known equity ${e.known_pct}%`)
  else if (e.known_pct == null) flags.add('equity_unknown')
  if ((o.property_count ?? 0) >= 2) { add('portfolio_owner', `owner holds ${o.property_count} properties`); cats.add('portfolio_owner') }
  if (c.sms_eligible_phones > 0) add('sms_eligible_phone', `${c.sms_eligible_phones} SMS-eligible phone(s) on record`)
  else if ((c.phones_on_graph ?? 0) === 0 && (c.candidate_phones ?? 0) === 0 && t.n === 0) { add('no_channel', 'no phone on record and no thread'); cats.add('no_channel') }
  else if (c.sms_eligible_phones === 0) { flags.add('no_sms_channel'); cats.add('no_sms_channel_other_possible') }
  if (p.deal_linked && (lastContactDays == null || lastContactDays > 60) && !t.unanswered) { add('stalled_deal', `deal linked, last contact ${lc.at ?? 'never'}`); cats.add('stalled_opportunity') }
  if (String(cv.status || '').toLowerCase() === 'needs_review' && (lastContactDays == null || lastContactDays > 14)) { add('needs_review_unresolved', `needs_review since last contact ${lc.at ?? 'never'}`); cats.add('needs_review_unresolved') }
  if (t.n > 0 && lastInboundDays != null && lastInboundDays > 180 && !t.unanswered) { add('reengage_after_180d', `last seller message ${t.last_inbound_at}`); cats.add('stale_conversation') }
  if ((d.signal_count ?? 0) > 0 && !lc.at && t.n === 0) { add('signals_never_contacted', `${d.signal_count} signal(s), never contacted`); cats.add('signals_never_contacted') }
  if (r.estimated_value == null) flags.add('data_gap_estimated_value')
  if (p.stage && !cv.stage) flags.add('label_inconsistent_pipeline_without_conversation')
  if (lastContactDays != null && lastContactDays > 365 && t.n === 0 && (d.signal_count ?? 0) > 0) cats.add('abandoned_with_signals')
  const score = f.reduce((s, x) => s + x.points, 0)
  const candidate = score >= CANDIDATE_MIN_SCORE
  if (candidate && (d.signal_count ?? 0) >= 2 && (e.known_pct ?? -1) >= 30 && (lastContactDays == null || lastContactDays > 90)) cats.add('distress_equity_uncontacted')
  return { property_id: r.property_id, score, candidate, excluded: null, categories: [...cats].sort(), flags: [...flags].sort(), factors: f }
}

// ------------------------------------------------------------------------------------------ durable state
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return dflt } }
function writeAtomic(p, text) {
  const tmp = `${p}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try { fs.writeSync(fd, text); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, p)
}
function appendLines(p, lines) {
  if (!lines.length) return
  const fd = fs.openSync(p, 'a', 0o600)
  try { fs.writeSync(fd, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
/** What leads.jsonl already holds: the ids (never screened twice) and the truthful counters (state.json is a cursor, the log is the record). */
function seenIds(p) {
  const s = new Set(); let candidates = 0, excluded = 0
  if (!fs.existsSync(p)) return { ids: s, candidates, excluded }
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue
    try { const l = JSON.parse(line); if (s.has(l.property_id)) continue; s.add(l.property_id); if (l.candidate) candidates += 1; if (l.excluded) excluded += 1 } catch { /* a torn last line: re-screened on this run */ }
  }
  return { ids: s, candidates, excluded }
}

/**
 * Run (or resume) the screen. `opts`: { outDir, fixture, env?, market?, state?, page?, maxPages?, fresh?, shortlist?, log? }.
 * Returns the final state. Safe to call again on the same outDir: it resumes where it stopped.
 */
export async function runScreen(opts) {
  const { outDir, fixture = false, market = null, state: stateFilter = null, page = 200, maxPages = Infinity, fresh = false, shortlist = 200, log = () => {} } = opts
  if (!outDir) throw new Error('give --out <directory>')
  let env
  if (opts.env) env = opts.env
  else if (fixture) env = { ...FIXTURE_ENV, LEADCOMMAND_MCP_SCOPES: NEEDED_SCOPES.join(' ') }
  else {
    preflight(process.env) // refuses ambient writable credentials, non-reader tokens, bad files
    const granted = String(process.env.LEADCOMMAND_MCP_SCOPES || '').split(/\s+/)
    const missing = NEEDED_SCOPES.filter((s) => !granted.includes(s))
    if (missing.length) throw new Error(`LEADCOMMAND_MCP_SCOPES must include: ${missing.join(' ')}`)
    env = process.env
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  if (!env.LEADCOMMAND_MCP_AUDIT_FILE) env = { ...env, LEADCOMMAND_MCP_AUDIT_FILE: path.join(path.resolve(outDir), 'audit.jsonl') }
  const files = { state: path.join(outDir, 'state.json'), leads: path.join(outDir, 'leads.jsonl'), census: path.join(outDir, 'census.json'), summary: path.join(outDir, 'summary.json'), shortlist: path.join(outDir, 'shortlist.json'), report: path.join(outDir, 'report.md') }
  if (fresh) for (const f of Object.values(files)) fs.rmSync(f, { force: true })
  let st = readJson(files.state, null)
  const filters = { market, state: stateFilter }
  if (st && (st.version !== STATE_VERSION || st.rule !== SCREEN_RULE || JSON.stringify(st.filters) !== JSON.stringify(filters))) {
    throw new Error(`state.json in ${outDir} belongs to another run (rule ${st.rule}, filters ${JSON.stringify(st.filters)}); use --fresh or another --out`)
  }
  if (!st) st = { version: STATE_VERSION, rule: SCREEN_RULE, mode: fixture ? 'fixture' : 'live', filters, started_at: new Date().toISOString(), updated_at: null, last_property_id: null, pages: 0, leads: 0, candidates: 0, excluded: 0, finished: false, finished_at: null, census_correlation_id: null, last_correlation_id: null, runs: 0 }
  st.runs += 1
  const record = seenIds(files.leads)
  const seen = record.ids
  st.leads = seen.size; st.candidates = record.candidates; st.excluded = record.excluded // the log is the record; a counter lost with a crash is recovered from it
  const app = await buildApp({ env })
  const call = async (name, args) => {
    const r = await app.gateway.call(name, args)
    if (!r.ok) throw new Error(`${name}: ${r.structured?.error?.class}/${r.structured?.error?.code} — ${r.structured?.error?.message ?? ''}`.trim())
    return r.structured
  }
  try {
    if (!fs.existsSync(files.census)) {
      const c = await call('leadcommand_get_corpus_census', market ? { market } : {})
      writeAtomic(files.census, JSON.stringify({ correlation_id: c.correlation_id, generated_at: c.generated_at, data_mode: c.data_mode, ...c.result }, null, 1))
      st.census_correlation_id = c.correlation_id
      log(`census: ${c.result.coverage.leads} leads (correlation ${c.correlation_id})`)
    }
    let pagesThisRun = 0
    while (!st.finished && pagesThisRun < maxPages) {
      // Resume by the plain key (after_property_id), never by a signed cursor: a cursor is bound to the server process that minted it; a restart is a new process.
      const args = { limit: page, ...(market ? { market } : {}), ...(stateFilter ? { state: stateFilter } : {}), ...(st.last_property_id ? { after_property_id: st.last_property_id } : {}) }
      const r = await call('leadcommand_search_lead_screen', args)
      const now = Date.parse(r.generated_at) || Date.now()
      const lines = []
      for (const row of r.result.rows) {
        if (seen.has(row.property_id)) continue // a page re-read after an interrupted run: screened once, never twice
        const v = screenLead(row, now)
        lines.push({ ...v, market: row.market, state: row.state, page: st.pages + 1, correlation_id: r.correlation_id })
        seen.add(row.property_id)
      }
      appendLines(files.leads, lines) // rows first (fsync) …
      st.pages += 1; pagesThisRun += 1
      st.leads += lines.length; st.candidates += lines.filter((l) => l.candidate).length; st.excluded += lines.filter((l) => l.excluded).length
      if (r.result.rows.length) st.last_property_id = r.result.rows[r.result.rows.length - 1].property_id
      st.last_correlation_id = r.correlation_id; st.updated_at = new Date().toISOString()
      if (!r.page.has_more) { st.finished = true; st.finished_at = st.updated_at }
      writeAtomic(files.state, JSON.stringify(st, null, 1)) // … then the cursor: a crash between the two re-reads the page, and the ids are skipped
      log(`page ${st.pages}: ${r.result.rows.length} rows, ${lines.length} new, ${st.leads} screened${st.finished ? ' — done' : ''}`)
    }
    if (st.finished) {
      const summary = summarize(files, st, shortlist)
      writeAtomic(files.summary, JSON.stringify(summary, null, 1))
      writeAtomic(files.shortlist, JSON.stringify(summary.shortlist, null, 1))
      writeAtomic(files.report, reportMarkdown(summary, readJson(files.census, null), st))
      log(`finished: ${st.leads} leads, ${st.candidates} candidates, ${st.excluded} excluded; shortlist ${summary.shortlist.length}`)
    }
  } finally { await app.close() }
  return st
}

/** Aggregate leads.jsonl (one pass, streaming-friendly) into counts by market / category / flag and the shortlist. */
export function summarize(files, st, shortlistN = 200) {
  const byMarket = {}, categories = {}, flags = {}, excluded = {}
  const top = [] // bounded: the best shortlistN only
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1 }
  const seenHere = new Set(); let leads = 0, candidates = 0, excludedN = 0
  for (const line of fs.readFileSync(files.leads, 'utf8').split('\n')) {
    if (!line) continue
    const l = JSON.parse(line)
    if (seenHere.has(l.property_id)) continue
    seenHere.add(l.property_id); leads += 1; if (l.candidate) candidates += 1; if (l.excluded) excludedN += 1
    const m = (byMarket[l.market ?? '(none)'] ||= { leads: 0, candidates: 0, excluded: 0 })
    m.leads += 1; if (l.candidate) m.candidates += 1; if (l.excluded) { m.excluded += 1; bump(excluded, l.excluded) }
    for (const c of l.categories) bump(categories, c)
    for (const f of l.flags) bump(flags, f)
    if (l.candidate) {
      top.push({ property_id: l.property_id, market: l.market, score: l.score, categories: l.categories, flags: l.flags, factors: l.factors, correlation_id: l.correlation_id })
      if (top.length > shortlistN * 2) { top.sort((a, b) => b.score - a.score || (a.property_id < b.property_id ? -1 : 1)); top.length = shortlistN }
    }
  }
  top.sort((a, b) => b.score - a.score || (a.property_id < b.property_id ? -1 : 1))
  return { rule: SCREEN_RULE, factors: FACTORS, candidate_min_score: CANDIDATE_MIN_SCORE, totals: { leads, candidates, excluded: excludedN, pages: st.pages }, by_market: byMarket, categories, flags, excluded, shortlist: top.slice(0, shortlistN) }
}

const n = (v) => (v == null ? 'n/a' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v))
export function reportMarkdown(summary, census, st) {
  const L = []
  L.push(`# LeadCommand corpus screen — ${st.mode === 'fixture' ? 'FIXTURE (synthetic)' : 'live (lc_mcp_reader)'}`)
  L.push('', `Rule ${summary.rule}; started ${st.started_at}, finished ${st.finished_at}; ${st.pages} pages, ${st.runs} run(s). Read-only: no message was sent, queued or approved; no record was changed.`)
  if (census) {
    const s = census.sources || {}, c = census.coverage || {}
    L.push('', '## Corpus (exact counts)', '', '| Source | Rows |', '|---|---|')
    for (const [k, v] of Object.entries(s)) L.push(`| ${k} | ${v == null ? 'not in this database' : typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${n(b)}`).join(', ') : n(v)} |`)
    L.push('', `Lead key: ${census.lead_key}. Of ${n(c.leads)} leads: ${n(c.with_phone_on_graph)} have a phone on record (${n(c.with_sms_eligible_phone)} SMS-eligible), ${n(c.in_campaign_targets)} are in a campaign target list, ${n(c.with_thread)} have a thread, ${n(c.with_inbound)} ever replied, ${n(c.with_decision_engine)} have a Decision Engine result (${n(c.with_fresh_decision_engine)} within 30 days), ${n(c.conversation_stage_set)} carry a conversation stage, ${n(c.deal_linked)} are linked to a deal, ${n(c.last_contact_set)} were ever contacted (${n(c.contacted_90d)} in the last 90 days).`)
    L.push('', '### Evidence, duplicates, contact state, pipeline health', '')
    for (const [title, key] of [['Evidence', 'evidence'], ['Duplicate identities', 'duplicates'], ['Contact state (recorded flags)', 'contact'], ['Pipeline health', 'pipeline_health'], ['Decision Engine over leads in conversation', 'decision_engine']]) {
      L.push(`**${title}:** ` + Object.entries(census[key] || {}).map(([k, v]) => `${k} ${typeof v === 'object' && v ? Object.entries(v).map(([a, b]) => `${a} ${n(b)}`).join('/') : n(v)}`).join(' · '))
    }
    if (census.columns_absent?.length) L.push('', `Columns this database does not have (their counts are 0 by absence, not by fact): ${census.columns_absent.join(', ')}.`)
  }
  L.push('', '## Screen', '', `| | |`, `|---|---|`, `| Leads screened | ${n(summary.totals.leads)} |`, `| Candidates (score ≥ ${summary.candidate_min_score}) | ${n(summary.totals.candidates)} |`, `| Excluded (opted out, wrong number, suppressed) | ${n(summary.totals.excluded)} |`)
  L.push('', '**By market:**', '', '| Market | Leads | Candidates | Excluded |', '|---|---|---|---|')
  for (const [m, v] of Object.entries(summary.by_market).sort((a, b) => b[1].candidates - a[1].candidates)) L.push(`| ${m} | ${n(v.leads)} | ${n(v.candidates)} | ${n(v.excluded)} |`)
  L.push('', '**Categories (a lead may be in several):** ' + (Object.entries(summary.categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${n(v)}`).join(' · ') || 'none'))
  L.push('', '**Flags:** ' + (Object.entries(summary.flags).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${n(v)}`).join(' · ') || 'none'))
  L.push('', '**Exclusions:** ' + (Object.entries(summary.excluded).map(([k, v]) => `${k} ${n(v)}`).join(' · ') || 'none'))
  L.push('', `## Shortlist (top ${summary.shortlist.length}) — for the expensive reads, not for contact`, '', 'Each line cites the recorded facts that earned its points. The next step for every one is scripts/investigate-leads.mjs (the conversation, the Decision Engine, comps, contact status), then a human decision.', '', '| # | Lead | Market | Score | Categories | Why |', '|---|---|---|---|---|---|')
  summary.shortlist.forEach((s, i) => L.push(`| ${i + 1} | ${s.property_id} | ${s.market ?? ''} | ${s.score} | ${s.categories.join(', ') || '—'} | ${s.factors.map((f) => `${f.factor} +${f.points}`).join(', ')} |`))
  L.push('', '## Rule', '', `${summary.rule}: ` + Object.entries(summary.factors).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ') + `. Candidate at ≥ ${summary.candidate_min_score}. Opted-out, wrong-number and suppressed threads are excluded before scoring. Labels are labels; seller intent needs seller words; contact eligibility is the send-time guard's.`)
  return L.join('\n') + '\n'
}

async function main(argv) {
  const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const st = await runScreen({
    outDir: opt('--out'), fixture: argv.includes('--fixture'), market: opt('--market'), state: opt('--state'),
    page: Number(opt('--page', 200)), maxPages: opt('--max-pages') ? Number(opt('--max-pages')) : Infinity, fresh: argv.includes('--fresh'), shortlist: Number(opt('--shortlist', 200)),
    log: (m) => console.error(`corpus-screen: ${m}`),
  })
  console.log(JSON.stringify(st, null, 1))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { console.error(`corpus-screen: ${e.message}`); process.exit(1) })
}
