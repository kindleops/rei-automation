import { FAMILIES, colsOf, deriveLayout, firstFit, sanitize, boardRows, type Bounds, type Cell, type Family, type GridItem } from './home-grid'
import { SIZE_CELLS, WIDGET_SIZES, type ContextMode, type PinnedSubject, type WidgetSize } from './widget-registry'

/**
 * HOME LAYOUT DOCUMENT — what is persisted for one saved board.
 *
 * Operator-private, versioned and separate from theme / sound / environment
 * settings. Widget instances carry their own stable id, type, owner app,
 * geometry per width family, size mode, config (with its version), context
 * (global / pinned / linked), refresh override, lock and stack membership.
 *
 * Unknown widget types are KEPT (a widget can be unregistered by a feature
 * flag and come back); the board renders them as a safe placeholder.
 */

export const HOME_SCHEMA_VERSION = 1

export interface WidgetInstance {
  id: string
  type: string
  ownerApp: string
  /** the size the operator last chose (the rendered mode is derived from the footprint) */
  size: WidgetSize
  geometry: Partial<Record<Family, Cell>>
  config: Record<string, unknown>
  configVersion: number
  context: { mode: ContextMode; subject: PinnedSubject | null }
  /** operator refresh override in ms; null = the widget's own cadence */
  refreshMs: number | null
  locked: boolean
  /** tab-stack membership (reserved; stacks are deferred) */
  stack: string | null
}

export type PresetId = 'command' | 'acquisitions' | 'intelligence' | 'closings' | 'minimal'

export interface HomeLayout {
  id: string
  name: string
  isDefault: boolean
  profile: 'desktop'
  schemaVersion: number
  /** bumped on every saved change; the server refuses a write based on an older one */
  revision: number
  preset: PresetId | null
  widgets: WidgetInstance[]
  /** the family the operator last arranged in — the source other widths derive from */
  primaryFamily: Family | null
  createdAt: string
  updatedAt: string
}

let seq = 0
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

const s = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const isFamily = (v: unknown): v is Family => typeof v === 'string' && (FAMILIES as readonly string[]).includes(v)
const isSize = (v: unknown): v is WidgetSize => typeof v === 'string' && (WIDGET_SIZES as readonly string[]).includes(v)
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/

function cellOf(v: unknown): Cell | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const n = (k: string) => (typeof c[k] === 'number' && Number.isFinite(c[k] as number) ? Math.round(c[k] as number) : null)
  const x = n('x'), y = n('y'), w = n('w'), h = n('h')
  if (x === null || y === null || w === null || h === null || w < 1 || h < 1) return null
  return { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(64, w), h: Math.min(48, h) }
}

function subjectOf(v: unknown): PinnedSubject | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const kind = s(o.kind, 20)
  const id = s(o.id, 200)
  const label = s(o.label, 160)
  const kinds = ['campaign', 'market', 'property', 'workflow', 'closing', 'deal', 'seller']
  if (!kind || !kinds.includes(kind) || !id) return null
  return { kind: kind as PinnedSubject['kind'], id, label: label ?? id }
}

