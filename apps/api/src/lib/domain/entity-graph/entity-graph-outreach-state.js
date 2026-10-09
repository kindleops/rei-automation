/**
 * ENTITY GRAPH · OUTREACH STATE — the four facts the owner asked to see on
 * every grid row, the property detail and the graph hover card (2026-10-08):
 *
 *   LAST CONTACT   date + direction + channel (latest of the inbox thread and
 *                  the campaign target graph's contact timestamps)
 *   STAGE          the pipeline deal's stage when a deal exists, else the
 *                  conversation's seller stage — and which one it is
 *   STATUS         the deal's status, else the conversation's status
 *   SMS ELIGIBLE   yes/no + the blocking reason, from campaign_target_graph
 *                  through resolveCampaignTargetReadiness — the SAME per-row
 *                  rule the campaign target builder applies (queue_eligible,
 *                  identity linkage, entity-contact review, identity
 *                  verification, timezone). Never a second computation.
 *
 * Plus the conversation (latest thread, a short preview) and campaign
 * membership (how many campaigns hold the property, the latest one).
 *
 * Load contract (same as entity-graph-column-enrichment.js): keyed reads only
 * (`in` on an indexed property_id; acquisition_opportunities is ~300 rows),
 * at most MAX_IDS per call in CHUNK pieces, absent = absent (the UI says "—").
 * Phone numbers are read server-side for the linkage rule and NEVER returned.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { resolveCampaignTargetReadiness } from '@/lib/domain/campaigns/campaign-target-readiness.js'

export const MAX_IDS = 300
const CHUNK = 150
const PREVIEW_CHARS = 140

const clean = (v) => String(v ?? '').trim()
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(clean).filter(Boolean))]
const time = (v) => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

const GRAPH_SELECT = [
  'property_id', 'queue_eligible', 'queue_block_reason', 'seller_person_key', 'prospect_id', 'canonical_prospect_id',
  'canonical_e164', 'phone_id', 'timezone', 'identity_alignment', 'last_outbound_at', 'last_inbound_at', 'latest_contact_at',
].join(',')
const THREAD_SELECT = [
  'thread_key', 'property_id', 'latest_message_at', 'latest_direction', 'latest_message_body', 'seller_stage', 'stage',
  'conversation_status', 'status', 'is_suppressed', 'last_inbound_at', 'last_outbound_at',
].join(',')
const OPP_SELECT = 'id, primary_property_id, acquisition_stage, opportunity_status, universal_status, last_contact_at'
const TARGET_SELECT = 'property_id, campaign_id, target_status, block_reason, created_at'

async function inChunks(ids, read) {
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await read(ids.slice(i, i + CHUNK))
    out.push(...(rows || []))
  }
  return out
}

async function readOrThrow(query) {
  const { data, error } = await query
  if (error) throw error
  return data || []
}

/**
 * Property-level SMS eligibility from its graph rows: eligible when ANY row is
 * ready under the builder's readiness rule; otherwise the reason of the
 * closest row (queue-eligible rows first, then the most common reason).
 */
export function propertySmsEligibility(rows = [], reviewBlocked = false) {
  if (!rows.length) return { eligible: false, reason: 'not_in_campaign_audience', rows: 0, ready: 0 }
  const verdicts = rows.map((row) => resolveCampaignTargetReadiness({ ...row, entity_contact_requires_review: Boolean(reviewBlocked) }))
  const ready = verdicts.filter((v) => v.ready).length
  if (ready > 0) return { eligible: true, reason: null, rows: rows.length, ready }
  const tally = new Map()
  verdicts.forEach((v, i) => {
    const key = v.blockReason || 'blocked'
    const weight = rows[i].queue_eligible ? 1000 : 1
    tally.set(key, (tally.get(key) || 0) + weight)
  })
  const reason = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  return { eligible: false, reason, rows: rows.length, ready: 0 }
}

