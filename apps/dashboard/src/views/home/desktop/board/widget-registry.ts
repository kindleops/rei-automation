import type { ComponentType } from 'react'
import type { IconName } from '../../../../shared/icons'

/**
 * HOME WIDGET REGISTRY — the developer contract (Home 2.0).
 *
 * Home never hard-codes widget behaviour. A widget is a purpose-built
 * instrument that registers what it is, which sizes it recomposes into, what
 * it can be configured with, where its data comes from and how it opens into
 * its owning app. The board only places, sizes, configures and persists
 * instances; it never knows what a widget renders.
 *
 * No arbitrary HTML and no iframes: a widget is a React component rendered
 * with LC primitives, and a future provider widget registers through this same
 * contract (with `connectionRequirements` saying whether it is connected).
 */

export type WidgetSize = 'compact' | 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'feature'

export const WIDGET_SIZES: readonly WidgetSize[] = ['compact', 'small', 'medium', 'large', 'wide', 'tall', 'feature']

/** Default footprint of each size, in grid units (columns × rows). */
export const SIZE_CELLS: Record<WidgetSize, { w: number; h: number }> = {
  compact: { w: 3, h: 2 },
  small: { w: 3, h: 3 },
  medium: { w: 4, h: 4 },
  large: { w: 6, h: 6 },
  wide: { w: 8, h: 3 },
  tall: { w: 4, h: 7 },
  feature: { w: 8, h: 6 },
}

export const SIZE_LABEL: Record<WidgetSize, string> = {
  compact: 'Compact', small: 'Small', medium: 'Medium', large: 'Large', wide: 'Wide', tall: 'Tall', feature: 'Feature',
}

/** The shape a footprint reads as (before the widget's own supported sizes narrow it). */
export function classifySize(w: number, h: number): WidgetSize {
  if (w >= 7) return h <= 4 ? 'wide' : 'feature'
  if (w >= 5) return h <= 3 ? 'wide' : 'large'
  if (w <= 3) return h <= 2 ? 'compact' : h >= 6 ? 'tall' : 'small'
  return h >= 6 ? 'tall' : h <= 2 ? 'compact' : 'medium'
}

/** The size a widget renders at for a footprint: the classified shape when supported, else the nearest supported one. */
export function sizeModeFor(w: number, h: number, supported: readonly WidgetSize[]): WidgetSize {
  const shape = classifySize(w, h)
  if (supported.includes(shape)) return shape
  let best = supported[0] ?? 'medium'
  let bestD = Infinity
  for (const s of supported) {
    const c = SIZE_CELLS[s]
    const d = Math.abs(c.w - w) * 1.4 + Math.abs(c.h - h)
    if (d < bestD) { best = s; bestD = d }
  }
  return best
}

/* ── context ──────────────────────────────────────────────────────────── */

/**
 *   global  the whole operation (the default)
 *   pinned  a fixed subject the operator chose (a campaign, a market) — it keeps it
 *   linked  follows the subject the workspace is on (used sparingly)
 */
export type ContextMode = 'global' | 'pinned' | 'linked'

export interface PinnedSubject {
  kind: 'campaign' | 'market' | 'property' | 'workflow' | 'closing' | 'deal' | 'seller'
  id: string
  label: string
}

/* ── configuration ────────────────────────────────────────────────────── */

export type ConfigField =
  | { key: string; kind: 'segmented'; label: string; options: ReadonlyArray<{ value: string; label: string }> }
  | { key: string; kind: 'select'; label: string; options: ReadonlyArray<{ value: string; label: string; hint?: string }>; /** options also come from a live list (validated there, not here) */ source?: 'markets' | 'campaigns' }
  | { key: string; kind: 'switch'; label: string; hint?: string }

export type WidgetConfig = Record<string, string | number | boolean | null>

/* ── instance + render props ──────────────────────────────────────────── */

export interface WidgetRenderProps<C extends WidgetConfig = WidgetConfig> {
  instanceId: string
  size: WidgetSize
  config: C
  context: { mode: ContextMode; subject: PinnedSubject | null }
  /** in view and the document visible — a widget loads and refreshes only while active */
  active: boolean
  /** a stable, small number of grid units — for widgets that lay out on width */
  cells: { w: number; h: number }
  editing: boolean
  setConfig: (patch: Partial<C>) => void
}

export interface WidgetAction { label: string; path: string }

