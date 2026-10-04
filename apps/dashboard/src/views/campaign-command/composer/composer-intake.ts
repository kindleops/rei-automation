/**
 * CAMPAIGN COMPOSER 2.0 — how an audience arrives.
 *
 * Every source resolves to canonical ids or backend-supported filters; a label
 * is never parsed into identity (8.2 identity rule).
 *
 *   URL      ?compose=1                         blank composition
 *            ?compose=1&campaign=<id>           open a draft (Map area / Entity Graph hand-offs land as drafts)
 *            ?campaign=<id>&builder=edit        the legacy deep link, same
 *            ?compose=1&property_ids=a,b,c      an explicit selection
 *            ?compose=1&market=Dallas, TX       a market (several: Dallas, TX|Minneapolis, MN)
 *            ?compose=1&geo_level=zip&geo=55411[&geo_state=MN]&label=…
 *                                               a geography from Market Intelligence: zip | city |
 *                                               county | state → the canonical location filter only
 *   Drop     application/x-leadcommand-objects  ObjectRef[] (8.2 registry refs)
 *            text/uri-list | text/plain         canonical deep links from the registry:
 *                                               /deal-intelligence?property_id=…  (property)
 *                                               /campaign-command?campaign=…      (campaign → its draft)
 */

export const COMPOSER_OBJECTS_MIME = 'application/x-leadcommand-objects'

export type Intake =
  | { kind: 'blank' }
  | { kind: 'draft'; campaignId: string }
  | { kind: 'properties'; propertyIds: string[]; label: string }
  | { kind: 'market'; market: string; markets: string[] }
  | { kind: 'geography'; level: GeoIntakeLevel; values: string[]; state: string | null; label: string }

export type GeoIntakeLevel = 'zip' | 'city' | 'county' | 'state'
const GEO_LEVELS: readonly GeoIntakeLevel[] = ['zip', 'city', 'county', 'state']
/** The canonical property field each geography level filters (the catalog's Location & Market fields). */
export const GEO_INTAKE_FIELD: Record<GeoIntakeLevel, { fieldKey: string; label: string }> = {
  zip: { fieldKey: 'properties.property_address_zip', label: 'ZIP' },
  city: { fieldKey: 'properties.property_address_city', label: 'City' },
  county: { fieldKey: 'properties.property_address_county_name', label: 'County' },
  state: { fieldKey: 'properties.property_address_state', label: 'State' },
}

const ids = (raw: string | null) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/** The Composer intent a route location states, or null when it states none. */
export function intakeFromLocation(location: string): Intake | null {
  const q = new URLSearchParams(location.includes('?') ? location.slice(location.indexOf('?') + 1) : '')
  const compose = q.get('compose') === '1'
  const builder = q.get('builder')
  const campaign = q.get('campaign')
  if (campaign && (compose || builder === 'edit' || builder === 'build')) return { kind: 'draft', campaignId: campaign }
  if (!compose) return null
  const props = ids(q.get('property_ids'))
  if (props.length) return { kind: 'properties', propertyIds: props, label: q.get('label') || `${props.length} selected ${props.length === 1 ? 'property' : 'properties'}` }
  const markets = (q.get('market') ?? '').split('|').map((m) => m.trim()).filter(Boolean)
  if (markets.length) return { kind: 'market', market: markets.join(' + '), markets }
  const level = q.get('geo_level') as GeoIntakeLevel | null
  const values = (q.get('geo') ?? '').split('|').map((v) => v.trim()).filter(Boolean)
  if (level && GEO_LEVELS.includes(level) && values.length) {
    const ok = level === 'zip' ? values.every((v) => /^\d{5}$/.test(v)) : level === 'state' ? values.every((v) => /^[A-Z]{2}$/.test(v)) : true
    const state = (q.get('geo_state') ?? '').trim().toUpperCase() || null
    if (ok && (level === 'zip' || level === 'state' || (state && /^[A-Z]{2}$/.test(state)))) {
      return { kind: 'geography', level, values, state, label: q.get('label') || `${GEO_INTAKE_FIELD[level].label} ${values.join(' + ')}` }
    }
  }
  return { kind: 'blank' }
}

type RefLike = { type?: string; id?: string; label?: string | null; hint?: Record<string, string> | null }

/** A dropped payload, resolved to what the Composer can use — and what it can't, with the reason. */
export type DropResolution = { propertyIds: string[]; campaignIds: string[]; ignored: Array<{ label: string; reason: string }> }

function fromUrl(raw: string, out: DropResolution) {
  let url: URL
  try { url = new URL(raw.trim(), 'https://lc.local') } catch { return }
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '/deal-intelligence' && url.searchParams.get('property_id')) out.propertyIds.push(url.searchParams.get('property_id')!)
  else if (path === '/campaign-command' && url.searchParams.get('campaign')) out.campaignIds.push(url.searchParams.get('campaign')!)
  else if (path === '/inbox' && url.searchParams.get('thread')) out.ignored.push({ label: 'Seller thread', reason: 'A thread carries no property id here — drop the property instead' })
  else if (raw.trim().startsWith('/') || raw.includes('://')) out.ignored.push({ label: path || raw, reason: 'Not a property or campaign link' })
}

function fromRef(ref: RefLike, out: DropResolution) {
  const hint = ref.hint ?? {}
  const pid = hint.property_id || (ref.type === 'property' ? ref.id : null)
  if (ref.type === 'campaign' && ref.id) out.campaignIds.push(hint.campaign_id || ref.id)
  else if (pid) out.propertyIds.push(String(pid))
  else out.ignored.push({ label: ref.label || ref.type || 'object', reason: `A ${ref.type ?? 'object'} without a property can't join an audience` })
}

/** Resolve a DataTransfer-shaped getter. Pure (tests pass a map). */
export function resolveDrop(get: (type: string) => string, types: readonly string[]): DropResolution {
  const out: DropResolution = { propertyIds: [], campaignIds: [], ignored: [] }
  if (types.includes(COMPOSER_OBJECTS_MIME)) {
    try {
      const parsed = JSON.parse(get(COMPOSER_OBJECTS_MIME))
      for (const ref of Array.isArray(parsed) ? parsed : [parsed]) if (ref && typeof ref === 'object') fromRef(ref as RefLike, out)
    } catch { out.ignored.push({ label: 'Dropped objects', reason: 'Unreadable payload' }) }
  } else {
    const text = types.includes('text/uri-list') ? get('text/uri-list') : types.includes('text/plain') ? get('text/plain') : ''
    for (const line of text.split(/\r?\n/)) if (line.trim() && !line.startsWith('#')) fromUrl(line, out)
  }
  out.propertyIds = [...new Set(out.propertyIds)]
  out.campaignIds = [...new Set(out.campaignIds)]
  return out
}

/** Can this drag carry something the Composer accepts? (dragover can't read data, only types.) */
export function dragLooksAcceptable(types: readonly string[]): boolean {
  return types.includes(COMPOSER_OBJECTS_MIME) || types.includes('text/uri-list') || types.includes('text/plain')
}

/** For surfaces that want to make their objects draggable into the Composer. */
export function composerDragData(refs: RefLike[]): Record<string, string> {
  return { [COMPOSER_OBJECTS_MIME]: JSON.stringify(refs), 'text/plain': refs.map((r) => r.label || r.id).join('\n') }
}
