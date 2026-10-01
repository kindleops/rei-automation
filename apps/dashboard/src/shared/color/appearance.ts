/**
 * THE APPEARANCE MODEL — what the Environment Studio stores, and how every
 * older shape becomes it without anyone's look changing.
 *
 * It lives inside `nexus-settings` beside the fields other surfaces already
 * read, rather than replacing them:
 *
 *   nexusTheme      the luminance foundation (Dark · Light · True Black · Red Ops)   — unchanged
 *   accentPalette   a preset id, or 'custom'                                         — unchanged, + 'custom'
 *   liquidGlass     the glass material (+ edge, + base family)                       — unchanged, extended
 *   appearance      { version, accent: { custom, intensity }, environment, motion }  — new
 *   appearanceLibrary { recentColors, savedColors, saved }                           — new
 *
 * Everything here is pure: parse, repair, migrate, snapshot. Nothing touches
 * the DOM or storage, so it can be tested exhaustively and trusted on boot.
 */
import { ACCENT_PRESETS, DEFAULT_ACCENT, DEFAULT_CUSTOM_ACCENT, RED_OPS_SIGNAL, accentPresetHex, isAccentId, isAccentPresetId, type AccentId } from './accents'
import { FOUNDATION_IDS, GLASS_FAMILIES, HARMONY_IDS, resolveFoundation, type EdgeLevel, type FoundationId, type GlassFamily, type HarmonyId } from './derive'
import { clamp, normalizeHex } from './oklch'

export const APPEARANCE_VERSION = 1

export type EnvironmentType = 'liquid' | 'waves' | 'aurora' | 'still' | 'custom'
export const ENVIRONMENT_TYPES: readonly EnvironmentType[] = ['liquid', 'waves', 'aurora', 'still', 'custom']
export type MotionLevel = 'still' | 'calm' | 'fluid'
export const MOTION_LEVELS: readonly MotionLevel[] = ['still', 'calm', 'fluid']
export type GlassPreset = 'theme' | GlassFamily | 'custom'
export const EDGE_LEVELS: readonly EdgeLevel[] = ['soft', 'balanced', 'crisp']

export interface EnvironmentState {
  type: EnvironmentType
  /** anchors follow the accent (generated) — or the operator's own when off */
  autoHarmony: boolean
  harmony: HarmonyId
  /** 2–4 operator anchors, #RRGGBB; kept while Auto Harmony is on */
  palette: string[]
  /** 0–100 how much colour reaches the glass */
  intensity: number
  /** 0–100 soft → deep */
  blend: number
  /** 0–100 focused → ambient */
  spread: number
  /** 0–100 flat → spatial */
  depth: number
  /** 0–100, 50 balanced: environmental light, never text */
  luminosity: number
  /** 0–100, 50 neutral: < 50 cool, > 50 warm */
  temperature: number
  /** Custom environments: where the light comes from (0–1) */
  focalX: number
  focalY: number
}

export interface AppearanceState {
  version: number
  accent: { custom: string; intensity: number }
  environment: EnvironmentState
  motion: MotionLevel
}

/** Mirrors (and extends) NexusSettings.liquidGlass — the one glass store. */
export interface MaterialState {
  preset: GlassPreset
  blur: number
  transparency: number
  sheen: number
  edge?: EdgeLevel
  /** the family a 'custom' material was tuned from */
  base?: GlassFamily
}

export interface AppearanceSnapshot {
  theme: FoundationId
  accent: { palette: AccentId; custom: string; intensity: number }
  environment: EnvironmentState
  material: MaterialState
  motion: MotionLevel
}

export interface SavedEnvironment {
  id: string
  name: string
  createdAt: number
  snapshot: AppearanceSnapshot
  builtIn?: boolean
}

export interface AppearanceLibrary {
  version: number
  recentColors: string[]
  savedColors: string[]
  saved: SavedEnvironment[]
}

export const RECENT_MAX = 8
export const SAVED_COLORS_MAX = 8
export const SAVED_ENVIRONMENTS_MAX = 24
export const PALETTE_MIN = 2
export const PALETTE_MAX = 4
export const NAME_MAX = 40

/* ── defaults ──────────────────────────────────────────────────────────── */

