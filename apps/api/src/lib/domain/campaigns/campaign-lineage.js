/**
 * WHERE A CAMPAIGN'S AUDIENCE CAME FROM — read straight off the campaign row.
 *
 * The builder records the source on the campaign itself: `metadata.source`
 * ('map_area' | 'entity_graph'), the drawn area's summary in `metadata.area`,
 * and the audience definition in `metadata.target_filters` — for a Map area or
 * an Entity Graph selection that is an explicit `properties.property_id` list,
 * for everything else a set of field filters. Nothing here is inferred from the
 * campaign's NAME or a market string: "Map area · Minneapolis, MN" is a label a
 * person can edit, the id list is the cohort.
 *
 * Pure and dependency-free so the list (every campaign) and the cockpit (one
 * campaign) describe lineage the same way without a query.
 */

import { campaignWindowZones } from '@/lib/domain/campaigns/campaign-market-identity.js'

const clean = (value) => String(value ?? '').trim()
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const int = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

/** The one clause that pins an exact cohort rather than describing one. */
export const EXPLICIT_PROPERTY_FIELD = 'properties.property_id'

const VALUE_SAMPLE = 6

/** A filter value, summarised: never the whole list (a 944-id array is not a label). */
function summarizeValue(value) {
  if (Array.isArray(value)) {
    const items = value.map((v) => clean(v)).filter(Boolean)
    return { kind: 'list', count: items.length, sample: items.slice(0, VALUE_SAMPLE) }
  }
  if (value === null || value === undefined || clean(value) === '') return { kind: 'empty' }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  if (typeof value === 'number') return { kind: 'number', value }
  if (typeof value === 'object') return { kind: 'text', value: JSON.stringify(value).slice(0, 160) }
  return { kind: 'text', value: clean(value).slice(0, 160) }
}

/** The exact property ids a campaign pinned, in stored order, de-duplicated. */
export function explicitPropertyIds(metadata = {}) {
  const filters = obj(obj(metadata).target_filters)
  const out = []
  const seen = new Set()
  for (const list of Object.values(filters)) {
    if (!Array.isArray(list)) continue
    for (const clause of list) {
      if (clean(clause?.field_key) !== EXPLICIT_PROPERTY_FIELD) continue
      const values = Array.isArray(clause.value) ? clause.value : [clause.value]
      for (const v of values) {
        const id = clean(v)
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push(id)
      }
    }
  }
  return out
}

/**
 * @returns {{
 *   kind: 'map_area'|'entity_graph'|'filters'|'selection'|'none',
 *   declared_source: string|null,
 *   explicit_property_count: number|null,
 *   area: null|{ bbox: number[]|null, vertices: number|null, truncated: boolean, property_count: number|null, label: string|null, polygon_stored: boolean },
 *   handoff_mode: string|null,
 *   filters: Array<{ domain: string, field_key: string, category: string|null, operator: string|null, value: object }>,
 *   market_values: string[],
 *   timezone: string|null, stage_code: string|null, template_use_case: string|null,
 *   campaign_type: string|null, channel: 'sms',
 * }}
 */
export function describeCampaignLineage(campaign = {}) {
  const md = obj(campaign.metadata)
  const lineageZones = [...new Set(campaignWindowZones(campaign).map(clean).filter(Boolean))]
  const filters = obj(md.target_filters)

  const explicitCount = explicitPropertyIds(md).length
  const dimensions = []
  const marketValues = []
  for (const [domain, list] of Object.entries(filters)) {
    if (!Array.isArray(list)) continue
    for (const clause of list) {
      if (!clause || typeof clause !== 'object') continue
      const key = clean(clause.field_key)
      if (!key || key === EXPLICIT_PROPERTY_FIELD) continue
      dimensions.push({
        domain,
        field_key: key,
        category: clean(clause.category) || null,
        operator: clean(clause.operator) || null,
        value: summarizeValue(clause.value),
      })
      if (key.endsWith('.market')) {
        for (const v of Array.isArray(clause.value) ? clause.value : [clause.value]) {
          const m = clean(v)
          if (m && !marketValues.includes(m)) marketValues.push(m)
        }
      }
    }
  }

  const declared = clean(md.source).toLowerCase()
  let kind = 'none'
  if (declared === 'map_area') kind = 'map_area'
  else if (declared === 'entity_graph') kind = 'entity_graph'
  else if (dimensions.length) kind = 'filters'
  else if (explicitCount) kind = 'selection'

  const area = obj(md.area)
  const bbox = Array.isArray(area.bbox) && area.bbox.length === 4 && area.bbox.every((n) => Number.isFinite(Number(n)))
    ? area.bbox.map(Number)
    : null

  return {
    kind,
    declared_source: declared || null,
    explicit_property_count: explicitCount || null,
    area: kind === 'map_area'
      ? {
        bbox,
        vertices: int(area.vertices),
        truncated: area.truncated === true,
        property_count: int(area.property_count),
        label: clean(area.label) || null,
        // The drawn outline itself is only kept when the builder stored it.
        polygon_stored: Array.isArray(area.polygon) || Array.isArray(area.coordinates) || Boolean(area.geometry),
      }
      : null,
    handoff_mode: clean(md.handoff_mode) || null,
    filters: dimensions,
    market_values: marketValues.slice(0, VALUE_SAMPLE),
    // One zone, or null when the cohort spans several — then `timezones` lists
    // every recipient zone (campaign-market-identity). Never a guess.
    timezone: lineageZones.length === 1 ? lineageZones[0] : (lineageZones.length ? null : clean(md.timezone) || clean(md.launch_timezone) || null),
    timezones: lineageZones,
    stage_code: clean(md.stage_code) || null,
    template_use_case: clean(md.template_use_case) || null,
    campaign_type: clean(md.campaign_type) || null,
    // Campaigns execute through send_queue only; the campaign engine has no
    // email path (email_queue.campaign_id is never written by it).
    channel: 'sms',
  }
}

export default describeCampaignLineage
