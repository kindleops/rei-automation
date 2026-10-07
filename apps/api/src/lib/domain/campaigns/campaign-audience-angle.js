// ─── campaign-audience-angle.js ──────────────────────────────────────────────
// AUDIENCE FILTER vs MESSAGE ANGLE (owner 2026-10-07). Read-only derivation.
//
// Two different things that recent campaigns conflated:
//   • AUDIENCE FILTERS — what actually restricted who was selected: the saved
//     campaigns.metadata.target_filters (and a drawn map area).
//   • MESSAGE ANGLE / TEMPLATE — what we said: the strategy use case, stage and
//     the templates actually sent (send_queue.template_id → sms_templates).
// A targeting term implied by the campaign NAME or by template copy (e.g.
// "Los Angeles · MFR / TL" → tired landlord) that no audience filter applies is
// flagged ANGLE-ONLY / NOT FILTERED. Derived from stored rows only — no write,
// so it backfills every historical campaign by construction.

function clean(v) {
  return String(v ?? '').trim()
}

const FLAG_FIELDS = new Set(['properties.property_flags_text', 'properties.podio_tags', 'properties.seller_tags_text', 'properties.seller_tags_json'])

/**
 * Targeting terms. `name` matches the campaign name / template copy; `covers`
 * says which saved filter would actually apply the term.
 */
export const TARGETING_TERMS = Object.freeze([
  { key: 'tired_landlord', label: 'Tired landlord', name: /tired[\s-]*(of[\s-]*(being[\s-]*)?(a[\s-]*)?)?landlord|landlord[\s-]*(headache|fatigue)|(^|[\s/·|(-])TL($|[\s/·|)-])/i, flag: /tired landlord/i },
  { key: 'tax_delinquent', label: 'Tax delinquent', name: /tax[\s-]*delinq/i, flag: /tax delinquent/i, field: 'properties.tax_delinquent' },
  { key: 'vacant', label: 'Vacant', name: /\bvacant\b/i, flag: /vacant/i },
  { key: 'probate', label: 'Probate / inherited', name: /probate|inherit/i, flag: /probate/i },
  { key: 'preforeclosure', label: 'Pre-foreclosure', name: /pre[\s-]*foreclos|foreclos/i, flag: /foreclos/i },
  { key: 'absentee', label: 'Absentee', name: /absentee/i, flag: /absentee/i },
  { key: 'out_of_state', label: 'Out-of-state owner', name: /out[\s-]*of[\s-]*state/i, flag: /out of state/i, field: 'properties.out_of_state_owner' },
  { key: 'high_equity', label: 'High equity', name: /high[\s-]*equity|free[\s&-]*(and|&)?[\s-]*clear/i, flag: /high equity|free and clear/i, field: 'properties.equity_percent' },
  { key: 'poor_condition', label: 'Poor condition / repairs', name: /poor|unsound|distress|repair/i, flag: /heavily dated|no updates/i, field: 'properties.building_condition' },
  { key: 'active_lien', label: 'Active lien', name: /\blien/i, flag: /lien/i, field: 'properties.active_lien' },
  { key: 'multifamily', label: 'Multifamily', name: /\bMFR?\b|multi[\s-]*family|duplex|triplex|fourplex/i, typeValue: /multi|duplex|triplex|fourplex|apartment/i, field: 'properties.units_count' },
  { key: 'single_family', label: 'Single family', name: /\bSFR?\b|single[\s-]*family/i, typeValue: /single family/i },
  { key: 'acquisition_score', label: 'Acquisition score', name: /acq(uisition)?\s*score|\b\d{2}\+\s*acq/i, field: 'properties.final_acquisition_score' },
])

// Template copy implies a TARGETING claim only for seller-situation phrases;
// "is it vacant or rented?" / "any repairs?" are discovery questions, not
// targeting (backfill 2026-10-07: Miami - Test Campaign copy asks about vacancy).
const COPY_IMPLIES = new Set(['tired_landlord', 'tax_delinquent', 'probate', 'preforeclosure', 'active_lien'])

function flattenFilters(targetFilters) {
  const out = []
  const tf = targetFilters && typeof targetFilters === 'object' ? targetFilters : {}
  for (const [domain, list] of Object.entries(tf)) {
    if (!Array.isArray(list)) continue
    for (const f of list) {
      if (!f || typeof f !== 'object') continue
      const key = clean(f.field_key || f.fieldKey || `${domain}.${f.field || ''}`)
      if (!key) continue
      out.push({ field_key: key, label: clean(f.label) || key.split('.').pop().replace(/_/g, ' '), category: clean(f.category) || domain, operator: clean(f.operator) || 'is', value: f.value ?? null })
    }
  }
  return out
}

function valueText(value) {
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' | ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value ?? '')
}

