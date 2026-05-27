/**
 * NEXUS Settings Store
 *
 * Reactive settings with localStorage persistence.
 * Provides map, sound, and UI customization for the entire app.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type MapTheme = 'dark-matter' | 'dark-matter-nolabels' | 'voyager-nolabels' | 'positron-nolabels'
export type HeatPalette = 'default' | 'infrared' | 'ocean' | 'arctic'
export type PulsePalette = 'default' | 'neon' | 'muted' | 'monochrome'
export type SoundProfile = 'tactical' | 'ambient' | 'minimal' | 'silent'
export type DensityMode = 'comfortable' | 'compact' | 'spacious'
export type DefaultMapMode = 'leads' | 'distress' | 'heat' | 'stage' | 'pressure' | 'closings'
export type GreetingStyle = 'formal' | 'casual' | 'minimal' | 'cinematic'
export type CopilotInitiative = 'proactive' | 'balanced' | 'on-demand'
export type CopilotVerbosity = 'concise' | 'detailed'
export type CopilotReasoningDepth = 'minimal' | 'standard' | 'deep'
export type CopilotVoiceMode = 'off' | 'text' | 'full'
export type NexusTheme =
  // System-wide themes (aligned with map/global theme engine)
  | 'dark' | 'satellite' | 'terrain' | 'red_ops' | 'matrix' | 'blueprint' | 'executive' | 'night_vision' | 'monochrome' | 'light'
  // Legacy themes kept for localStorage backward compatibility
  | 'dark-matter' | 'midnight-glass' | 'tactical-blue' | 'carbon-gold' | 'monochrome-ops' | 'infrared' | 'arctic-signal' | 'operator-black'
export type AccentPalette = 'cyan' | 'emerald' | 'amber' | 'violet' | 'rose' | 'ice'

export interface NexusSettings {
  // Map
  mapTheme: MapTheme
  heatPalette: HeatPalette
  heatIntensity: number         // 0.2–2.0
  pulsePalette: PulsePalette
  pulseDensity: number          // 0.1–1.0
  showLabels: boolean
  showPOIs: boolean
  showRoads: boolean
  defaultMapMode: DefaultMapMode
  defaultZoom: number           // 3–12

  // Signal layers
  layerLeadTemp: boolean
  layerMarketPressure: boolean
  layerBuyerDemand: boolean
  layerAlerts: boolean
  layerTitle: boolean
  layerContracts: boolean

  // Sound
  soundEnabled: boolean
  soundVolume: number           // 0–1
  soundProfile: SoundProfile
  soundInboundReply: boolean
  soundHotLeadEscalation: boolean
  soundAlertTriggered: boolean
  soundTitleClear: boolean
  soundClosingScheduled: boolean
  soundBuyerMatch: boolean
  soundAiResponse: boolean
  soundAutopilotAction: boolean
  soundNotification: boolean
  soundQueueIssue: boolean
  soundContractMilestone: boolean

  // UI
  densityMode: DensityMode
  showBlades: boolean
  timelineDensity: number       // 5–50 events
  eventCategories: string[]

  // Surface
  animationsEnabled: boolean

  // Split View
  splitViewDefaultSize: 'narrow' | 'standard' | 'wide'
  splitViewSoundEnabled: boolean

  // AI Copilot
  copilotEnabled: boolean
  copilotAutoOpen: boolean
  copilotSoundEnabled: boolean
  copilotMode: 'orb' | 'sidecar' | 'console'
  copilotModel: string
  actionPermission: string
  voiceModeDefault: boolean
  copilotVoiceMode: CopilotVoiceMode
  copilotAutonomous: boolean
  // TTS controls
  ttsVolume: number
  ttsRate: number
  ttsPitch: number
  ttsVoice: string
  ttsPersona: 'neutral' | 'warm' | 'energetic' | 'calm' | 'robotic' | 'friendly' | 'authoritative' | 'narrator'
  orbPlacement: 'dock' | 'corner'
  copilotOrbAlwaysVisible: boolean
  copilotOrbIntensity: number   // 0.2–2.0
  copilotOrbSpeed: number       // 0.5–2.0
  copilotMissionTracePinned: boolean
  copilotOpenOnRoomChange: boolean

  // Briefing Mode
  briefingAutoGenerate: boolean
  briefingSoundEnabled: boolean

  // Notifications
  notificationsEnabled: boolean
  notificationToastDuration: number  // ms, 3000–10000
  notificationSoundEnabled: boolean
  notificationMaxVisible: number     // 1–6

  // Keyboard
  keyboardShortcutsEnabled: boolean

  // Operator personalization
  operatorName: string
  operatorTitle: string
  assistantName: string
  greetingStyle: GreetingStyle
  copilotInitiative: CopilotInitiative
  copilotVerbosity: CopilotVerbosity
  copilotReasoningDepth: CopilotReasoningDepth

  // Theme
  nexusTheme: NexusTheme
  accentPalette: AccentPalette
  // Resolved global theme attribute (set by applyThemeToDOM, matches data-nexus-theme)
  resolvedThemeId?: string

  // Map advanced
  mapBrightness: number           // 0.5–1.5
  atmosphericIntensity: number    // 0–1
  glowIntensity: number           // 0–1
  labelDensity: number            // 0–1
}

// ── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: NexusSettings = {
  mapTheme: 'dark-matter',
  heatPalette: 'default',
  heatIntensity: 1.0,
  pulsePalette: 'default',
  pulseDensity: 0.7,
  showLabels: true,
  showPOIs: false,
  showRoads: true,
  defaultMapMode: 'leads',
  defaultZoom: 4,
  layerLeadTemp: true,
  layerMarketPressure: true,
  layerBuyerDemand: true,
  layerAlerts: true,
  layerTitle: true,
  layerContracts: true,
  soundEnabled: false,
  soundVolume: 0.5,
  soundProfile: 'tactical',
  soundInboundReply: true,
  soundHotLeadEscalation: true,
  soundAlertTriggered: true,
  soundTitleClear: true,
  soundClosingScheduled: true,
  soundBuyerMatch: true,
  soundAiResponse: true,
  soundAutopilotAction: true,
  soundNotification: true,
  soundQueueIssue: true,
  soundContractMilestone: true,
  densityMode: 'comfortable',
  showBlades: true,
  timelineDensity: 30,
  eventCategories: ['system', 'alert', 'ai', 'deal', 'conversation', 'autopilot'],
  animationsEnabled: true,
  splitViewDefaultSize: 'standard',
  splitViewSoundEnabled: true,
  copilotEnabled: true,
  copilotAutoOpen: false,
  copilotSoundEnabled: true,
  copilotMode: 'sidecar',
  copilotModel: 'nexus-balanced',
  actionPermission: 'confirm-before',
  voiceModeDefault: false,
  copilotVoiceMode: 'off',
  copilotAutonomous: false,
  ttsVolume: 1,
  ttsRate: 1,
  ttsPitch: 1,
  ttsVoice: '',
  ttsPersona: 'neutral',
  orbPlacement: 'dock',
  copilotOrbAlwaysVisible: true,
  copilotOrbIntensity: 1,
  copilotOrbSpeed: 1,
  copilotMissionTracePinned: false,
  copilotOpenOnRoomChange: false,
  briefingAutoGenerate: true,
  briefingSoundEnabled: true,
  notificationsEnabled: true,
  notificationToastDuration: 5000,
  notificationSoundEnabled: true,
  notificationMaxVisible: 4,
  keyboardShortcutsEnabled: true,

  // Operator personalization
  operatorName: '',
  operatorTitle: 'Operator',
  assistantName: 'NEXUS',
  greetingStyle: 'formal',
  copilotInitiative: 'balanced',
  copilotVerbosity: 'concise',
  copilotReasoningDepth: 'standard',

  // Theme
  nexusTheme: 'dark',
  accentPalette: 'cyan',

  // Map advanced
  mapBrightness: 1.0,
  atmosphericIntensity: 0.7,
  glowIntensity: 0.6,
  labelDensity: 0.5,
}

// ── Storage ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'nexus-settings'

let _cache: NexusSettings | null = null
const _listeners = new Set<() => void>()

export function loadSettings(): NexusSettings {
  if (_cache) return _cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NexusSettings>
      _cache = { ...DEFAULT_SETTINGS, ...parsed }
    } else {
      _cache = { ...DEFAULT_SETTINGS }
    }
  } catch {
    _cache = { ...DEFAULT_SETTINGS }
  }
  return _cache
}

export function saveSettings(settings: NexusSettings): void {
  _cache = settings
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage full — silently degrade
  }
  for (const fn of _listeners) fn()
}

export function updateSetting<K extends keyof NexusSettings>(
  key: K,
  value: NexusSettings[K],
): void {
  const current = loadSettings()
  saveSettings({ ...current, [key]: value })
}

export function subscribeSettings(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

export function resetSettings(): void {
  saveSettings({ ...DEFAULT_SETTINGS })
}

// ── Map style URL resolver ────────────────────────────────────────────────

const MAP_THEME_URLS: Record<MapTheme, string> = {
  'dark-matter': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'dark-matter-nolabels': 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
  'voyager-nolabels': 'https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json',
  'positron-nolabels': 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json',
}

export function resolveMapStyleUrl(theme: MapTheme): string {
  const envOverride = import.meta.env.VITE_MAP_STYLE_URL as string | undefined
  if (envOverride) return envOverride
  return MAP_THEME_URLS[theme]
}

// ── Theme system ──────────────────────────────────────────────────────────

export interface ThemeTokens {
  id: NexusTheme
  label: string
  bg: string
  surface: string
  elevated: string
  border: string
  accent: string
  accentGlow: string
  textPrimary: string
  textSecondary: string
  textMuted: string
}

export const THEME_PRESETS: Record<NexusTheme, ThemeTokens> = {
  // ── New system-wide themes ─────────────────────────────────────────────

  dark: {
    id: 'dark', label: 'Dark',
    bg: '#07101a', surface: '#0c1828', elevated: '#111f34',
    border: 'rgba(98,215,255,0.10)', accent: '#63d7ff', accentGlow: 'rgba(99,215,255,0.22)',
    textPrimary: '#eaf7ff', textSecondary: 'rgba(186,213,240,0.65)', textMuted: 'rgba(186,213,240,0.40)',
  },
  satellite: {
    id: 'satellite', label: 'Satellite',
    bg: '#0a0d11', surface: '#0e1316', elevated: '#14191e',
    border: 'rgba(214,229,248,0.10)', accent: '#c8dcf2', accentGlow: 'rgba(229,237,248,0.18)',
    textPrimary: '#f4f7fb', textSecondary: 'rgba(196,212,232,0.65)', textMuted: 'rgba(196,212,232,0.40)',
  },
  terrain: {
    id: 'terrain', label: 'Terrain',
    bg: '#0d1009', surface: '#131709', elevated: '#1b2010',
    border: 'rgba(183,216,108,0.12)', accent: '#b7d86c', accentGlow: 'rgba(183,216,108,0.22)',
    textPrimary: '#f6fee7', textSecondary: 'rgba(204,228,145,0.65)', textMuted: 'rgba(204,228,145,0.40)',
  },
  red_ops: {
    id: 'red_ops', label: 'Red Ops',
    bg: '#0e0608', surface: '#160a0d', elevated: '#200e12',
    border: 'rgba(255,107,99,0.14)', accent: '#ff6b63', accentGlow: 'rgba(191,29,29,0.32)',
    textPrimary: '#fff2ee', textSecondary: 'rgba(255,210,205,0.65)', textMuted: 'rgba(255,210,205,0.40)',
  },
  matrix: {
    id: 'matrix', label: 'Matrix',
    bg: '#020805', surface: '#040e09', elevated: '#071510',
    border: 'rgba(0,255,136,0.12)', accent: '#00ff88', accentGlow: 'rgba(0,255,136,0.20)',
    textPrimary: '#d8ffe8', textSecondary: 'rgba(114,255,178,0.65)', textMuted: 'rgba(114,255,178,0.40)',
  },
  blueprint: {
    id: 'blueprint', label: 'Blueprint',
    bg: '#061420', surface: '#091e2e', elevated: '#0e2a40',
    border: 'rgba(105,215,255,0.12)', accent: '#69d7ff', accentGlow: 'rgba(29,120,170,0.26)',
    textPrimary: '#dff8ff', textSecondary: 'rgba(154,234,255,0.65)', textMuted: 'rgba(154,234,255,0.40)',
  },
  executive: {
    id: 'executive', label: 'Executive',
    bg: '#0a0a06', surface: '#121009', elevated: '#1c180c',
    border: 'rgba(216,180,80,0.10)', accent: '#d8b450', accentGlow: 'rgba(216,180,80,0.22)',
    textPrimary: '#f0e8d8', textSecondary: 'rgba(240,220,180,0.65)', textMuted: 'rgba(240,220,180,0.40)',
  },
  night_vision: {
    id: 'night_vision', label: 'Night Vision',
    bg: '#06130f', surface: '#0a1c17', elevated: '#0f2820',
    border: 'rgba(114,255,178,0.12)', accent: '#72ffb2', accentGlow: 'rgba(41,163,110,0.24)',
    textPrimary: '#e8fff2', textSecondary: 'rgba(160,255,205,0.65)', textMuted: 'rgba(160,255,205,0.40)',
  },
  monochrome: {
    id: 'monochrome', label: 'Monochrome',
    bg: '#060708', surface: '#0c0d0f', elevated: '#141618',
    border: 'rgba(148,163,184,0.10)', accent: '#d3dde8', accentGlow: 'rgba(148,163,184,0.16)',
    textPrimary: '#f8fafc', textSecondary: 'rgba(171,184,199,0.65)', textMuted: 'rgba(171,184,199,0.40)',
  },
  light: {
    id: 'light', label: 'Light',
    bg: '#f8fafc', surface: '#f1f5f9', elevated: '#e2e8f0',
    border: 'rgba(15,23,42,0.10)', accent: '#0a84ff', accentGlow: 'rgba(10,132,255,0.18)',
    textPrimary: '#0f172a', textSecondary: '#64748b', textMuted: '#94a3b8',
  },
  // ── Legacy themes (preserved for localStorage backward compat) ─────────
  'dark-matter': {
    id: 'dark-matter', label: 'Dark Matter',
    bg: '#0a0c12', surface: '#10131c', elevated: '#181c28',
    border: 'rgba(255,255,255,0.06)', accent: '#38d0f0', accentGlow: 'rgba(56,208,240,0.25)',
    textPrimary: '#e8eaf0', textSecondary: 'rgba(255,255,255,0.55)', textMuted: 'rgba(255,255,255,0.30)',
  },
  'midnight-glass': {
    id: 'midnight-glass', label: 'Midnight Glass',
    bg: '#080a14', surface: '#0c1020', elevated: '#141830',
    border: 'rgba(100,140,255,0.08)', accent: '#6890ff', accentGlow: 'rgba(104,144,255,0.25)',
    textPrimary: '#e0e4f0', textSecondary: 'rgba(200,210,255,0.55)', textMuted: 'rgba(200,210,255,0.28)',
  },
  'tactical-blue': {
    id: 'tactical-blue', label: 'Tactical Blue',
    bg: '#08101c', surface: '#0c1628', elevated: '#142238',
    border: 'rgba(56,160,240,0.10)', accent: '#38a0f0', accentGlow: 'rgba(56,160,240,0.25)',
    textPrimary: '#e0ecf8', textSecondary: 'rgba(180,210,240,0.55)', textMuted: 'rgba(180,210,240,0.28)',
  },
  'carbon-gold': {
    id: 'carbon-gold', label: 'Carbon Gold',
    bg: '#0c0c08', surface: '#14120c', elevated: '#201c12',
    border: 'rgba(216,180,80,0.08)', accent: '#d8b450', accentGlow: 'rgba(216,180,80,0.22)',
    textPrimary: '#f0e8d8', textSecondary: 'rgba(240,220,180,0.55)', textMuted: 'rgba(240,220,180,0.28)',
  },
  'monochrome-ops': {
    id: 'monochrome-ops', label: 'Monochrome Ops',
    bg: '#0a0a0a', surface: '#121212', elevated: '#1c1c1c',
    border: 'rgba(255,255,255,0.06)', accent: '#c0c0c0', accentGlow: 'rgba(200,200,200,0.18)',
    textPrimary: '#e0e0e0', textSecondary: 'rgba(255,255,255,0.50)', textMuted: 'rgba(255,255,255,0.25)',
  },
  infrared: {
    id: 'infrared', label: 'Infrared',
    bg: '#100808', surface: '#1a0c0c', elevated: '#281414',
    border: 'rgba(255,80,60,0.08)', accent: '#ff5040', accentGlow: 'rgba(255,80,60,0.22)',
    textPrimary: '#f0e0dc', textSecondary: 'rgba(255,200,190,0.55)', textMuted: 'rgba(255,200,190,0.28)',
  },
  'arctic-signal': {
    id: 'arctic-signal', label: 'Arctic Signal',
    bg: '#080c10', surface: '#0c1218', elevated: '#141c28',
    border: 'rgba(120,200,255,0.08)', accent: '#78c8ff', accentGlow: 'rgba(120,200,255,0.22)',
    textPrimary: '#e0f0ff', textSecondary: 'rgba(180,220,255,0.55)', textMuted: 'rgba(180,220,255,0.28)',
  },
  'operator-black': {
    id: 'operator-black', label: 'Operator Black',
    bg: '#040404', surface: '#0a0a0a', elevated: '#141414',
    border: 'rgba(255,255,255,0.04)', accent: '#38d0f0', accentGlow: 'rgba(56,208,240,0.20)',
    textPrimary: '#d0d0d0', textSecondary: 'rgba(255,255,255,0.45)', textMuted: 'rgba(255,255,255,0.20)',
  },
}

export const ACCENT_PALETTES: Record<AccentPalette, { primary: string; glow: string; soft: string }> = {
  cyan:    { primary: '#38d0f0', glow: 'rgba(56,208,240,0.25)', soft: 'rgba(56,208,240,0.14)' },
  emerald: { primary: '#2cb87a', glow: 'rgba(44,184,122,0.25)', soft: 'rgba(44,184,122,0.14)' },
  amber:   { primary: '#d89530', glow: 'rgba(216,149,48,0.25)', soft: 'rgba(216,149,48,0.14)' },
  violet:  { primary: '#9966ff', glow: 'rgba(153,102,255,0.25)', soft: 'rgba(153,102,255,0.14)' },
  rose:    { primary: '#e85080', glow: 'rgba(232,80,128,0.25)', soft: 'rgba(232,80,128,0.14)' },
  ice:     { primary: '#a0d8f0', glow: 'rgba(160,216,240,0.22)', soft: 'rgba(160,216,240,0.12)' },
}

export function getActiveTheme(): ThemeTokens {
  const s = loadSettings()
  return THEME_PRESETS[s.nexusTheme] ?? THEME_PRESETS['dark-matter']
}

// Maps legacy/old NexusTheme IDs to the new global data-nexus-theme attribute values
const LEGACY_THEME_MAP: Partial<Record<NexusTheme, string>> = {
  'dark-matter':     'dark',
  'midnight-glass':  'executive',
  'tactical-blue':   'blueprint',
  'carbon-gold':     'executive',
  'monochrome-ops':  'monochrome',
  'infrared':        'red_ops',
  'arctic-signal':   'night_vision',
  'operator-black':  'dark',
}

export function resolveDataThemeAttr(nexusTheme: NexusTheme): string {
  return LEGACY_THEME_MAP[nexusTheme] ?? nexusTheme
}

export function applyThemeToDOM(): void {
  const theme = getActiveTheme()
  const settings = loadSettings()
  const accent = ACCENT_PALETTES[settings.accentPalette] ?? ACCENT_PALETTES.cyan
  const root = document.documentElement

  // Set the theme attribute — nexus-theme.css variables cascade from here
  root.setAttribute('data-nexus-theme', resolveDataThemeAttr(settings.nexusTheme))
  root.setAttribute('data-nexus-accent', settings.accentPalette)

  // Legacy vars still used by components not yet on --nx-* variables
  root.style.setProperty('--nx-bg', theme.bg)
  root.style.setProperty('--nx-surface', theme.surface)
  root.style.setProperty('--nx-elevated', theme.elevated)
  root.style.setProperty('--nx-border', theme.border)
  root.style.setProperty('--nx-accent', accent.primary)
  root.style.setProperty('--nx-accent-glow', accent.glow)
  root.style.setProperty('--nx-accent-soft', accent.soft)
  root.style.setProperty('--nx-text-primary', theme.textPrimary)
  root.style.setProperty('--nx-text-secondary', theme.textSecondary)
  root.style.setProperty('--nx-text-muted', theme.textMuted)
}