/** Latest contact across the thread and the graph's timestamps. */
export function latestContact({ thread = null, graphRows = [] } = {}) {
  const candidates = []
  if (thread) {
    if (time(thread.last_inbound_at)) candidates.push({ at: thread.last_inbound_at, direction: 'inbound', source: 'inbox' })
    if (time(thread.last_outbound_at)) candidates.push({ at: thread.last_outbound_at, direction: 'outbound', source: 'inbox' })
    if (time(thread.latest_message_at) && /^(inbound|outbound)$/i.test(clean(thread.latest_direction))) {
      candidates.push({ at: thread.latest_message_at, direction: clean(thread.latest_direction).toLowerCase(), source: 'inbox' })
    }
  }
  for (const row of graphRows) {
    if (time(row.last_inbound_at)) candidates.push({ at: row.last_inbound_at, direction: 'inbound', source: 'campaign_target_graph' })
    if (time(row.last_outbound_at)) candidates.push({ at: row.last_outbound_at, direction: 'outbound', source: 'campaign_target_graph' })
  }
  if (!candidates.length) return null
  const best = candidates.sort((a, b) => time(b.at) - time(a.at))[0]
  return { at: best.at, direction: best.direction, channel: 'sms', source: best.source }
}

function preview(body) {
  const text = clean(body).replace(/\s+/g, ' ')
  if (!text) return null
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text
}

/**
 * CONTACT DISCOVERY (owner defect 2026-10-08): a property whose campaign-graph
 * rows carry no phone — or that has no graph row / no master owner at all —
 * read "No phone" even when prospects linked to it (prospects.linked_property_ids_json,
 * GIN-indexed) carry phone candidates. Measured on a 361-property sample of
 * owner-less properties: 185 have a linked prospect with a phone; 41 of
 * those show no phone in the campaign graph.
 *
 * These candidates are EVIDENCE, never eligibility: SMS eligible stays the
 * builder's readiness verdict, and Add to Campaign still pins only what the
 * graph allows. Each candidate states how it is tied to the property:
 *   resolved_owner      the prospect's master owner IS the property's master owner
 *   graph_person        the prospect's individual_key is the graph's resolved person
 *   linked_unresolved   linked to the property by the vendor, identity not resolved
 * Numbers leave the server masked (last four digits only).
 */
export const CONTACT_GAP_REASONS = new Set(['not_in_campaign_audience', 'missing_phone', 'NO_PHONE', 'missing_identity_linkage'])
const PROSPECT_CANDIDATE_SELECT = 'prospect_id, master_owner_id, individual_key, full_name, matching_flags, phones_json, sms_eligible'
export const maskPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? `•••-${digits.slice(-4)}` : '•••'
}

export function contactCandidates({ prospects = [], propertyOwnerId = null, graphRows = [] } = {}) {
  const graphPeople = new Set(graphRows.map((r) => clean(r.seller_person_key)).filter(Boolean))
  const graphPhones = new Set(graphRows.map((r) => clean(r.canonical_e164)).filter(Boolean))
  const out = []
  for (const p of prospects) {
    const resolution = propertyOwnerId && clean(p.master_owner_id) === clean(propertyOwnerId) ? 'resolved_owner'
      : graphPeople.has(clean(p.individual_key)) ? 'graph_person'
        : 'linked_unresolved'
    const evidence = ['linked_property']
    if (resolution === 'resolved_owner') evidence.push('same_master_owner')
    if (graphPeople.has(clean(p.individual_key))) evidence.push('campaign_graph_person')
    const phones = (Array.isArray(p.phones_json) ? p.phones_json : [])
      .filter((ph) => ph && (ph.canonical_e164 || ph.phone_raw))
      .map((ph) => ({
        masked: maskPhone(ph.canonical_e164 || ph.phone_raw),
        type: clean(ph.phone_type) || null,
        score: Number.isFinite(Number(ph.phone_score)) ? Number(ph.phone_score) : null,
        usage: clean(ph.usage_2_months) || null,
        inCampaignGraph: graphPhones.has(clean(ph.canonical_e164)),
      }))
    if (!phones.length) continue
    out.push({ prospectId: clean(p.prospect_id) || null, name: clean(p.full_name) || 'Linked person', resolution, evidence, matching: clean(p.matching_flags) || null, phones })
  }
  const rank = { resolved_owner: 0, graph_person: 1, linked_unresolved: 2 }
  return out.sort((a, b) => rank[a.resolution] - rank[b.resolution])
}