export const DEFAULT_ENVIRONMENT: EnvironmentState = Object.freeze({
  type: 'liquid',
  autoHarmony: true,
  harmony: 'analogous',
  palette: ['#06B6D4', '#2FB09B', '#70B3EC'],
  intensity: 55,
  blend: 50,
  spread: 55,
  depth: 50,
  luminosity: 50,
  temperature: 50,
  focalX: 0.28,
  focalY: 0.22,
}) as EnvironmentState

export const DEFAULT_MATERIAL: MaterialState = Object.freeze({ preset: 'theme', blur: 28, transparency: 45, sheen: 50, edge: 'balanced' }) as MaterialState

/** Canonical values each glass chip applies (the Studio's four materials). */
export const GLASS_PRESET_VALUES: Record<GlassFamily, Omit<MaterialState, 'preset' | 'base' | 'edge'>> = {
  clear: { blur: 12, transparency: 78, sheen: 60 },
  crystal: { blur: 24, transparency: 45, sheen: 50 },
  frosted: { blur: 44, transparency: 28, sheen: 42 },
  smoke: { blur: 30, transparency: 16, sheen: 28 },
}

export const defaultAppearance = (): AppearanceState => ({
  version: APPEARANCE_VERSION,
  accent: { custom: DEFAULT_CUSTOM_ACCENT, intensity: 50 },
  environment: { ...DEFAULT_ENVIRONMENT, palette: [...DEFAULT_ENVIRONMENT.palette] },
  motion: 'calm',
})

export const defaultLibrary = (): AppearanceLibrary => ({ version: APPEARANCE_VERSION, recentColors: [], savedColors: [], saved: [] })

/* ── repair: every field is validated on its own; one bad value never drops the rest ── */

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const pct = (v: unknown, fallback: number) => {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? fallback : Math.round(clamp(n, 0, 100))
}
const unit = (v: unknown, fallback: number) => {
  const n = Number(v)
  return v === null || v === undefined || !Number.isFinite(n) ? fallback : clamp(n, 0, 1)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A 2–4 anchor palette of valid colours; short palettes are completed, never emptied. */
export function normalizePalette(raw: unknown, fallback: string[] = DEFAULT_ENVIRONMENT.palette): string[] {
  const list = Array.isArray(raw) ? raw.map(normalizeHex).filter((h): h is string => Boolean(h)) : []
  if (!list.length) return [...fallback].slice(0, PALETTE_MAX)
  const out = list.slice(0, PALETTE_MAX)
  for (const f of fallback) {
    if (out.length >= PALETTE_MIN) break
    if (!out.includes(f)) out.push(f)
  }
  while (out.length < PALETTE_MIN) out.push(DEFAULT_ENVIRONMENT.palette[out.length % DEFAULT_ENVIRONMENT.palette.length])
  return out
}

export function normalizeEnvironment(raw: unknown): EnvironmentState {
  const r = isObj(raw) ? raw : {}
  const d = DEFAULT_ENVIRONMENT
  return {
    type: pick(r.type, ENVIRONMENT_TYPES, d.type),
    autoHarmony: typeof r.autoHarmony === 'boolean' ? r.autoHarmony : d.autoHarmony,
    harmony: pick(r.harmony, HARMONY_IDS, d.harmony),
    palette: normalizePalette(r.palette),
    intensity: pct(r.intensity, d.intensity),
    blend: pct(r.blend, d.blend),
    spread: pct(r.spread, d.spread),
    depth: pct(r.depth, d.depth),
    luminosity: pct(r.luminosity, d.luminosity),
    temperature: pct(r.temperature, d.temperature),
    focalX: unit(r.focalX, d.focalX),
    focalY: unit(r.focalY, d.focalY),
  }
}

const PRESETS: readonly GlassPreset[] = ['theme', 'clear', 'crystal', 'frosted', 'smoke', 'custom']

/** The glass family a stored material reads as (old 'custom' glass is matched to its nearest preset). */
export function materialFamily(m: MaterialState): GlassFamily {
  if (m.preset === 'theme' || m.preset === 'crystal') return 'crystal'
  if (m.preset === 'clear' || m.preset === 'frosted' || m.preset === 'smoke') return m.preset
  if (m.base && GLASS_FAMILIES.includes(m.base)) return m.base
  let best: GlassFamily = 'crystal'
  let dist = Infinity
  for (const fam of GLASS_FAMILIES) {
    const v = GLASS_PRESET_VALUES[fam]
    const d = Math.abs(v.blur - m.blur) / 60 + Math.abs(v.transparency - m.transparency) / 100 + Math.abs(v.sheen - m.sheen) / 200
    if (d < dist) { dist = d; best = fam }
  }
  return best
}

export function normalizeMaterial(raw: unknown): MaterialState {
  const r = isObj(raw) ? raw : {}
  const preset = pick(r.preset, PRESETS, DEFAULT_MATERIAL.preset)
  const out: MaterialState = {
    preset,
    blur: Math.round(clamp(Number.isFinite(Number(r.blur)) ? Number(r.blur) : DEFAULT_MATERIAL.blur, 0, 60)),
    transparency: pct(r.transparency, DEFAULT_MATERIAL.transparency),
    sheen: pct(r.sheen, DEFAULT_MATERIAL.sheen),
    edge: pick(r.edge, EDGE_LEVELS, 'balanced'),
  }
  if (preset === 'custom') out.base = GLASS_FAMILIES.includes(r.base as GlassFamily) ? (r.base as GlassFamily) : materialFamily(out)
  return out
}

export function normalizeAppearance(raw: unknown): AppearanceState {
  const r = isObj(raw) ? raw : {}
  const accent = isObj(r.accent) ? r.accent : {}
  return {
    version: APPEARANCE_VERSION,
    accent: {
      custom: normalizeHex(accent.custom) ?? DEFAULT_CUSTOM_ACCENT,
      intensity: pct(accent.intensity, 50),
    },
    environment: normalizeEnvironment(r.environment),
    motion: pick(r.motion, MOTION_LEVELS, 'calm'),
  }
}

export function normalizeSnapshot(raw: unknown): AppearanceSnapshot | null {
  if (!isObj(raw)) return null
  const accent = isObj(raw.accent) ? raw.accent : {}
  return {
    theme: pick(raw.theme, FOUNDATION_IDS, resolveFoundation(raw.theme)),
    accent: {
      palette: isAccentId(accent.palette) ? accent.palette : DEFAULT_ACCENT,
      custom: normalizeHex(accent.custom) ?? DEFAULT_CUSTOM_ACCENT,
      intensity: pct(accent.intensity, 50),
    },
    environment: normalizeEnvironment(raw.environment),
    material: normalizeMaterial(raw.material),
    motion: pick(raw.motion, MOTION_LEVELS, 'calm'),
  }
}

const cleanName = (v: unknown, fallback: string) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : ''
  return s || fallback
}

