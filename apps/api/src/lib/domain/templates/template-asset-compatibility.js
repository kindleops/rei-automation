/**
 * TEMPLATE ↔ PROPERTY ASSET COMPATIBILITY — the one rule.
 *
 * A template may only be sent about a property whose asset type it describes.
 * This is eligibility, decided BEFORE any ranking: a high-performing
 * self-storage template is still ineligible for a single-family home.
 *
 * Why this exists (production, 2026-09-25): campaign df0671fa scheduled 34
 * first touches and 15 of them read "are you still the owner of the
 * self-storage facility / retail center / commercial property at …" — to
 * single-family and apartment owners. The launch path handed the feeder
 * canonical_property_group = "Residential" (a label, not a slug), the slug
 * filter rejected every residential template, and the fallback cascade
 * relaxed to a level with NO property filter, where six commercial templates
 * (allowed_property_groups NULL = "everywhere") won half the picks. Earlier,
 * ~1,100 "5+ Units" templates ("the units at …", "the building …") reached
 * single-family owners the same way.
 *
 * The rule judges a template by its declared scope AND by the words the
 * seller will actually read, because template metadata has proven
 * unreliable (5+-Units templates list "sfr" as an allowed group). It judges
 * a property from the canonical classification, most specific first:
 * storage flags → asset_subclass → property_type (+ units) → property_class.
 *
 * Every selection path and the dispatch boundary call this; nothing else
 * decides asset fit.
 */

const lower = (value) => String(value ?? '').trim().toLowerCase()

export const RESIDENTIAL_GROUPS = Object.freeze(['sfr', 'duplex', 'triplex', 'fourplex', 'small_multifamily', 'multifamily_5_plus'])
export const MULTI_UNIT_GROUPS = Object.freeze(['duplex', 'triplex', 'fourplex', 'small_multifamily', 'multifamily_5_plus'])
export const COMMERCIAL_GROUPS = Object.freeze(['self_storage', 'retail', 'office', 'industrial', 'hotel_motel', 'mobile_home_park', 'other_commercial'])
const KNOWN_GROUPS = new Set([...RESIDENTIAL_GROUPS, ...COMMERCIAL_GROUPS, 'land', 'residential'])

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || lower(v) === 'yes'

function groupFromUnits(units) {
  const n = Number(units)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n === 1) return 'sfr'
  if (n === 2) return 'duplex'
  if (n === 3) return 'triplex'
  if (n === 4) return 'fourplex'
  if (n <= 10) return 'small_multifamily'
  return 'multifamily_5_plus'
}

/** One label → group, or null when the label says nothing specific. */
function groupFromLabel(label, units) {
  const t = lower(label)
  if (!t) return null
  if (KNOWN_GROUPS.has(t)) return t === 'residential' ? null : t
  if (/(self[\s-]?storage|mini[\s-]?storage|storage)/.test(t)) return 'self_storage'
  if (/(strip center|retail|shopping)/.test(t)) return 'retail'
  if (/office/.test(t)) return 'office'
  if (/(industrial|warehouse|flex)/.test(t)) return 'industrial'
  if (/(hotel|motel)/.test(t)) return 'hotel_motel'
  if (/mobile home park|manufactured.*park/.test(t)) return 'mobile_home_park'
  if (/(vacant|land|\blot\b|parcel|acre)/.test(t)) return 'land'
  if (/(single[\s-]?family|\bsfr\b|townho(use|me)|condo|mobile home|manufactured)/.test(t)) return 'sfr'
  if (/duplex/.test(t)) return 'duplex'
  if (/triplex/.test(t)) return 'triplex'
  if (/(fourplex|quadplex|4[\s-]?plex)/.test(t)) return 'fourplex'
  if (/(5\+|five\s*\+|multifamily 5)/.test(t)) return 'multifamily_5_plus'
  if (/(multi[\s-]?family|apartment|\bunits?\b)/.test(t)) {
    const byUnits = groupFromUnits(units)
    return byUnits && byUnits !== 'sfr' ? byUnits : 'small_multifamily'
  }
  if (/commercial/.test(t)) return 'other_commercial'
  return null
}