async function pooled(items, limit, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; await fn(items[i]) }
  }))
}

/**
 * Returns { states: { [property_id]: OutreachState }, generatedAt, partial }.
 * A source that fails is reported in `unavailable` and its facts stay absent
 * — never filled with a guess.
 */
export async function getEntityGraphOutreachState(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const ids = list(params.property_ids).slice(0, MAX_IDS)
  const states = {}
  if (!ids.length) return { states, generatedAt: new Date().toISOString(), unavailable: [] }
  const unavailable = []
  const guard = async (name, fn) => {
    try { return await fn() } catch (error) {
      unavailable.push({ source: name, message: clean(error?.message).slice(0, 160) || 'read_failed' })
      return null
    }
  }

  const [graphRows, threads, opps, targets, review] = await Promise.all([
    guard('campaign_target_graph', () => inChunks(ids, (part) => readOrThrow(supabase.from('campaign_target_graph').select(GRAPH_SELECT).in('property_id', part)))),
    guard('inbox_thread_state', () => inChunks(ids, (part) => readOrThrow(supabase.from('inbox_thread_state').select(THREAD_SELECT).in('property_id', part)))),
    guard('acquisition_opportunities', () => inChunks(ids, (part) => readOrThrow(supabase.from('acquisition_opportunities').select(OPP_SELECT).in('primary_property_id', part)))),
    guard('campaign_targets', () => inChunks(ids, (part) => readOrThrow(supabase.from('campaign_targets').select(TARGET_SELECT).in('property_id', part).limit(5000)))),
    guard('entity_contact_review', async () => {
      const { fetchEntityContactReviewBlocks } = await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
      const result = await fetchEntityContactReviewBlocks(ids, { supabase })
      if (result?.ok === false) throw new Error('entity_contact_review_flags_unavailable')
      return result?.blocked || new Set()
    }),
  ])

  // contact discovery only where the graph has no phone for the property
  const gapIds = graphRows === null ? [] : ids.filter((id) => {
    const rows = graphRows.filter((r) => clean(r.property_id) === id)
    return !rows.some((r) => clean(r.canonical_e164))
  })
  const candidatesBy = new Map()
  const propertyOwner = new Map()
  if (gapIds.length) {
    await guard('contact_candidates', async () => {
      const owners = await inChunks(gapIds, (part) => readOrThrow(supabase.from('properties').select('property_id, master_owner_id').in('property_id', part)))
      for (const o of owners) propertyOwner.set(clean(o.property_id), clean(o.master_owner_id) || null)
      await pooled(gapIds, 6, async (id) => {
        // jsonb containment takes a JSON array STRING (an Array is sent as a Postgres array literal)
        const rows = await readOrThrow(supabase.from('prospects').select(PROSPECT_CANDIDATE_SELECT).contains('linked_property_ids_json', JSON.stringify([String(id)])).limit(12))
        candidatesBy.set(id, rows)
      })
    })
  }

  const campaignIds = [...new Set((targets || []).map((t) => clean(t.campaign_id)).filter(Boolean))]
  const campaigns = campaignIds.length
    ? await guard('campaigns', () => inChunks(campaignIds, (part) => readOrThrow(supabase.from('campaigns').select('id, name, status').in('id', part))))
    : []
  const campaignById = new Map((campaigns || []).map((c) => [clean(c.id), c]))

  const group = (rows, key) => {
    const map = new Map()
    for (const row of rows || []) {
      const k = clean(row[key])
      if (!k) continue
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(row)
    }
    return map
  }
  const graphBy = group(graphRows, 'property_id')
  const threadBy = group(threads, 'property_id')
  const oppBy = group(opps, 'primary_property_id')
  const targetBy = group(targets, 'property_id')

  for (const id of ids) {
    const rows = graphBy.get(id) || []
    const thread = (threadBy.get(id) || []).sort((a, b) => (time(b.latest_message_at) || 0) - (time(a.latest_message_at) || 0))[0] || null
    const opp = (oppBy.get(id) || [])[0] || null
    const memberships = targetBy.get(id) || []
    const sms = graphRows === null
      ? null
      : { ...propertySmsEligibility(rows, review ? review.has(id) : false), source: 'campaign_target_graph', reviewChecked: review !== null }
    const contact = latestContact({ thread, graphRows: rows })
    const stage = opp?.acquisition_stage
      ? { value: opp.acquisition_stage, source: 'pipeline' }
      : thread && clean(thread.seller_stage || thread.stage)
        ? { value: clean(thread.seller_stage || thread.stage), source: 'conversation' }
        : null
    const status = opp && clean(opp.opportunity_status || opp.universal_status)
      ? { value: clean(opp.opportunity_status || opp.universal_status), source: 'pipeline' }
      : thread && clean(thread.conversation_status || thread.status)
        ? { value: clean(thread.conversation_status || thread.status), source: 'conversation' }
        : null
    const byCampaign = new Map()
    for (const t of memberships) {
      const cid = clean(t.campaign_id)
      if (!cid) continue
      const prev = byCampaign.get(cid)
      if (!prev || (time(t.created_at) || 0) > (time(prev.created_at) || 0)) byCampaign.set(cid, t)
    }
    const latestTarget = [...byCampaign.values()].sort((a, b) => (time(b.created_at) || 0) - (time(a.created_at) || 0))[0] || null
    const latestCampaign = latestTarget ? campaignById.get(clean(latestTarget.campaign_id)) : null
    const discovered = candidatesBy.has(id)
      ? contactCandidates({ prospects: candidatesBy.get(id), propertyOwnerId: propertyOwner.get(id) ?? null, graphRows: rows })
      : null
    states[id] = {
      sms,
      // null = not looked up (the graph already has a phone, or the read failed)
      contactCandidates: discovered
        ? {
            people: discovered.length,
            phones: discovered.reduce((n, c) => n + c.phones.length, 0),
            unresolved: discovered.filter((c) => c.resolution === 'linked_unresolved').length,
            candidates: discovered.slice(0, 6),
          }
        : null,
      lastContact: contact,
      stage,
      status,
      // the two systems apart (owner, 2026-10-08: "Status/Stage columns mixing
      // pipeline vs conversation values"): a deal's stage/status and the
      // conversation's seller stage/status are different vocabularies
      pipeline: opp ? { stage: clean(opp.acquisition_stage) || null, status: clean(opp.opportunity_status || opp.universal_status) || null } : null,
      conversationState: thread ? { stage: clean(thread.seller_stage || thread.stage) || null, status: clean(thread.conversation_status || thread.status) || null } : null,
      dealId: opp?.id ? String(opp.id) : null,
      conversation: thread
        ? {
            threadKey: thread.thread_key || null,
            at: thread.latest_message_at || null,
            direction: clean(thread.latest_direction).toLowerCase() || null,
            preview: preview(thread.latest_message_body),
            bucket: null,
            suppressed: Boolean(thread.is_suppressed),
          }
        : null,
      campaigns: targets === null
        ? null
        : {
            count: byCampaign.size,
            latest: latestTarget
              ? {
                  id: clean(latestTarget.campaign_id),
                  name: latestCampaign?.name || null,
                  status: latestCampaign?.status || null,
                  targetStatus: latestTarget.target_status || null,
                  blockReason: latestTarget.block_reason || null,
                }
              : null,
          },
    }
  }
  return { states, generatedAt: new Date().toISOString(), unavailable }
}