function instanceOf(v: unknown): WidgetInstance | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = s(o.id, 64)
  const type = s(o.type, 50)
  if (!id || !ID_RE.test(id) || !type) return null
  const geometry: Partial<Record<Family, Cell>> = {}
  if (o.geometry && typeof o.geometry === 'object') {
    for (const [k, c] of Object.entries(o.geometry as Record<string, unknown>)) { const cell = cellOf(c); if (isFamily(k) && cell) geometry[k] = cell }
  }
  const ctx = (o.context && typeof o.context === 'object' ? o.context : {}) as Record<string, unknown>
  const mode: ContextMode = ctx.mode === 'pinned' || ctx.mode === 'linked' ? ctx.mode : 'global'
  const subject = subjectOf(ctx.subject)
  const config: Record<string, unknown> = {}
  if (o.config && typeof o.config === 'object' && !Array.isArray(o.config)) {
    for (const [k, val] of Object.entries(o.config as Record<string, unknown>)) {
      if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') config[k.slice(0, 40)] = typeof val === 'string' ? val.slice(0, 200) : val
    }
  }
  const refresh = typeof o.refreshMs === 'number' && Number.isFinite(o.refreshMs) ? Math.min(3_600_000, Math.max(15_000, o.refreshMs)) : null
  return {
    id,
    type,
    ownerApp: s(o.ownerApp, 40) ?? 'home',
    size: isSize(o.size) ? o.size : 'medium',
    geometry,
    config,
    configVersion: typeof o.configVersion === 'number' && o.configVersion >= 1 ? Math.floor(o.configVersion) : 1,
    // a pinned widget without a subject is honestly global
    context: { mode: mode === 'pinned' && !subject ? 'global' : mode, subject: mode === 'pinned' ? subject : null },
    refreshMs: refresh,
    locked: o.locked === true,
    stack: s(o.stack, 64),
  }
}

/**
 * Read any stored layout into the current schema. Returns null only when the
 * input is not a layout at all. Older schema versions are lifted here, one
 * step at a time; the widget configs are lifted by their own widgets.
 */
export function migrateLayout(raw: unknown): HomeLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const o = { ...(raw as Record<string, unknown>) }
  const version = typeof o.schemaVersion === 'number' ? o.schemaVersion : 0
  // v0 (pre-release drafts): instances lived under `items` with a single `cell`
  if (version < 1 && Array.isArray(o.items) && !Array.isArray(o.widgets)) {
    o.widgets = (o.items as Array<Record<string, unknown>>).map((it) => ({ ...it, geometry: it.cell ? { standard: it.cell } : {} }))
  }
  const id = s(o.id, 64)
  if (!id || !ID_RE.test(id)) return null
  const seen = new Set<string>()
  const widgets = (Array.isArray(o.widgets) ? o.widgets : []).map(instanceOf).filter((w): w is WidgetInstance => {
    if (!w || seen.has(w.id)) return false
    seen.add(w.id)
    return true
  }).slice(0, 64)
  const presets: PresetId[] = ['command', 'acquisitions', 'intelligence', 'closings', 'minimal']
  const now = new Date().toISOString()
  return {
    id,
    name: s(o.name, 80) ?? 'Home',
    isDefault: o.isDefault === true,
    profile: 'desktop',
    schemaVersion: HOME_SCHEMA_VERSION,
    revision: typeof o.revision === 'number' && o.revision >= 0 ? Math.floor(o.revision) : 0,
    preset: presets.includes(o.preset as PresetId) ? (o.preset as PresetId) : null,
    widgets,
    primaryFamily: isFamily(o.primaryFamily) ? o.primaryFamily : null,
    createdAt: s(o.createdAt, 40) ?? now,
    updatedAt: s(o.updatedAt, 40) ?? now,
  }
}

/* ── geometry per family ──────────────────────────────────────────────── */

/**
 * The arrangement for a width family: its own stored geometry when the
 * operator arranged at this width, else derived (same reading order) from the
 * family they last arranged in. Widgets added since are appended in reading
 * order. Always valid: inside the grid, inside bounds, never overlapping.
 */
