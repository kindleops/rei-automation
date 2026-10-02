/**
 * MAP DESKTOP 2.0 — the pure model behind the desk chrome.
 *
 * Everything the desktop Map says about itself is decided here, from state the
 * Map already holds: which tools the rail offers (and which it deliberately
 * does not), what the lens pill and the filter capsule read, how a cohort is
 * expressed against the universe, which layers the sensor array can offer and
 * what each one really supports, and what a click on a property does to the
 * card. Nothing here fetches, and nothing here invents a number: an unknown
 * stays unknown (null) and the UI says so.
 */

// ── The tool rail ────────────────────────────────────────────────────────────

export type DeskTool = 'layers' | 'filters' | 'draw' | 'live' | 'appearance'

export interface DeskToolSpec {
  id: DeskTool
  label: string
  /** inspector = docks left, popover = transient beside the rail, toggle = a mode. */
  kind: 'inspector' | 'popover' | 'toggle'
}

/**
 * The rail, in order. There is deliberately NO measure tool: the Map has no
 * measuring instrument (the circle draw reports a radius as part of an area,
 * not as a ruler), and a rail button that did nothing would be a lie.
 */
export const DESK_TOOLS: ReadonlyArray<DeskToolSpec> = [
  { id: 'layers', label: 'Layers', kind: 'inspector' },
  { id: 'filters', label: 'Filters', kind: 'inspector' },
  { id: 'draw', label: 'Draw an area', kind: 'toggle' },
  { id: 'live', label: 'Live Activity', kind: 'inspector' },
  { id: 'appearance', label: 'Appearance', kind: 'popover' },
]

// ── Numbers, honestly formatted ─────────────────────────────────────────────

/** "12,408" — null stays null (the caller shows its own "unknown"). */
export const fmtCount = (n: number | null | undefined): string | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : null

/**
 * A cohort as a share of the property universe: "10.9%", "<0.1%", "100%".
 * Null when either side is unknown — a percentage of a guessed universe is a
 * guess, so it is never shown.
 */