export interface HomeWidgetDef<C extends WidgetConfig = WidgetConfig> {
  /** stable type id, persisted in layouts — never rename */
  id: string
  /** the app that owns the data and that Open lands in */
  ownerApp: string
  name: string
  icon: IconName
  description: string
  /** library grouping */
  domain: 'Command' | 'Communication' | 'Acquisitions' | 'Operations' | 'Intelligence' | 'Closings'
  sizes: readonly WidgetSize[]
  defaultSize: WidgetSize
  min?: { w: number; h: number }
  max?: { w: number; h: number }
  component: ComponentType<WidgetRenderProps<C>>
  configSchema?: ReadonlyArray<ConfigField>
  defaultConfig: C
  /** bump when the config shape changes; `migrateConfig` lifts an older config */
  configVersion?: number
  migrateConfig?: (config: Record<string, unknown>, fromVersion: number) => C
  /** context modes this widget honours (always includes 'global') */
  contexts?: readonly ContextMode[]
  /** what the widget reads, in operator words (shown in the library and settings) */
  data: string
  openAction: (props: { config: C; subject: PinnedSubject | null }) => WidgetAction | null
  openBesideAction?: (props: { config: C; subject: PinnedSubject | null }) => WidgetAction | null
  /** refresh cadence in ms, and the rail apps whose events refresh it early */
  refresh: { everyMs: number; events?: readonly string[] }
  emptyState: string
  loadingState?: 'metric' | 'lines' | 'chart'
  /** permission the operator needs (reserved: the console is single-operator today) */
  permissions?: readonly string[]
  /** a provider widget answers whether its connection exists; undefined = first-party, always connected */
  connectionRequirements?: () => { connected: boolean; reason?: string }
  /** feature flag name; a widget behind an off flag is not offered */
  featureFlag?: string
  /** heavyweight widgets cap their live instances per board */
  maxInstances?: number
  /** a cheap live line for the library, from data already in memory (never a fetch) */
  preview?: (metrics: LibraryMetrics | null) => string | null
}

/** What the library may show for free: the rail's resting telemetry. */
export interface LibraryMetrics {
  inbox?: { awaiting: number; needs_review: number } | null
  email?: { needs_you: number; system_handling: number; failed: number; sending_enabled: boolean } | null
  queue?: { today_remaining: number; sent_today: number | null; delivered_today: number | null; failed_today: number | null } | null
  campaigns?: { active: number; paused: number; scheduled: number; attention: number | null } | null
  pipeline?: { live: number; need_you: number; system: number; moved_today: number; blocked: number } | null
  workflow?: { live_runs: number; human_holds: number; events_today: number } | null
  closing?: { active: number; needs_you: number; blocked: number } | null
}

/* ── the registry ─────────────────────────────────────────────────────── */

const registry = new Map<string, HomeWidgetDef>()
const flags = new Map<string, boolean>()
let version = 0
const listeners = new Set<() => void>()

/** Register a widget type. Re-registering the same id replaces it (hot reload); ids are never reused for another widget. */
export function registerHomeWidget<C extends WidgetConfig>(def: HomeWidgetDef<C>): void {
  if (!def.id || !/^[a-z0-9][a-z0-9_.-]{1,48}$/.test(def.id)) throw new Error(`Invalid Home widget id: ${def.id}`)
  if (!def.sizes.length || !def.sizes.includes(def.defaultSize)) throw new Error(`Home widget ${def.id}: defaultSize must be one of its sizes`)
  registry.set(def.id, def as unknown as HomeWidgetDef)
  version += 1
  listeners.forEach((l) => l())
}

export const getHomeWidget = (id: string): HomeWidgetDef | null => registry.get(id) ?? null

/** Widgets the operator can add right now: registered, flag on. */
export function listHomeWidgets(): HomeWidgetDef[] {
  return [...registry.values()].filter((d) => !d.featureFlag || flags.get(d.featureFlag) === true)
}

export function setHomeWidgetFlag(flag: string, on: boolean) { flags.set(flag, on); version += 1; listeners.forEach((l) => l()) }

export const subscribeHomeWidgets = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const homeWidgetsVersion = () => version

/** Min / max footprint for a widget (its declared bounds, else its smallest / largest size). */
export function boundsOf(def: HomeWidgetDef): { min: { w: number; h: number }; max: { w: number; h: number } } {
  const cells = def.sizes.map((s) => SIZE_CELLS[s])
  const min = def.min ?? { w: Math.min(...cells.map((c) => c.w)), h: Math.min(...cells.map((c) => c.h)) }
  const max = def.max ?? { w: Math.max(...cells.map((c) => c.w)) + 4, h: Math.max(...cells.map((c) => c.h)) + 4 }
  return { min, max }
}

/** Config for an instance: defaults, then the stored values that still exist in the schema (migrated first). */
export function resolveConfig(def: HomeWidgetDef, stored: Record<string, unknown> | null | undefined, storedVersion: number | undefined): WidgetConfig {
  const fromVersion = storedVersion ?? 1
  const current = def.configVersion ?? 1
  const lifted = stored && fromVersion < current && def.migrateConfig ? def.migrateConfig(stored, fromVersion) : stored ?? {}
  const out: WidgetConfig = { ...def.defaultConfig }
  for (const [k, v] of Object.entries(lifted ?? {})) {
    if (!(k in def.defaultConfig)) continue
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const field = def.configSchema?.find((f) => f.key === k)
      const fixed = field && (field.kind === 'segmented' || (field.kind === 'select' && !field.source))
      if (fixed && typeof v === 'string' && !field.options.some((o) => o.value === v)) continue
      out[k] = v
    }
  }
  return out
}

export const __widgetRegistryTest = { clear: () => { registry.clear(); flags.clear(); version += 1 } }