/** Corrupt entries are repaired when they can be and skipped when they cannot — never thrown. */
export function normalizeLibrary(raw: unknown): AppearanceLibrary {
  const r = isObj(raw) ? raw : {}
  const colors = (v: unknown, max: number) => {
    const list = Array.isArray(v) ? v.map(normalizeHex).filter((h): h is string => Boolean(h)) : []
    return [...new Set(list)].slice(0, max)
  }
  const seen = new Set<string>()
  const saved: SavedEnvironment[] = []
  for (const entry of Array.isArray(r.saved) ? r.saved : []) {
    if (!isObj(entry)) continue
    const snapshot = normalizeSnapshot(entry.snapshot)
    if (!snapshot) continue
    let id = typeof entry.id === 'string' && entry.id && !entry.id.startsWith('builtin:') ? entry.id : ''
    if (!id || seen.has(id)) id = `env-${saved.length + 1}-${Math.abs(hashString(JSON.stringify(snapshot)))}`
    seen.add(id)
    const createdAt = Number(entry.createdAt)
    saved.push({ id, name: cleanName(entry.name, `Custom Environment ${saved.length + 1}`), createdAt: Number.isFinite(createdAt) ? createdAt : 0, snapshot })
    if (saved.length >= SAVED_ENVIRONMENTS_MAX) break
  }
  return { version: APPEARANCE_VERSION, recentColors: colors(r.recentColors, RECENT_MAX), savedColors: colors(r.savedColors, SAVED_COLORS_MAX), saved }
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/* ── migration from every older shape ─────────────────────────────────── */

/** The pre-Studio desktop backdrop (`nexus.desktop.backdrop`): style, palette, intensity, motion. */
export interface LegacyBackdrop { style?: unknown; palette?: unknown; intensity?: unknown; motion?: unknown }

/** "Spectrum" painted the first four accents of this list behind the glass. */
const SPECTRUM: AccentId[] = ['violet', 'blue', 'cyan', 'emerald']

export interface MigrationInput {
  nexusTheme?: unknown
  accentPalette?: unknown
  appearance?: unknown
  appearanceLibrary?: unknown
  liquidGlass?: unknown
}

export interface MigrationResult {
  accentPalette: AccentId
  appearance: AppearanceState
  appearanceLibrary: AppearanceLibrary
  liquidGlass: MaterialState | undefined
  /** true when anything was written that was not there (or not valid) before */
  changed: boolean
}

/**
 * Brings any stored settings to the current appearance version.
 * Visual promise: the operator sees what they saw before —
 *  · the backdrop's style / intensity / motion carry over; "Accent" colours
 *    become Auto Harmony (the same family), "Spectrum" becomes those four anchors;
 *  · Red Ops kept its signal red even when another accent was stored (the
 *    two were welded), so a Red Ops operator keeps that red as a Custom accent;
 *  · glass is untouched (the same store), only gaining an edge setting.
 */
export function migrateAppearance(raw: MigrationInput, legacyBackdrop: LegacyBackdrop | null): MigrationResult {
  const current = isObj(raw.appearance) && Number(raw.appearance.version) >= 1
  const storedAccent: AccentId = isAccentId(raw.accentPalette) ? raw.accentPalette : DEFAULT_ACCENT
  let accentPalette = storedAccent
  let appearance: AppearanceState

  if (current) {
    appearance = normalizeAppearance(raw.appearance)
  } else {
    appearance = defaultAppearance()
    if (isAccentPresetId(storedAccent)) appearance.accent.custom = accentPresetHex(storedAccent)
    const theme = resolveFoundation(raw.nexusTheme)
    if (theme === 'red_ops') {
      accentPalette = 'custom'
      appearance.accent.custom = RED_OPS_SIGNAL
    }
    const bd = isObj(legacyBackdrop) ? legacyBackdrop : null
    if (bd) {
      const env = appearance.environment
      env.type = pick(bd.style, ['liquid', 'waves', 'aurora', 'still'] as const, 'liquid')
      env.intensity = pct(bd.intensity, env.intensity)
      if (bd.palette === 'spectrum') {
        env.autoHarmony = false
        env.palette = SPECTRUM.map((id) => accentPresetHex(id as Exclude<AccentId, 'custom'>))
      }
      if (bd.motion === false) appearance.motion = 'still'
    }
  }

  const liquidGlass = raw.liquidGlass === undefined ? undefined : normalizeMaterial(raw.liquidGlass)
  const appearanceLibrary = normalizeLibrary(raw.appearanceLibrary)
  const changed = !current
    || accentPalette !== raw.accentPalette
    || JSON.stringify(appearance) !== JSON.stringify(raw.appearance)
    || JSON.stringify(appearanceLibrary) !== JSON.stringify(raw.appearanceLibrary)
    || (liquidGlass !== undefined && JSON.stringify(liquidGlass) !== JSON.stringify(raw.liquidGlass))
  return { accentPalette, appearance, appearanceLibrary, liquidGlass, changed }
}

/* ── snapshots: the whole look, as UI preference only (no business data) ─ */

export interface AppearanceFields {
  nexusTheme: string
  accentPalette: AccentId
  appearance: AppearanceState
  liquidGlass?: MaterialState
}

export function snapshotOf(s: AppearanceFields): AppearanceSnapshot {
  return {
    theme: resolveFoundation(s.nexusTheme),
    accent: { palette: s.accentPalette, custom: s.appearance.accent.custom, intensity: s.appearance.accent.intensity },
    environment: { ...s.appearance.environment, palette: [...s.appearance.environment.palette] },
    material: normalizeMaterial(s.liquidGlass ?? DEFAULT_MATERIAL),
    motion: s.appearance.motion,
  }
}

/** The fields a snapshot writes back (theme becomes the foundation id). */
export function fieldsFromSnapshot(snap: AppearanceSnapshot, keep: AppearanceState): Pick<AppearanceFields, 'nexusTheme' | 'accentPalette' | 'appearance' | 'liquidGlass'> {
  return {
    nexusTheme: snap.theme,
    accentPalette: snap.accent.palette,
    appearance: {
      ...keep,
      version: APPEARANCE_VERSION,
      accent: { custom: snap.accent.custom, intensity: snap.accent.intensity },
      environment: { ...snap.environment, palette: [...snap.environment.palette] },
      motion: snap.motion,
    },
    liquidGlass: { ...snap.material },
  }
}

/** Equal for the purposes of "this is the active environment". */
export function snapshotsEqual(a: AppearanceSnapshot, b: AppearanceSnapshot): boolean {
  const m = (x: MaterialState) => ({ ...x, edge: x.edge ?? 'balanced', base: x.preset === 'custom' ? x.base : undefined })
  const accent = (x: AppearanceSnapshot['accent']) => (x.palette === 'custom' ? x : { palette: x.palette, intensity: x.intensity })
  const env = (x: EnvironmentState) => (x.autoHarmony ? { ...x, palette: [] } : x)
  return a.theme === b.theme
    && a.motion === b.motion
    && JSON.stringify(accent(a.accent)) === JSON.stringify(accent(b.accent))
    && JSON.stringify(env(a.environment)) === JSON.stringify(env(b.environment))
    && JSON.stringify(m(a.material)) === JSON.stringify(m(b.material))
}

/* ── built-in environments: curated, immutable ─────────────────────────── */

const env = (patch: Partial<EnvironmentState>): EnvironmentState => normalizeEnvironment({ ...DEFAULT_ENVIRONMENT, ...patch })
const mat = (preset: GlassPreset, patch: Partial<MaterialState> = {}): MaterialState =>
  normalizeMaterial({ preset, ...(preset === 'theme' || preset === 'custom' ? DEFAULT_MATERIAL : GLASS_PRESET_VALUES[preset]), edge: 'balanced', ...patch })

const builtIn = (id: string, name: string, snapshot: AppearanceSnapshot): SavedEnvironment =>
  Object.freeze({ id: `builtin:${id}`, name, createdAt: 0, builtIn: true, snapshot: Object.freeze(snapshot) as AppearanceSnapshot })

export const BUILT_IN_ENVIRONMENTS: readonly SavedEnvironment[] = Object.freeze([
  builtIn('leadcommand-dark', 'LeadCommand Dark', {
    theme: 'dark', accent: { palette: 'cyan', custom: DEFAULT_CUSTOM_ACCENT, intensity: 50 },
    environment: env({}), material: mat('theme'), motion: 'calm',
  }),
  builtIn('midnight-cyan', 'Midnight Cyan', {
    theme: 'dark', accent: { palette: 'custom', custom: '#22D3EE', intensity: 58 },
    environment: env({ type: 'liquid', autoHarmony: false, palette: ['#0891B2', '#1D4ED8', '#0E7490', '#312E81'], intensity: 62, blend: 46, spread: 62, depth: 66, luminosity: 44, temperature: 36 }),
    material: mat('theme'), motion: 'calm',
  }),
  builtIn('deep-aurora', 'Deep Aurora', {
    theme: 'true_black', accent: { palette: 'custom', custom: '#22D3EE', intensity: 55 },
    environment: env({ type: 'aurora', autoHarmony: false, palette: ['#0D9488', '#059669', '#7C3AED', '#0E7490'], intensity: 64, blend: 56, spread: 58, depth: 70, luminosity: 50, temperature: 46 }),
    material: mat('theme'), motion: 'calm',
  }),
  builtIn('executive-gold', 'Executive Gold', {
    theme: 'dark', accent: { palette: 'gold', custom: '#EAB308', intensity: 46 },
    environment: env({ type: 'still', autoHarmony: false, palette: ['#B45309', '#78350F', '#A16207', '#44403C'], intensity: 42, blend: 40, spread: 60, depth: 64, luminosity: 44, temperature: 72 }),
    material: mat('smoke'), motion: 'still',
  }),
  builtIn('emerald-glass', 'Emerald Glass', {
    theme: 'dark', accent: { palette: 'emerald', custom: '#10B981', intensity: 52 },
    environment: env({ type: 'liquid', autoHarmony: true, harmony: 'deep-aurora', intensity: 56, blend: 52, spread: 60, depth: 58 }),
    material: mat('frosted'), motion: 'calm',
  }),
  builtIn('studio-black', 'Studio Black', {
    theme: 'true_black', accent: { palette: 'ice', custom: '#38BDF8', intensity: 44 },
    environment: env({ type: 'still', autoHarmony: true, harmony: 'monochrome', intensity: 30, blend: 40, spread: 34, depth: 72 }),
    material: mat('smoke'), motion: 'still',
  }),
  builtIn('light-crystal', 'Light Crystal', {
    theme: 'light', accent: { palette: 'blue', custom: '#2563EB', intensity: 50 },
    environment: env({ type: 'liquid', autoHarmony: true, harmony: 'cool-glass', intensity: 58, blend: 48, spread: 64, depth: 44, temperature: 40 }),
    material: mat('clear'), motion: 'calm',
  }),
  builtIn('red-ops', 'Red Ops', {
    theme: 'red_ops', accent: { palette: 'custom', custom: RED_OPS_SIGNAL, intensity: 50 },
    environment: env({ type: 'liquid', autoHarmony: true, harmony: 'cool-glass', intensity: 52, depth: 62, temperature: 40 }),
    material: mat('theme'), motion: 'calm',
  }),
])

/* ── library operations (pure) ─────────────────────────────────────────── */

export function pushRecentColor(lib: AppearanceLibrary, hex: string): AppearanceLibrary {
  const h = normalizeHex(hex)
  if (!h) return lib
  return { ...lib, recentColors: [h, ...lib.recentColors.filter((c) => c !== h)].slice(0, RECENT_MAX) }
}

export function toggleSavedColor(lib: AppearanceLibrary, hex: string): AppearanceLibrary {
  const h = normalizeHex(hex)
  if (!h) return lib
  const has = lib.savedColors.includes(h)
  return { ...lib, savedColors: has ? lib.savedColors.filter((c) => c !== h) : [h, ...lib.savedColors].slice(0, SAVED_COLORS_MAX) }
}

/** "Custom Environment N" — the first number not already taken. */
export function nextEnvironmentName(lib: AppearanceLibrary): string {
  const taken = new Set(lib.saved.map((s) => s.name.toLowerCase()))
  for (let n = 1; n < 1000; n++) {
    const name = `Custom Environment ${n}`
    if (!taken.has(name.toLowerCase())) return name
  }
  return 'Custom Environment'
}

export function saveEnvironment(lib: AppearanceLibrary, name: string, snapshot: AppearanceSnapshot, now: number): { lib: AppearanceLibrary; entry: SavedEnvironment } {
  const entry: SavedEnvironment = {
    id: `env-${now.toString(36)}-${Math.abs(hashString(JSON.stringify(snapshot))).toString(36)}`,
    name: cleanName(name, nextEnvironmentName(lib)),
    createdAt: now,
    snapshot: normalizeSnapshot(snapshot) ?? snapshot,
  }
  return { lib: { ...lib, saved: [entry, ...lib.saved].slice(0, SAVED_ENVIRONMENTS_MAX) }, entry }
}

export function renameEnvironment(lib: AppearanceLibrary, id: string, name: string): AppearanceLibrary {
  return { ...lib, saved: lib.saved.map((s) => (s.id === id ? { ...s, name: cleanName(name, s.name) } : s)) }
}

/** Built-ins cannot be deleted; unknown ids are a no-op. */
export function deleteEnvironment(lib: AppearanceLibrary, id: string): AppearanceLibrary {
  if (id.startsWith('builtin:')) return lib
  return { ...lib, saved: lib.saved.filter((s) => s.id !== id) }
}

/** Duplicate a built-in or saved environment into a new, editable copy. */
export function duplicateEnvironment(lib: AppearanceLibrary, source: SavedEnvironment, now: number): { lib: AppearanceLibrary; entry: SavedEnvironment } {
  const base = `${source.name} copy`.slice(0, NAME_MAX)
  const taken = new Set(lib.saved.map((s) => s.name.toLowerCase()))
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()) && n < 100; n++) name = `${base} ${n}`.slice(0, NAME_MAX)
  return saveEnvironment(lib, name, JSON.parse(JSON.stringify(source.snapshot)) as AppearanceSnapshot, now)
}

/** The accent's own colour (what the Custom swatch or a preset represents). */
export function accentSourceHex(palette: AccentId, custom: string): string {
  return palette === 'custom' ? (normalizeHex(custom) ?? DEFAULT_CUSTOM_ACCENT) : accentPresetHex(palette)
}

export const ACCENT_PRESET_LIST = ACCENT_PRESETS