export function shareOfUniverse(matching: number | null | undefined, universe: number | null | undefined): string | null {
  if (typeof matching !== 'number' || typeof universe !== 'number' || !Number.isFinite(matching) || !Number.isFinite(universe) || universe <= 0 || matching < 0) return null
  const pct = (matching / universe) * 100
  if (pct === 0) return '0%'
  if (pct < 0.1) return '<0.1%'
  if (pct >= 99.95 && matching < universe) return '>99.9%'
  if (pct < 10) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

/** The applied-filter capsule: "7 filters · 18,492 properties". */
export function filterCapsuleLabel(rules: number, matching: number | null | undefined): string {
  const r = `${rules} filter${rules === 1 ? '' : 's'}`
  const m = fmtCount(matching)
  return m ? `${r} · ${m} ${matching === 1 ? 'property' : 'properties'}` : r
}

export interface MarketShare { market: string; n: number; share: number }

/**
 * By-market split of a cohort from the map's own market aggregates (the
 * filtered /ops/map national read). Rows without a name or a count are
 * dropped; the share is of the rows returned, never of an assumed total.
 */
export function topMarkets(features: ReadonlyArray<{ properties?: Record<string, unknown> | null }>, limit = 5): { rows: MarketShare[]; total: number; markets: number } {
  const byMarket = new Map<string, number>()
  for (const f of features) {
    const p = f?.properties ?? {}
    const name = String(p.market ?? '').trim()
    const n = Number(p.property_count ?? p.point_count ?? 0)
    if (!name || !Number.isFinite(n) || n <= 0) continue
    byMarket.set(name, (byMarket.get(name) ?? 0) + n)
  }
  const total = [...byMarket.values()].reduce((a, b) => a + b, 0)
  const rows = [...byMarket.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([market, n]) => ({ market, n, share: total ? n / total : 0 }))
  return { rows, total, markets: byMarket.size }
}

// ── The lens pill ────────────────────────────────────────────────────────────

/**
 * LIVE means data is actually flowing: the realtime stream is subscribed.
 * Markers on with the stream down is "connecting", not live.
 */
export type LiveSignal = 'live' | 'connecting' | 'off'
export function liveSignal({ streamLive, activityOn }: { streamLive: boolean; activityOn: boolean }): LiveSignal {
  if (streamLive) return 'live'
  return activityOn ? 'connecting' : 'off'
}

/** The pill's second line: properties in view, then the live window when Live is on. */
export function lensPillSub({ inView, loading, zoom, activityOn, eventCount, windowLabel }: {
  inView: number | null
  loading: boolean
  zoom: number
  activityOn: boolean
  eventCount: number
  windowLabel: string
}): string {
  const view = inView === null
    ? 'Loading properties…'
    : inView === 0
      ? (loading ? 'Updating…' : zoom < 9 ? 'Zoom in to see properties' : 'No properties in this view')
      : `${inView.toLocaleString('en-US')} in view${loading ? ' · updating' : ''}`
  if (!activityOn) return view
  const w = windowLabel.toLowerCase()
  const when = w === 'all' ? '' : w === 'today' ? ' today' : ` in ${w}`
  return `${view} · ${eventCount.toLocaleString('en-US')} event${eventCount === 1 ? '' : 's'}${when}`
}

// ── Clicking a property on the desk ─────────────────────────────────────────

export type DeskCardState = 'preview' | 'half' | 'full' | 'conversation'
export type DeskPinClick = 'preview' | 'promote' | 'keep'

/**
 * First click on a property opens its PREVIEW. A click on the same property
 * while it shows PREVIEW opens HALF. A property already open wider (HALF, FULL,
 * or its conversation) is left exactly as it is — a click never demotes a
 * selected card back to a hover.
 */
export function resolveDeskPinClick({ sameProperty, cardState }: { sameProperty: boolean; cardState: DeskCardState | null }): DeskPinClick {
  if (!sameProperty) return 'preview'
  if (cardState === 'preview' || cardState === null) return 'promote'
  return 'keep'
}

// ── The sensor array (Layers) ───────────────────────────────────────────────

export type SensorGroupId = 'properties' | 'market' | 'boundaries' | 'world' | 'operations'
export type SensorStatus = 'live' | 'on' | 'waiting' | 'off' | 'unavailable'

export interface SensorRow {
  id: string
  label: string
  /** One line: what it draws and where the data comes from. */
  sub: string
  status: SensorStatus
  on: boolean
  /** False = shown disabled, with `reason`. */
  available: boolean
  reason?: string
  /** Which controls this layer genuinely supports. */
  supports: { visibility: boolean; opacity: boolean; style: boolean; time: boolean }
}

export interface SensorGroup { id: SensorGroupId; label: string; rows: SensorRow[] }

export interface SensorInput {
  pins: boolean
  everyProperty: boolean
  /** A filter is applied: the dot tiles cannot carry it, so dots pause. */
  filterActive: boolean
  lensId: string
  lensLabel: string
  /** The lens's own one-line meaning (map-lenses). */
  lensSub?: string
  lensHasSource: boolean
  lensAmbient: boolean
  comps: boolean
  market: boolean
  daylight: boolean
  localTime: boolean
  zones: boolean
  livingEnabled: boolean
  buildings: boolean
  tilted: boolean
  /** The theme has vector building data (CARTO); imagery themes do not. */
  vectorBuildings: boolean
  relief: boolean
  activityOn: boolean
  streamLive: boolean
  orbs: boolean
  /** Boundary overlay levels: on, and the server's answer for the current view. */
  boundaryState?: BoundaryRowInput
  boundaryZip?: BoundaryRowInput
}

/** What the boundary hook knows about one level (useMapBoundaries). */
export interface BoundaryRowInput { on: boolean; state: 'off' | 'loading' | 'on' | 'waiting' | 'unavailable'; count: number; reason: string | null }

function boundaryRow(id: 'boundaryState' | 'boundaryZip', label: string, sub: string, b: BoundaryRowInput | undefined): SensorRow {
  const on = Boolean(b?.on)
  const status: SensorStatus = !on ? 'off' : b?.state === 'on' ? 'on' : b?.state === 'unavailable' ? 'unavailable' : 'waiting'
  return {
    id, label, sub: on && b?.state === 'on' ? `${b.count.toLocaleString('en-US')} in view · ${sub}` : sub,
    status, on, available: true, reason: on && b?.reason ? b.reason : undefined, supports: S(true),
  }
}

const S = (visibility: boolean, opacity = false, style = false, time = false) => ({ visibility, opacity, style, time })

export function buildSensorArray(s: SensorInput): SensorGroup[] {
  const living = (flag: boolean) => s.livingEnabled && flag
  return [
    {
      id: 'properties',
      label: 'Properties',
      rows: [
        {
          id: 'pins', label: 'Property pins', sub: 'Every property’s pin — asset shape and stage ring', status: s.pins ? 'on' : 'off', on: s.pins,
          available: true, supports: S(true, true, true),
        },
        {
          id: 'dots', label: 'Every property', sub: 'A dot for each property below pin zoom · dot tiles',
          status: !s.everyProperty ? 'off' : s.filterActive ? 'waiting' : 'on', on: s.everyProperty, available: true,
          reason: s.everyProperty && s.filterActive ? 'Paused while a filter is applied — the dot tiles can’t carry a filter, so the filtered cohort shows instead' : undefined,
          supports: S(true),
        },
      ],
    },
    {
      id: 'market',
      label: 'Market intelligence',
      rows: [
        {
          id: 'lens', label: 'Color lens', sub: s.lensHasSource ? `${s.lensLabel} · ${s.lensSub ?? 'colors the map by a stored value'}` : 'No color lens — markers only',
          status: s.lensHasSource ? 'on' : 'off', on: s.lensHasSource, available: true,
          supports: S(true, s.lensHasSource && !s.lensAmbient, s.lensHasSource && !s.lensAmbient),
        },
        {
          id: 'comps', label: 'Sold comps', sub: 'MLS, public-record and investor sales · buyer type flagged', status: s.comps ? 'on' : 'off', on: s.comps,
          available: true, supports: S(true, false, false, true),
        },
        {
          id: 'market', label: 'Market panel', sub: 'Census, HUD rent, price growth and flood for the ZIP at the centre', status: s.market ? 'on' : 'off', on: s.market,
          available: true, supports: S(true),
        },
      ],
    },
    {
      id: 'boundaries',
      label: 'Boundaries',
      rows: [
        boundaryRow('boundaryState', 'State lines', 'US Census state outlines · context over every lens', s.boundaryState),
        boundaryRow('boundaryZip', 'ZIP outlines', `US Census ZCTA outlines and codes · from zoom 9`, s.boundaryZip),
        // County, city and market outlines join this group when a real polygon
        // source exists; the database has none today (8.2 audit), so no row.
      ],
    },
    {
      id: 'world',
      label: 'Live world',
      rows: [
        {
          id: 'daylight', label: 'Real daylight', sub: 'Day, golden hour, twilight and night from the sun’s real position',
          status: living(s.daylight) ? 'on' : 'off', on: s.daylight, available: s.livingEnabled,
          reason: s.livingEnabled ? undefined : 'Living Map is off (Appearance)', supports: S(true),
        },
        {
          id: 'localTime', label: 'Local time & contact window', sub: 'Time where you’re looking, and whether sellers there can be contacted now',
          status: living(s.localTime) ? 'on' : 'off', on: s.localTime, available: s.livingEnabled,
          reason: s.livingEnabled ? undefined : 'Living Map is off (Appearance)', supports: S(true),
        },
        {
          id: 'zones', label: 'Zone clocks', sub: 'Every US zone’s time and contact window, at country zoom',
          status: living(s.zones) ? 'on' : 'off', on: s.zones, available: s.livingEnabled && s.localTime,
          reason: !s.livingEnabled ? 'Living Map is off (Appearance)' : !s.localTime ? 'Needs local time' : undefined, supports: S(true),
        },
        {
          id: 'buildings', label: '3D buildings', sub: 'Real heights from the map source — downtown cores; houses stay flat footprints',
          status: !living(s.buildings) ? 'off' : !s.vectorBuildings ? 'unavailable' : s.tilted ? 'on' : 'waiting', on: s.buildings,
          available: s.livingEnabled && s.vectorBuildings,
          reason: !s.livingEnabled ? 'Living Map is off (Appearance)' : !s.vectorBuildings ? 'This map style has no building data' : !s.tilted && s.buildings ? 'Shows when the map is tilted (3D)' : undefined,
          supports: S(true),
        },
        {
          id: 'relief', label: 'Terrain relief', sub: 'Shaded hills from real elevation; lifted into 3D while tilted', status: s.relief ? 'on' : 'off', on: s.relief,
          available: true, supports: S(true),
        },
        // Traffic cameras join this group when a camera source is connected
        // (CAM-D). Until then there is no row at all: the Map does not
        // advertise a sensor it cannot read (owner, 2026-09-30).
      ],
    },
    {
      id: 'operations',
      label: 'Operations',
      rows: [
        {
          id: 'activity', label: 'Live Activity', sub: 'Replies, stage moves, sends and deliveries where they happened',
          status: !s.activityOn ? 'off' : s.streamLive ? 'live' : 'waiting', on: s.activityOn, available: true,
          reason: s.activityOn && !s.streamLive ? 'Stream not connected — showing what the map already knows' : undefined,
          supports: S(true, false, false, true),
        },
        {
          id: 'orbs', label: 'Activity orbs', sub: 'A glow where something happened in the last 24 hours', status: s.orbs ? (s.streamLive ? 'live' : 'on') : 'off', on: s.orbs,
          available: true, supports: S(true),
        },
      ],
    },
  ]
}

/** "3 of 6 on" for a group header (unavailable rows don't count against it). */
export function groupTally(g: SensorGroup): string {
  const usable = g.rows.filter((r) => r.available)
  const on = usable.filter((r) => r.on && r.status !== 'off').length
  return `${on} of ${usable.length} on`
}

/** Opacity slider value (0.2–1) → a percent label. */
export const pctLabel = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`
export const clampOpacity = (v: unknown, fallback = 1): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0.2, n)) : fallback
}