/**
 * The canonical property group for template matching. Returns one of the
 * groups above, 'residential' (residential, unit count unknown), or 'unknown'.
 */
export function canonicalPropertyGroupOf(property = {}) {
  const p = property || {}
  const units = p.units_count ?? p.unit_count ?? p.units
  if ([p.is_self_storage, p.is_storage, p.is_mini_storage, p.is_storage_facility, p.is_self_storage_facility, p.is_mini_storage_facility].some(truthy)) {
    return 'self_storage'
  }
  if (truthy(p.is_commercial_retail)) return 'retail'
  // Most specific first. A class-level word ("Residential", "Other") never
  // outranks a specific type found further down the list.
  for (const label of [
    p.asset_subclass,
    p.normalized_asset_subclass,
    p.property_group,
    p.canonical_property_group,
    p.property_type,
    p.original_property_type,
    p.asset_type,
    p.commercial_property_type,
  ]) {
    const g = groupFromLabel(label, units)
    if (g) return g
  }
  const byUnits = groupFromUnits(units)
  const cls = lower(p.property_class || p.asset_class || p.normalized_asset_class)
  if (/residential|multifamily/.test(cls) || lower(p.canonical_property_group) === 'residential') {
    return byUnits || 'residential'
  }
  if (/commercial|industrial|exempt|agricult/.test(cls)) return 'other_commercial'
  if (/vacant|land/.test(cls)) return 'land'
  return byUnits || 'unknown'
}

// ── Template side ────────────────────────────────────────────────────────

const STORAGE_WORDS = /(self[\s-]?storage|mini[\s-]?storage|storage (facilit|units? business|propert))/i
const RETAIL_WORDS = /(retail (center|propert|space|building)|strip (center|mall)|shopping center)/i
const COMMERCIAL_WORDS = /(commercial (property|propert|building|buyers?|real estate|space)|office building|warehouse|industrial (property|building))/i
// "Occupancy"/"tenants" are NOT multi-unit: a rented single-family home has
// both. Unit counts, apartments and "the building" are.
// Words that describe a dwelling. A template WITHOUT any asset-specific
// words ("do you still own {address}?") is true of every property and is
// eligible everywhere; one that calls it a house is residential-only.
const RESIDENTIAL_WORDS = /(\bhouses?\b|\bhomes?\b|\bcasas?\b|\bhogar\b|\bresidence\b|\bbedrooms?\b|\bbathrooms?\b|\bbackyard\b|\bsingle[\s-]?family\b)/i

const MULTI_UNIT_WORDS = /(\{\{?\s*unit_count\s*\}?\}|\bunits?\b|\bunidades?\b|\bapartments?\b|\bapartamentos?\b|\bmulti[\s-]?family\b|\bbuilding\b)/i

/**
 * What a template requires of the property.
 *   { kind: 'commercial', groups }  — only these commercial groups
 *   { kind: 'multi_unit', groups }  — only these multi-unit groups
 *   { kind: 'land' }
 *   { kind: 'residential' }         — calls it a house/home: residential only
 *   { kind: 'generic' }             — no asset words: any property
 */