export function itemsFor(layout: HomeLayout, family: Family, boundsOf: (type: string) => Bounds | undefined): GridItem[] {
  const cols = colsOf(family)
  const bounds = (id: string) => { const w = layout.widgets.find((x) => x.id === id); return w ? boundsOf(w.type) : undefined }
  const own = layout.widgets.filter((w) => w.geometry[family])
  const sourceFamily = pickSource(layout, family)
  let base: GridItem[]
  if (own.length && own.length === layout.widgets.length) {
    base = own.map((w) => ({ id: w.id, cell: w.geometry[family]!, locked: w.locked }))
  } else if (own.length) {
    base = own.map((w) => ({ id: w.id, cell: w.geometry[family]!, locked: w.locked }))
    base = sanitize(base, cols, bounds)
    for (const w of layout.widgets) {
      if (w.geometry[family]) continue
      const src = (sourceFamily && w.geometry[sourceFamily]) || defaultCell(w)
      base.push({ id: w.id, cell: firstFit(base, Math.min(cols, src.w), src.h, cols, Math.max(0, boardRows(base) - src.h)), locked: false })
    }
  } else if (sourceFamily) {
    const src = layout.widgets.map((w) => ({ id: w.id, cell: w.geometry[sourceFamily] ?? { ...defaultCell(w), x: 0, y: 999 } }))
    // locks are a per-arrangement decision; a derived arrangement starts unlocked
    base = deriveLayout(src, cols, bounds)
  } else {
    base = []
    for (const w of layout.widgets) { const d = defaultCell(w); base.push({ id: w.id, cell: firstFit(base, Math.min(cols, d.w), d.h, cols), locked: false }) }
  }
  return sanitize(base, cols, bounds)
}

