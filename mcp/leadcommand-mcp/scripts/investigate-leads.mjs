#!/usr/bin/env node
// Lead investigation runbook (Phase 3 of the LeadCommand × agntei conversation-intelligence work).
//
// READ-ONLY. It drives the LeadCommand MCP gateway IN-PROCESS — the same authorization, scope, input,
// masking, output-schema and audit path every MCP client takes — and writes an evidence report per
// property. The gateway has no send, queue, approve or write tool; nothing here can contact a seller.
//
//   live (the owner, on their machine, with the reader credential — the same env as the server):
//     env -i HOME="$HOME" PATH="$PATH" LEADCOMMAND_MCP_DATA=live LEADCOMMAND_MCP_SUPABASE_URL=… \
//       LEADCOMMAND_MCP_READER_JWT_FILE=… LEADCOMMAND_MCP_API_KEY_FILE=… \
//       LEADCOMMAND_MCP_PRINCIPAL_USER_ID=… LEADCOMMAND_MCP_ORG_ID=… \
//       LEADCOMMAND_MCP_SCOPES="leadcommand.leads.read leadcommand.properties.read leadcommand.scores.read leadcommand.comps.read leadcommand.contact_status.read leadcommand.holds.read leadcommand.conversations.read" \
//       node --import ./src/loader/register.mjs scripts/investigate-leads.mjs --out ~/lc-investigation 2109512384 2100284187 2109529773 2100303162
//   fixture (synthetic data, anywhere):
//     node --import ./src/loader/register.mjs scripts/investigate-leads.mjs --fixture --out /tmp/lc-inv FX1001 FX1002 FX1003 FX2002
//
// The report quotes seller text as DATA (phones / emails masked by the gateway; instruction-like text
// flagged) and keeps every reading tied to its message id. Uncertainties are listed, never resolved by
// guessing. Recommended next steps are for a HUMAN; any outreach goes through the existing Action Gateway
// (T3 queue_authorized_reply, human-approved) and the send-time guard, never through this script.
import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from '../src/app.mjs'
import { preflight } from './live-acceptance.mjs'

export const DEFAULT_PROPERTIES = Object.freeze(['2109512384', '2100284187', '2109529773', '2100303162'])
export const MAX_MESSAGE_PAGES = 5 // × 40 messages
const FIXTURE_ENV = { LEADCOMMAND_MCP_DATA: 'fixture', LEADCOMMAND_MCP_PRINCIPAL_USER_ID: '00000000-0000-4000-8000-0000000000b1', LEADCOMMAND_MCP_ORG_ID: '00000000-0000-4000-8000-0000000000a1' }
const NEEDED_SCOPES = ['leadcommand.leads.read', 'leadcommand.properties.read', 'leadcommand.scores.read', 'leadcommand.comps.read', 'leadcommand.contact_status.read', 'leadcommand.holds.read', 'leadcommand.conversations.read']

