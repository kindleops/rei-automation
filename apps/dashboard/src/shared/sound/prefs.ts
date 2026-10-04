import { loadSettings, saveSettings, subscribeSettings, type NexusSettings } from '../settings'

/**
 * Sound preferences live in the one LeadCommand settings store
 * (`nexus-settings`) under `experienceSound`. Cuelume never stores anything;
 * LeadCommand owns persistence, defaults and migration.
 *
 * Interface sounds and operational alerts are separate decisions: someone
 * can want a seller reply to chime and never hear a button, or the reverse.
 */

export type InterfaceSoundMode = 'off' | 'subtle' | 'full'
export type SoundMaterial = 'mech' | 'default' | 'press'
/** typing can follow the global material or pick its own (Bubble is typing-only) */
export type TypingMaterialPref = 'follow' | SoundMaterial | 'bubble'

export interface OperationalAlertPrefs {
  sellerReplies: boolean
  needsAttention: boolean
  sendFailures: boolean
  campaignCompletion: boolean
  closingMilestones: boolean
  workflowHolds: boolean
  systemDegradation: boolean
}

export interface ExperienceSoundPrefs {
  version: 1
  interface: InterfaceSoundMode
  /** global multiplier, 0–1 */
  volume: number
  material: SoundMaterial
  /** keystroke sounds — separate opt-in; silent when interface sounds are Off */
  typing: boolean
  /** 'follow' = the global material */
  typingMaterial: TypingMaterialPref
  /** typing's own level, 0–1, multiplied by the global volume */
  typingVolume: number
  alerts: boolean
  alertTypes: OperationalAlertPrefs
  /** when this window is in the background: only P1 alerts, or nothing */
  background: 'critical' | 'off'
}

export const DEFAULT_SOUND_PREFS: ExperienceSoundPrefs = {
  version: 1,
  interface: 'subtle',
  volume: 0.35,
  material: 'mech',
  typing: false,
  typingMaterial: 'follow',
  typingVolume: 0.5,
  alerts: true,
  alertTypes: {
    sellerReplies: true,
    needsAttention: true,
    sendFailures: true,
    campaignCompletion: true,
    closingMilestones: true,
    workflowHolds: true,
    systemDegradation: true,
  },
  background: 'critical',
}

type WithSound = NexusSettings & { experienceSound?: Partial<ExperienceSoundPrefs> & { alertTypes?: Partial<OperationalAlertPrefs> } }

const MODES: InterfaceSoundMode[] = ['off', 'subtle', 'full']
const MATERIALS: SoundMaterial[] = ['mech', 'default', 'press']
const TYPING_MATERIALS: TypingMaterialPref[] = ['follow', 'mech', 'default', 'press', 'bubble']

let lastSource: NexusSettings | null = null
let lastPrefs: ExperienceSoundPrefs | null = null

/**
 * Read with defaults; anything stored that is invalid falls back, never breaks.
 * Memoized on the settings snapshot: this is a useSyncExternalStore getSnapshot,
 * so it must return the SAME object until settings change (a fresh object per
 * call loops React forever — "Maximum update depth exceeded").
 */
export function readSoundPrefs(): ExperienceSoundPrefs {
  const source = loadSettings()
  if (lastPrefs && source === lastSource) return lastPrefs
  lastSource = source
  lastPrefs = parseSoundPrefs(source)
  return lastPrefs
}

function parseSoundPrefs(source: NexusSettings): ExperienceSoundPrefs {
  const raw = (source as WithSound).experienceSound ?? {}
  const vol = Number(raw.volume)
  const tvol = Number(raw.typingVolume)
  return {
    version: 1,
    interface: MODES.includes(raw.interface as InterfaceSoundMode) ? (raw.interface as InterfaceSoundMode) : DEFAULT_SOUND_PREFS.interface,
    volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : DEFAULT_SOUND_PREFS.volume,
    material: MATERIALS.includes(raw.material as SoundMaterial) ? (raw.material as SoundMaterial) : DEFAULT_SOUND_PREFS.material,
    typing: raw.typing === true,
    typingMaterial: TYPING_MATERIALS.includes(raw.typingMaterial as TypingMaterialPref) ? (raw.typingMaterial as TypingMaterialPref) : DEFAULT_SOUND_PREFS.typingMaterial,
    typingVolume: raw.typingVolume !== undefined && Number.isFinite(tvol) ? Math.min(1, Math.max(0, tvol)) : DEFAULT_SOUND_PREFS.typingVolume,
    alerts: raw.alerts !== false,
    alertTypes: { ...DEFAULT_SOUND_PREFS.alertTypes, ...(raw.alertTypes ?? {}) },
    background: raw.background === 'off' ? 'off' : 'critical',
  }
}

export function writeSoundPrefs(patch: Partial<ExperienceSoundPrefs>) {
  const current = loadSettings() as WithSound
  const next: ExperienceSoundPrefs = { ...readSoundPrefs(), ...patch, alertTypes: { ...readSoundPrefs().alertTypes, ...(patch.alertTypes ?? {}) } }
  saveSettings({ ...current, experienceSound: next } as NexusSettings)
}

export const subscribeSoundPrefs = subscribeSettings