function pickSource(layout: HomeLayout, family: Family): Family | null {
  const counts = FAMILIES.filter((f) => f !== family).map((f) => [f, layout.widgets.filter((w) => w.geometry[f]).length] as const).filter(([, n]) => n > 0)
  if (!counts.length) return null
  if (layout.primaryFamily && layout.primaryFamily !== family && counts.some(([f]) => f === layout.primaryFamily)) return layout.primaryFamily
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

const defaultCell = (w: WidgetInstance): Cell => ({ x: 0, y: 0, ...SIZE_CELLS[w.size] })

/** Store an arrangement for a family (the operator arranged here: it becomes the primary). */
export function withGeometry(layout: HomeLayout, family: Family, items: readonly GridItem[]): HomeLayout {
  const byId = new Map(items.map((i) => [i.id, i]))
  return {
    ...layout,
    primaryFamily: family,
    widgets: layout.widgets.map((w) => {
      const it = byId.get(w.id)
      return it ? { ...w, geometry: { ...w.geometry, [family]: { ...it.cell } }, locked: Boolean(it.locked) } : w
    }),
  }
}

/* ── instance operations (pure) ───────────────────────────────────────── */

export interface NewWidget {
  type: string
  ownerApp: string
  size: WidgetSize
  config?: Record<string, unknown>
  configVersion?: number
  context?: { mode: ContextMode; subject: PinnedSubject | null }
}

/** Add an instance, placed in the current family (at `at` when given, else the first free spot from the top). */
export function addInstance(layout: HomeLayout, w: NewWidget, family: Family, items: readonly GridItem[], at?: Cell): { layout: HomeLayout; id: string } {
  const id = newId('w')
  const cols = colsOf(family)
  const d = SIZE_CELLS[w.size]
  const cell = at ? { ...at } : firstFit(items, Math.min(cols, d.w), d.h, cols)
  const inst: WidgetInstance = {
    id,
    type: w.type,
    ownerApp: w.ownerApp,
    size: w.size,
    geometry: { [family]: cell },
    config: { ...(w.config ?? {}) },
    configVersion: w.configVersion ?? 1,
    context: w.context ?? { mode: 'global', subject: null },
    refreshMs: null,
    locked: false,
    stack: null,
  }
  return { layout: { ...layout, widgets: [...layout.widgets, inst] }, id }
}

export function removeInstance(layout: HomeLayout, id: string): HomeLayout {
  return { ...layout, widgets: layout.widgets.filter((w) => w.id !== id) }
}

export function updateInstance(layout: HomeLayout, id: string, patch: Partial<Omit<WidgetInstance, 'id'>>): HomeLayout {
  return { ...layout, widgets: layout.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }
}

/** A copy with its own stable id and config, placed right after the original. */
export function duplicateInstance(layout: HomeLayout, id: string, family: Family, items: readonly GridItem[]): { layout: HomeLayout; id: string } | null {
  const src = layout.widgets.find((w) => w.id === id)
  const at = items.find((i) => i.id === id)
  if (!src || !at) return null
  const cols = colsOf(family)
  const cell = firstFit(items, at.cell.w, at.cell.h, cols, at.cell.y)
  const next = addInstance(layout, { type: src.type, ownerApp: src.ownerApp, size: src.size, config: src.config, configVersion: src.configVersion, context: src.context }, family, items, cell)
  return next
}

/* ── layouts ──────────────────────────────────────────────────────────── */

export function emptyLayout(name: string, now = new Date()): HomeLayout {
  const iso = now.toISOString()
  return { id: newId('l'), name, isDefault: false, profile: 'desktop', schemaVersion: HOME_SCHEMA_VERSION, revision: 0, preset: null, widgets: [], primaryFamily: null, createdAt: iso, updatedAt: iso }
}

export function copyLayout(src: HomeLayout, name: string, now = new Date()): HomeLayout {
  const iso = now.toISOString()
  const idMap = new Map(src.widgets.map((w) => [w.id, newId('w')]))
  return {
    ...src,
    id: newId('l'),
    name,
    isDefault: false,
    revision: 0,
    widgets: src.widgets.map((w) => ({ ...w, id: idMap.get(w.id)!, stack: w.stack ? idMap.get(w.stack) ?? null : null, geometry: { ...w.geometry }, config: { ...w.config } })),
    createdAt: iso,
    updatedAt: iso,
  }
}

/* ── presets (starting points, not modes) ─────────────────────────────── */

interface PresetSlot { type: string; ownerApp: string; size: WidgetSize; cell: Cell; config?: Record<string, unknown> }

export const PRESETS: Record<PresetId, { name: string; description: string; slots: PresetSlot[] }> = {
  command: {
    name: 'Command',
    description: 'The operation at a glance: the brief, what needs you, the map, inbox, pipeline, campaigns and signals.',
    slots: [
      { type: 'home.brief', ownerApp: 'home', size: 'wide', cell: { x: 0, y: 0, w: 8, h: 3 } },
      { type: 'home.focus', ownerApp: 'home', size: 'tall', cell: { x: 8, y: 0, w: 4, h: 7 } },
      { type: 'map.pulse', ownerApp: 'map', size: 'feature', cell: { x: 0, y: 3, w: 8, h: 6 } },
      { type: 'inbox.replies', ownerApp: 'inbox', size: 'medium', cell: { x: 8, y: 7, w: 4, h: 5 } },
      { type: 'pipeline.flow', ownerApp: 'pipeline', size: 'medium', cell: { x: 0, y: 9, w: 4, h: 4 } },
      { type: 'campaign.engine', ownerApp: 'campaign-command', size: 'medium', cell: { x: 4, y: 9, w: 4, h: 4 } },
      { type: 'signals.center', ownerApp: 'notifications', size: 'small', cell: { x: 8, y: 12, w: 4, h: 3 } },
    ],
  },
  acquisitions: {
    name: 'Acquisitions',
    description: 'Conversations to contracts: replies, the pipeline, offers in motion and the calendar.',
    slots: [
      { type: 'home.brief', ownerApp: 'home', size: 'wide', cell: { x: 0, y: 0, w: 8, h: 3 } },
      { type: 'calendar.agenda', ownerApp: 'calendar', size: 'small', cell: { x: 8, y: 0, w: 4, h: 3 } },
      { type: 'inbox.replies', ownerApp: 'inbox', size: 'large', cell: { x: 0, y: 3, w: 6, h: 6 } },
      { type: 'pipeline.flow', ownerApp: 'pipeline', size: 'large', cell: { x: 6, y: 3, w: 6, h: 6 } },
      { type: 'campaign.engine', ownerApp: 'campaign-command', size: 'medium', cell: { x: 0, y: 9, w: 4, h: 4 } },
      { type: 'map.pulse', ownerApp: 'map', size: 'medium', cell: { x: 4, y: 9, w: 4, h: 4 }, config: { lens: 'deals' } },
      { type: 'home.focus', ownerApp: 'home', size: 'medium', cell: { x: 8, y: 9, w: 4, h: 4 } },
    ],
  },
  intelligence: {
    name: 'Intelligence',
    description: 'How the machine performs: metrics, the market field, automation and signals.',
    slots: [
      { type: 'analytics.metric', ownerApp: 'analytics', size: 'wide', cell: { x: 0, y: 0, w: 8, h: 3 }, config: { metric: 'replied', period: '30d', display: 'chart' } },
      { type: 'analytics.metric', ownerApp: 'analytics', size: 'small', cell: { x: 8, y: 0, w: 4, h: 3 }, config: { metric: 'reply_rate', period: '30d', display: 'number' } },
      { type: 'map.pulse', ownerApp: 'map', size: 'feature', cell: { x: 0, y: 3, w: 8, h: 6 }, config: { lens: 'buyers', range: '30d' } },
      { type: 'signals.center', ownerApp: 'notifications', size: 'medium', cell: { x: 8, y: 3, w: 4, h: 4 } },
      { type: 'workflow.runs', ownerApp: 'workflow-studio', size: 'medium', cell: { x: 8, y: 7, w: 4, h: 4 } },
      { type: 'machine.feed', ownerApp: 'workflow-studio', size: 'wide', cell: { x: 0, y: 9, w: 8, h: 4 } },
    ],
  },
  closings: {
    name: 'Closings',
    description: 'Contracts to closed: the desk, milestones, documents by email and the calendar.',
    slots: [
      { type: 'closing.desk', ownerApp: 'closing-desk', size: 'large', cell: { x: 0, y: 0, w: 6, h: 6 } },
      { type: 'calendar.agenda', ownerApp: 'calendar', size: 'tall', cell: { x: 6, y: 0, w: 3, h: 7 } },
      { type: 'home.focus', ownerApp: 'home', size: 'tall', cell: { x: 9, y: 0, w: 3, h: 7 } },
      { type: 'email.command', ownerApp: 'email-command', size: 'medium', cell: { x: 0, y: 6, w: 6, h: 4 } },
      { type: 'pipeline.flow', ownerApp: 'pipeline', size: 'medium', cell: { x: 6, y: 7, w: 6, h: 4 } },
    ],
  },
  minimal: {
    name: 'Minimal',
    description: 'Calm: the brief and what needs you. Nothing else until you add it.',
    slots: [
      { type: 'home.brief', ownerApp: 'home', size: 'wide', cell: { x: 0, y: 0, w: 8, h: 3 } },
      { type: 'home.focus', ownerApp: 'home', size: 'medium', cell: { x: 8, y: 0, w: 4, h: 5 } },
    ],
  },
}

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[]

/** A new layout from a preset (geometry authored for the standard grid; other widths derive). */
export function layoutFromPreset(preset: PresetId, opts: { name?: string; isDefault?: boolean; now?: Date } = {}): HomeLayout {
  const base = emptyLayout(opts.name ?? PRESETS[preset].name, opts.now)
  const widgets: WidgetInstance[] = PRESETS[preset].slots.map((slot) => ({
    id: newId('w'),
    type: slot.type,
    ownerApp: slot.ownerApp,
    size: slot.size,
    geometry: { standard: { ...slot.cell } },
    config: { ...(slot.config ?? {}) },
    configVersion: 1,
    context: { mode: 'global', subject: null },
    refreshMs: null,
    locked: false,
    stack: null,
  }))
  return { ...base, preset, isDefault: opts.isDefault ?? false, widgets, primaryFamily: 'standard' }
}
