/**
 * The curated accent presets — ids are the stored `nexus-settings.accentPalette`
 * values (unchanged since before the Environment Studio), hex is the colour
 * the operator chose it for. Every preset runs through the same derivation as
 * a custom colour, so each one gets contrast-safe tokens in every theme.
 *
 * Display order follows the spectrum, so the row reads as one gradient.
 */
export const ACCENT_PRESETS = [
  { id: 'cyan', label: 'Cyan', hex: '#06B6D4' },
  { id: 'ice', label: 'Ice', hex: '#38BDF8' },
  { id: 'blue', label: 'Blue', hex: '#2563EB' },
  { id: 'violet', label: 'Violet', hex: '#7C3AED' },
  { id: 'pink', label: 'Pink', hex: '#EC4899' },
  { id: 'rose', label: 'Rose', hex: '#E11D48' },
  { id: 'orange', label: 'Orange', hex: '#F97316' },
  { id: 'amber', label: 'Amber', hex: '#F59E0B' },
  { id: 'gold', label: 'Gold', hex: '#EAB308' },
  { id: 'lime', label: 'Lime', hex: '#84CC16' },
  { id: 'emerald', label: 'Emerald', hex: '#10B981' },
  { id: 'teal', label: 'Teal', hex: '#14B8A6' },
] as const

export type AccentPresetId = (typeof ACCENT_PRESETS)[number]['id']
export type AccentId = AccentPresetId | 'custom'

export const ACCENT_PRESET_IDS: readonly AccentPresetId[] = ACCENT_PRESETS.map((p) => p.id)

const BY_ID = new Map<string, (typeof ACCENT_PRESETS)[number]>(ACCENT_PRESETS.map((p) => [p.id, p]))

export const isAccentPresetId = (v: unknown): v is AccentPresetId => typeof v === 'string' && BY_ID.has(v)
export const isAccentId = (v: unknown): v is AccentId => v === 'custom' || isAccentPresetId(v)
export const accentPresetHex = (id: AccentPresetId) => BY_ID.get(id)?.hex ?? '#06B6D4'
export const accentPresetLabel = (id: AccentPresetId) => BY_ID.get(id)?.label ?? 'Accent'

/** The product's out-of-box accent. */
export const DEFAULT_ACCENT: AccentPresetId = 'cyan'
/** Where the Custom colour starts before the operator has made one. */
export const DEFAULT_CUSTOM_ACCENT = '#22D3EE'
/** Red Ops' signal red — what Red Ops painted before theme and accent were separated. */
export const RED_OPS_SIGNAL = '#FF1212'