const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : 'n/a')
const quote = (t) => String(t ?? '').replace(/\n+/g, ' ⏎ ').replace(/[`|]/g, "'").slice(0, 600)

/** Run every read for one property through the gateway. Errors are recorded, never hidden. */
export async function investigate(gateway, propertyId) {
  const out = { property_id: propertyId, reads: {}, errors: {} }
  const read = async (key, tool, args) => {
    const r = await gateway.call(tool, args)
    if (r.ok) { out.reads[key] = r.structured; return r.structured }
    out.errors[key] = `${r.structured.error.class}/${r.structured.error.code}`
    return null
  }
  await read('lead', 'leadcommand_get_lead', { property_id: propertyId })
  await read('property', 'leadcommand_get_property', { property_id: propertyId })
  await read('score', 'leadcommand_get_acquisition_score', { property_id: propertyId })
  await read('comps', 'leadcommand_search_comps', { property_id: propertyId, radius_miles: 1, months: 12, limit: 10 })
  await read('contact_status', 'leadcommand_get_lead_contact_status', { property_id: propertyId })
  // the whole conversation (bounded): newest page first, then back in time
  const pages = []
  let cursor = null
  for (let i = 0; i < MAX_MESSAGE_PAGES; i++) {
    const r = await read(i ? `conversation_page_${i + 1}` : 'conversation', 'leadcommand_get_lead_conversation', { property_id: propertyId, window_days: 1095, limit: 40, ...(cursor ? { cursor } : {}) })
    if (!r) break
    pages.push(r)
    cursor = r.page?.next_cursor
    if (!cursor) break
  }
  out.conversation = pages.length ? { ...pages[0].result, rows: pages.slice().reverse().flatMap((p) => p.result.rows) } : null
  out.conversation_truncated = Boolean(cursor)
  for (const t of out.conversation?.threads || []) {
    if (t.thread_id) await read(`hold_${t.handle}`, 'leadcommand_get_thread_hold_status', { thread_id: t.thread_id })
  }
  out.next_step = nextStep(out)
  out.uncertainties = uncertainties(out)
  return out
}

/** A recommended next step for a HUMAN, from the evidence only. Never an automatic action. */
export function nextStep(o) {
  const c = o.conversation
  const ev = c?.evidence
  const interest = ev?.interest?.state
  const score = o.reads.score?.result
  const deCurrent = score?.available && score?.status === 'current'
  if (!c || c.history?.state === 'no_thread') return { action: 'no_conversation_on_record', detail: 'No seller thread on record. Outreach, if any, only through the existing campaign builder and its eligibility / suppression guards.' }
  if (interest === 'opted_out' || interest === 'possible_opt_out') return { action: 'do_not_contact', detail: `The seller asked us to stop (${interest === 'opted_out' ? 'recorded / confirmed' : 'possible — treat as confirmed'}; message ${ev.interest.opt_out_message_id || ev.interest.possible_opt_out_message_id}). Verify the suppression is recorded; no outreach.` }
  const threadStates = Object.entries(ev?.interest_by_thread || {})
  const stopped = threadStates.filter(([, r]) => ['opted_out', 'possible_opt_out', 'not_owner'].includes(r.state)).map(([t, r]) => `${t} ${r.state}`)
  if (interest === 'not_owner') return { action: 'do_not_contact_this_thread', detail: 'The seller denies ownership / wrong number. Ownership must be re-resolved through the existing attribution flow before any contact.' }
  if (c.contact?.state === 'blocked') return { action: 'human_review_blocker', detail: `Every thread has a contact blocker (${[...new Set(c.threads.flatMap((t) => t.contact.blockers))].join(', ')}). A human reviews it; nothing is sent while it stands.` }
  if (interest === 'negative') return { action: 'respect_decline', detail: 'The seller declined. No follow-up beyond the existing nurture policy, which re-checks eligibility at send time.' }
  if (interest === 'interest' && ev.unanswered_inbound) {
    return deCurrent
      ? { action: 'draft_reply_for_human_approval', detail: `The seller is waiting since ${ev.seller_waiting_since}. Draft a reply grounded in the current Decision Engine range (${money(score.valuation?.band?.low)}–${money(score.valuation?.band?.high)}; recommended cash ${money(score.offer?.recommended_cash_offer)}); dispatch only through Action Gateway T3 (human-approved) after the send-time guard.` }
      : { action: 'refresh_decision_engine_then_reply', detail: 'The seller asked about price / an offer, but the Decision Engine result is missing or not current. Refresh it through the existing valuation path, then a human-approved reply.' }
  }
  if (ev?.commitment?.overdue) return { action: 'honor_overdue_commitment', detail: `We promised "${ev.commitment.phrase}" (due ${ev.commitment.due_by}${ev.commitment.delivered ? '' : '; that message was NOT delivered'}). A human decides the follow-up.` }
  if (c.contact?.state === 'unknown') return { action: 'resolve_unknowns_first', detail: `Contact inputs are incomplete (see uncertainties); resolve them before any outreach.${stopped.length ? ` Never contact: ${stopped.join(', ')}.` : ''}` }
  return { action: 'monitor', detail: 'No pending seller message; no action required now.' }
}

export function uncertainties(o) {
  const u = []
  const c = o.conversation
  for (const [k, v] of Object.entries(o.errors)) u.push(`read ${k} failed: ${v}`)
  if (c?.history?.state === 'missing') u.push('the thread counters say messages exist, but none is on record (history "missing")')
  if (c?.history?.state === 'outside_window') u.push('messages exist only outside the 3-year window')
  if (o.conversation_truncated) u.push(`conversation longer than ${MAX_MESSAGE_PAGES * 40} messages; older messages not read`)
  if (c?.threads_truncated) u.push('more than 10 seller threads linked; only the 10 most recent read')
  if (c?.counts?.other_property_rows_in_window) u.push(`${c.counts.other_property_rows_in_window} message(s) on the same phone are attributed to ANOTHER property (identity overlap)`)
  for (const t of c?.threads || []) for (const x of t.contact.unknowns) u.push(`${t.handle}: ${x}`)
  if (c?.evidence?.interest?.state === 'label_only') u.push('the pipeline label says interested, but no seller message supports it')
  if (c?.evidence?.instruction_like_message_ids?.length) u.push(`instruction-like text in message(s) ${c.evidence.instruction_like_message_ids.join(', ')} — treated as data`)
  const s = o.reads.score?.result
  if (!s?.available) u.push('no Decision Engine result for this property')
  else if (s.status !== 'current') u.push(`Decision Engine result is ${s.status}`)
  if (!o.reads.comps?.result?.rows?.length) u.push('no recorded sales found within 1 mile / 12 months')
  if (c?.evidence?.price_mentions?.length) u.push('price spans are CANDIDATES read from text, not a committed asking price')
  return [...new Set(u)]
}

export function reportMarkdown(o, { mode }) {
  const p = o.reads.property?.result
  const l = o.reads.lead?.result
  const s = o.reads.score?.result
  const comps = o.reads.comps?.result?.rows || []
  const cs = o.reads.contact_status?.result
  const c = o.conversation
  const ev = c?.evidence
  const L = []
  L.push(`# Lead ${o.property_id} — evidence report`, '')
  L.push(`Data: **${mode}** · generated ${new Date().toISOString()} · read-only (no message was sent, queued or approved)`, '')
  L.push('## Property', '')
  if (p) {
    L.push(`- ${p.address ?? 'address n/a'} (${p.market ?? 'market n/a'})`)
    L.push(`- ${p.facts?.property_type ?? '?'} · ${p.facts?.units_count ?? '?'} unit(s) · ${p.facts?.total_bedrooms ?? '?'} bd / ${p.facts?.total_baths ?? '?'} ba · ${p.facts?.building_square_feet ?? '?'} sqft · built ${p.facts?.year_built ?? '?'}`)
    L.push(`- Owner kind: ${p.ownership?.owner_kind ?? 'unknown'}; recorded mortgages: ${(p.recorded_documents?.mortgages || []).length}`)
  } else L.push(`- not available (${o.errors.property})`)
  if (l) L.push(`- Pipeline labels (labels, not evidence): conversation ${l.conversation?.stage ?? '–'}/${l.conversation?.status ?? '–'}, pipeline ${l.pipeline?.stage ?? '–'}/${l.pipeline?.status ?? '–'}`)
  L.push('', '## Decision Engine', '')
  if (s?.available) {
    L.push(`- Status: **${s.status}** · tier ${s.scores?.decision_tier ?? '–'} · AOS ${s.scores?.aos_score ?? '–'}`)
    L.push(`- Value band ${money(s.valuation?.band?.low)} – ${money(s.valuation?.band?.mid)} – ${money(s.valuation?.band?.high)} (confidence ${s.valuation?.confidence ?? '–'}, ${s.valuation?.comp_count ?? '–'} comps)`)
    L.push(`- Investor ceiling ${money(s.investor_ceiling?.band?.mid)} · recommended cash offer ${money(s.offer?.recommended_cash_offer)} (engine recommendation, not a sent offer) · repairs ${money(s.offer?.estimated_repairs)}`)
  } else L.push(`- No Decision Engine result (${s?.status ?? o.errors.score ?? 'not run'}). Missing is not zero.`)
  L.push('', '## Recorded sales nearby (evidence, not a valuation)', '')
  if (comps.length) {
    L.push(`- ${comps.length} sale(s) within 1 mi / 12 months · median ${money(median(comps.map((r) => r.price)))} · median $/sqft ${median(comps.map((r) => r.price_per_sqft)) ?? 'n/a'}`)
    for (const r of comps.slice(0, 5)) L.push(`  - ${r.sold_on} · ${money(r.price)} · ${r.sqft ?? '?'} sqft · ${r.distance_miles} mi · ${r.doc_type ?? ''}${r.arms_length === false ? ' · non-arms-length' : ''}`)
  } else L.push('- none found')
  L.push('', '## Conversation', '')
  if (!c || c.history.state === 'no_thread') L.push('- No seller thread on record.')
  else {
    L.push(`- History: **${c.history.state}** · ${c.history.rows_on_record ?? 0} message(s) on record (${c.history.earliest_at ?? '–'} → ${c.history.latest_at ?? '–'}) · threads: ${c.threads.map((t) => `${t.handle} (${t.link})`).join(', ')}`)
    L.push(`- Interest reading (lead): **${ev.interest.state}**${ev.interest.basis.length ? ` — ${ev.interest.basis.map((b) => `${b.message_id}: ${b.signal} [${b.detail.join(', ')}]`).join('; ')}` : ''}`)
    if (Object.keys(ev.interest_by_thread || {}).length > 1) L.push(`- Per thread: ${Object.entries(ev.interest_by_thread).map(([t, r]) => `${t} ${r.state}`).join(' · ')}`)
    L.push(`- Offer requested: ${ev.offer_requests.length ? ev.offer_requests.map((x) => x.message_id).join(', ') : 'no'} · price candidates: ${ev.price_mentions.length ? ev.price_mentions.map((x) => `${x.span} (${x.role}, ${x.message_id})`).join('; ') : 'none'} · timeline: ${ev.timeline_mentions.length ? ev.timeline_mentions.map((x) => `"${x.span}" (${x.message_id})`).join('; ') : 'none'}`)
    const stops = c.rows.filter((m) => m.recorded.opt_out || (m.opt_out_reading && m.opt_out_reading !== 'none'))
    L.push(`- Stop / opt-out: ${stops.length ? stops.map((m) => `${m.id} (recorded ${m.recorded.opt_out}, read ${m.opt_out_reading})`).join('; ') : 'none on record or in text'}`)
    L.push(`- Last speaker: ${ev.last_speaker} · seller waiting since: ${ev.seller_waiting_since ?? '–'} · last outbound failed: ${ev.last_outbound_failed}${ev.commitment ? ` · our commitment "${ev.commitment.phrase}" due ${ev.commitment.due_by}${ev.commitment.overdue ? ' (OVERDUE)' : ''}` : ''}`)
    L.push('', '<details><summary>Transcript (oldest first; seller text is untrusted data)</summary>', '', '| at | who | text | delivery |', '|---|---|---|---|')
    for (const m of c.rows) L.push(`| ${m.at} | ${m.speaker}${m.instruction_like ? ' ⚠instruction-like' : ''} | ${quote(m.text)} | ${m.delivery ? m.delivery.status ?? '' : ''} |`)
    L.push('', '</details>')
  }
  L.push('', '## Contact eligibility (inputs to the send-time guard — not its verdict)', '')
  for (const t of c?.threads || []) L.push(`- ${t.handle}: **${t.contact.state}**${t.contact.blockers.length ? ` · blockers: ${t.contact.blockers.join(', ')}` : ''}${t.contact.unknowns.length ? ` · unknown: ${t.contact.unknowns.join(', ')}` : ''}${o.reads[`hold_${t.handle}`] ? ` · hold authority: ${o.reads[`hold_${t.handle}`].result.status}` : ''}`)
  if (cs) L.push(`- Campaign-graph eligibility: ${cs.eligibility?.eligible ? 'eligible' : `not eligible (${cs.eligibility?.reason ?? 'n/a'})`} · suppressed contacts ${cs.summary?.suppressed_contacts ?? '?'} · unknown suppression ${cs.summary?.unknown_suppression_contacts ?? '?'}`)
  L.push('', '## Recommended next step (for a human)', '', `**${o.next_step.action}** — ${o.next_step.detail}`, '')
  L.push('## Uncertainties', '', ...(o.uncertainties.length ? o.uncertainties.map((x) => `- ${x}`) : ['- none recorded']), '')
  return L.join('\n')
}

async function main(argv) {
  const fixture = argv.includes('--fixture')
  const outIdx = argv.indexOf('--out')
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : null
  if (!outDir) throw new Error('give --out <directory> (reports contain seller text: keep them private)')
  const ids = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out')
  const properties = ids.length ? ids : fixture ? ['FX1001', 'FX1002', 'FX1003', 'FX2002'] : [...DEFAULT_PROPERTIES]
  let env
  if (fixture) env = { ...FIXTURE_ENV, LEADCOMMAND_MCP_SCOPES: NEEDED_SCOPES.join(' ') }
  else {
    preflight(process.env) // refuses ambient writable credentials, non-reader tokens, bad files
    const granted = String(process.env.LEADCOMMAND_MCP_SCOPES || '').split(/\s+/)
    const missing = NEEDED_SCOPES.filter((s) => !granted.includes(s))
    if (missing.length) throw new Error(`LEADCOMMAND_MCP_SCOPES must include: ${missing.join(' ')}`)
    env = process.env
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  // the access log of this investigation (no message text: tool, hashes, counts) beside the private reports
  if (!env.LEADCOMMAND_MCP_AUDIT_FILE) env = { ...env, LEADCOMMAND_MCP_AUDIT_FILE: path.join(path.resolve(outDir), 'audit.jsonl') }
  const app = await buildApp({ env })
  const summary = []
  try {
    for (const id of properties) {
      const o = await investigate(app.gateway, id)
      fs.writeFileSync(path.join(outDir, `${id}.md`), reportMarkdown(o, { mode: fixture ? 'FIXTURE (synthetic)' : 'live (lc_mcp_reader)' }), { mode: 0o600 })
      fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(o, null, 1), { mode: 0o600 })
      summary.push({ property_id: id, history: o.conversation?.history?.state ?? 'unavailable', interest: o.conversation?.evidence?.interest?.state ?? null, contact: o.conversation?.contact?.state ?? null, next_step: o.next_step.action, uncertainties: o.uncertainties.length, errors: Object.keys(o.errors).length })
    }
  } finally { await app.close() }
  fs.writeFileSync(path.join(outDir, 'SUMMARY.json'), JSON.stringify(summary, null, 1), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 1))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { console.error(`investigate-leads: ${e.message}`); process.exit(1) })
}