function termCoveredBy(term, filters) {
  return filters.filter((f) => {
    const v = valueText(f.value)
    if (term.field && f.field_key === term.field) return true
    if (term.flag && FLAG_FIELDS.has(f.field_key) && term.flag.test(v) && !/not/i.test(f.operator)) return true
    if (term.typeValue && f.field_key === 'properties.property_type' && term.typeValue.test(v)) return true
    return false
  })
}

/**
 * @param {{name?:string, objective?:string, metadata?:object}} campaign
 * @param {{templates?: {id?:string, template_id?:string|number, template_name?:string, use_case?:string, template_body?:string, sends?:number}[]}} ctx
 */
export function deriveAudienceVsAngle(campaign = {}, { templates = [] } = {}) {
  const md = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  const filters = flattenFilters(md.target_filters ?? campaign.target_filters ?? campaign.filters)
  const name = clean(campaign.name || campaign.campaign_name)
  const useCase = clean(md.template_use_case || campaign.template_use_case || campaign.objective) || null
  const stage = clean(md.stage_code || campaign.stage_code) || null
  const tpl = (templates || []).map((t) => ({ template_id: clean(t.template_id ?? t.id), name: clean(t.template_name) || null, use_case: clean(t.use_case) || null, body_preview: clean(t.template_body).slice(0, 160) || null, sends: Number(t.sends ?? 0) || 0 }))
  const terms = []
  for (const term of TARGETING_TERMS) {
    const inName = term.name.test(name)
    const inTemplates = COPY_IMPLIES.has(term.key) ? tpl.filter((t) => t.body_preview && term.name.test(t.body_preview)).map((t) => t.template_id) : []
    const covered = termCoveredBy(term, filters)
    if (!inName && !inTemplates.length && !covered.length) continue
    const implied = inName || inTemplates.length > 0
    terms.push({
      key: term.key,
      label: term.label,
      implied_by: [...(inName ? ['campaign_name'] : []), ...(inTemplates.length ? ['template_copy'] : [])],
      template_ids: inTemplates,
      filtered_by: covered.map((f) => f.field_key),
      status: covered.length ? (implied ? 'filtered' : 'filter_only') : 'angle_only_not_filtered',
    })
  }
  const area = filters.some((f) => /drawn_area|geo_area/.test(f.field_key))
  return {
    version: 'audience_angle_v1',
    campaign_id: campaign.id ?? null,
    name: name || null,
    audience_filters: filters,
    audience_summary: filters.length ? filters.map((f) => `${f.label} ${f.operator.replace(/_/g, ' ')} ${valueText(f.value).slice(0, 80)}`) : ['(no saved audience filter)'],
    drawn_area: area,
    message_angle: { use_case: useCase, stage_code: stage, templates: tpl.sort((a, b) => b.sends - a.sends), template_source: tpl.length ? 'send_queue (templates actually sent)' : 'none sent yet' },
    terms,
    badges: terms.filter((t) => t.status === 'angle_only_not_filtered').map((t) => ({ key: t.key, label: `${t.label} — angle-only, not filtered`, implied_by: t.implied_by })),
  }
}

/**
 * Set-based read for one, several or all campaigns (≤ 300): campaigns, the
 * templates each actually sent (ONE grouped send_queue read) and their copy
 * (ONE sms_templates read).
 */
export async function readCampaignAudienceAngles({ campaignIds = null, limit = 300 } = {}, { db } = {}) {
  const ids = Array.isArray(campaignIds) ? campaignIds.map(clean).filter((v) => /^[0-9a-f-]{36}$/i.test(v)) : null
  const { rows: campaigns } = await db.query(
    `select id, name, objective, status, created_at, metadata from public.campaigns
      where ($1::uuid[] is null or id = any($1::uuid[]))
      order by created_at desc limit $2`,
    [ids && ids.length ? ids : null, Math.min(Math.max(Number(limit) || 300, 1), 300)],
  )
  const cids = campaigns.map((c) => c.id)
  if (!cids.length) return []
  const { rows: used } = await db.query(
    `select campaign_id, template_id::text template_id, count(*)::int sends from public.send_queue
      where campaign_id = any($1::uuid[]) and template_id is not null and queue_status in ('delivered','sent')
      group by 1, 2`,
    [cids],
  )
  const tids = [...new Set(used.map((u) => u.template_id))]
  const { rows: tpls } = tids.length
    ? await db.query('select id::text id, template_id::text template_id, template_name, use_case, template_body from public.sms_templates where template_id::text = any($1::text[]) or id::text = any($1::text[])', [tids])
    : { rows: [] }
  const tplBy = new Map()
  for (const t of tpls) { tplBy.set(t.template_id, t); tplBy.set(t.id, t) }
  return campaigns.map((c) => deriveAudienceVsAngle(c, {
    templates: used.filter((u) => u.campaign_id === c.id).map((u) => ({ ...(tplBy.get(u.template_id) || {}), template_id: u.template_id, sends: u.sends })),
  })).map((r, i) => ({ ...r, status: campaigns[i].status, created_at: campaigns[i].created_at }))
}