// Address designators inside a rendered body ("4157 Pillsbury Ave S Unit B",
// "Apt 4", "Suite 200", "#12") name a door, not a multi-unit pitch. They are
// removed before the words are judged — the only false positive the rule
// produced over the last 600 delivered production messages.
const ADDRESS_DESIGNATOR = /\b(?:unit|apt|apartment|suite|ste|bldg|building|lot|space|spc)\b[\s.#]+(?:[a-z]?\d[\w-]*|[a-z])\b(?![\s-]*(?:is|are|was|were|rent|rents|total|occupied|filled)\b)|#\s*\w+/gi

export function templateAssetRequirement(template = {}) {
  const t = template || {}
  const scope = lower(t.property_type_scope)
  const stage = lower(t.stage_code)
  const body = String(t.template_body ?? t.body ?? t.text ?? '').replace(ADDRESS_DESIGNATOR, ' ')

  if (/storage/.test(scope) || STORAGE_WORDS.test(body)) return { kind: 'commercial', groups: ['self_storage'], basis: 'self_storage' }
  if (/(retail|strip)/.test(scope) || RETAIL_WORDS.test(body)) return { kind: 'commercial', groups: ['retail'], basis: 'retail' }
  if (/(commercial|office|industrial|warehouse|hotel|motel)/.test(scope) || COMMERCIAL_WORDS.test(body)) {
    return { kind: 'commercial', groups: [...COMMERCIAL_GROUPS], basis: 'commercial' }
  }
  if (/(^|\b)land\b|vacant/.test(scope)) return { kind: 'land', basis: 'land' }

  // Multi-unit: the unit type the body names wins; otherwise any 2+ unit
  // group. A 5+-Units scope is multi-unit by declaration even when a variant
  // happens to avoid the word "units".
  if (/\bduplex\b|\bd[uú]plex\b/i.test(body)) return { kind: 'multi_unit', groups: ['duplex'], basis: 'duplex' }
  if (/\btriplex\b|\btr[ií]plex\b/i.test(body)) return { kind: 'multi_unit', groups: ['triplex'], basis: 'triplex' }
  if (/(\bfourplex\b|\bquadplex\b|4[\s-]?plex)/i.test(body)) return { kind: 'multi_unit', groups: ['fourplex'], basis: 'fourplex' }
  if (/5\+|five\s*\+/.test(scope)) return { kind: 'multi_unit', groups: ['small_multifamily', 'multifamily_5_plus'], basis: '5_plus_units' }
  if (/^mf\d/.test(stage) || MULTI_UNIT_WORDS.test(body)) return { kind: 'multi_unit', groups: [...MULTI_UNIT_GROUPS], basis: 'multi_unit_language' }

  if (RESIDENTIAL_WORDS.test(body)) return { kind: 'residential', basis: 'residential_language' }
  return { kind: 'generic', basis: 'generic' }
}

/**
 * The one compatibility decision.
 * @returns {{ compatible: boolean, reason: string, propertyGroup: string, templateScope: string, requirement: object }}
 */
export function isTemplateCompatibleWithProperty({ template, property, propertyGroup } = {}) {
  const group = propertyGroup && KNOWN_GROUPS.has(propertyGroup) ? propertyGroup : canonicalPropertyGroupOf(property)
  const req = templateAssetRequirement(template)
  const templateScope = String(template?.property_type_scope ?? '') || req.basis
  const out = (compatible, reason) => ({ compatible, reason, propertyGroup: group, templateScope, requirement: req })

  const prohibited = Array.isArray(template?.prohibited_property_groups) ? template.prohibited_property_groups.map(lower) : []
  if (prohibited.includes(group)) return out(false, 'property_group_prohibited_by_template')

  switch (req.kind) {
    case 'commercial':
      return req.groups.includes(group)
        ? out(true, 'commercial_template_matches_property')
        : out(false, `commercial_template_${req.basis}_on_${group}_property`)
    case 'land':
      return group === 'land' ? out(true, 'land_template_matches_property') : out(false, `land_template_on_${group}_property`)
    case 'multi_unit':
      return req.groups.includes(group)
        ? out(true, 'multi_unit_template_matches_property')
        : out(false, `multi_unit_template_${req.basis}_on_${group}_property`)
    case 'residential':
      if (RESIDENTIAL_GROUPS.includes(group) || group === 'residential') return out(true, 'residential_template_on_residential_property')
      if (group === 'unknown') return out(true, 'residential_template_property_group_unknown')
      return out(false, `residential_template_on_${group}_property`)
    default:
      // No asset-specific words: true of any property.
      return out(true, 'generic_template')
  }
}

/** Filter a candidate list; the reasons travel with it for diagnostics. */
export function filterTemplatesForProperty(templates = [], { property, propertyGroup } = {}) {
  const kept = []
  const rejected = []
  for (const template of templates || []) {
    const decision = isTemplateCompatibleWithProperty({ template, property, propertyGroup })
    if (decision.compatible) kept.push(template)
    else rejected.push({ template_id: template?.template_id ?? template?.id ?? null, reason: decision.reason })
  }
  return { kept, rejected }
}
