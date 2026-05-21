/**
 * NEXUS Sound Design System
 *
 * Premium micro-feedback audio using the Web Audio API.
 * Zero external audio files — all sounds are synthesized for instant playback.
 *
 * Each sound is a short (40–400ms) layered oscillator composition that
 * produces tactile, premium operator-grade audio cues.
 */

import { loadSettings } from './settings'

// ── Types ─────────────────────────────────────────────────────────────────

export type SoundEvent =
  | 'inbound-reply'
  | 'hot-lead-escalation'
  | 'alert-triggered'
  | 'title-clear'
  | 'closing-scheduled'
  | 'buyer-match'
  | 'ai-response'
  | 'autopilot-action'
  | 'notification'
  | 'queue-issue'
  | 'contract-milestone'
  | 'ui-tap'
  | 'ui-confirm'
  | 'ui-error'
  | 'copilot-wake'
  | 'briefing-open'
  | 'split-open'
  | 'toast-arrive'
  | 'voice-start'
  | 'voice-stop'
  | 'command-accept'
  | 'command-complete'
  | 'theme-switch'
  | 'ambient-hum'
  | 'room-enter'
  | 'action-route'

export interface SoundDefinition {
  id: SoundEvent
  label: string
  category: string
  settingsKey: string | null
}

// ── Sound Library ─────────────────────────────────────────────────────────

export const SOUND_LIBRARY: SoundDefinition[] = [
  { id: 'inbound-reply',       label: 'Inbound Reply',         category: 'Communication',  settingsKey: 'soundInboundReply' },
  { id: 'hot-lead-escalation', label: 'Hot Lead Escalation',   category: 'Intelligence',   settingsKey: 'soundHotLeadEscalation' },
  { id: 'alert-triggered',     label: 'Alert Triggered',       category: 'Alerts',         settingsKey: 'soundAlertTriggered' },
  { id: 'title-clear',         label: 'Title Clear',           category: 'Deals',          settingsKey: 'soundTitleClear' },
  { id: 'closing-scheduled',   label: 'Closing Scheduled',     category: 'Deals',          settingsKey: 'soundClosingScheduled' },
  { id: 'buyer-match',         label: 'Buyer Match',           category: 'Intelligence',   settingsKey: 'soundBuyerMatch' },
  { id: 'ai-response',         label: 'AI Response Completed', category: 'AI',             settingsKey: 'soundAiResponse' },
  { id: 'autopilot-action',    label: 'Autopilot Executed',    category: 'AI',             settingsKey: 'soundAutopilotAction' },
  { id: 'notification',        label: 'Notification',          category: 'System',         settingsKey: 'soundNotification' },
  { id: 'queue-issue',         label: 'Queue Issue',           category: 'Alerts',         settingsKey: 'soundQueueIssue' },
  { id: 'contract-milestone',  label: 'Contract Milestone',    category: 'Deals',          settingsKey: 'soundContractMilestone' },
  { id: 'ui-tap',              label: 'Glass Tap',             category: 'Interface',      settingsKey: null },
  { id: 'ui-confirm',          label: 'Soft Confirm',          category: 'Interface',      settingsKey: null },
  { id: 'ui-error',            label: 'Muted Error',           category: 'Interface',      settingsKey: null },
  { id: 'copilot-wake',         label: 'Copilot Wake',          category: 'AI',             settingsKey: 'copilotSoundEnabled' },
  { id: 'briefing-open',        label: 'Briefing Open',         category: 'System',         settingsKey: 'briefingSoundEnabled' },
  { id: 'split-open',           label: 'Split View Open',       category: 'Interface',      settingsKey: null },
  { id: 'toast-arrive',         label: 'Toast Notification',    category: 'System',         settingsKey: 'notificationSoundEnabled' },
  { id: 'voice-start',          label: 'Voice Activated',       category: 'AI',             settingsKey: 'copilotSoundEnabled' },
  { id: 'voice-stop',           label: 'Voice Deactivated',     category: 'AI',             settingsKey: 'copilotSoundEnabled' },
  { id: 'command-accept',       label: 'Command Accepted',      category: 'System',         settingsKey: null },
  { id: 'command-complete',     label: 'Command Completed',     category: 'System',         settingsKey: null },
  { id: 'theme-switch',         label: 'Theme Switch',          category: 'Interface',      settingsKey: null },
  { id: 'ambient-hum',          label: 'Ambient Hum',           category: 'Interface',      settingsKey: null },
  { id: 'room-enter',           label: 'Room Enter',            category: 'Interface',      settingsKey: null },
  { id: 'action-route',         label: 'Action Route',          category: 'AI',             settingsKey: null },
]

// ── Audio Context (lazy singleton) ────────────────────────────────────────

let _ctx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext()
  }
  if (_ctx.state === 'suspended') {
    void _ctx.resume()
  }
  return _ctx
}

// ── Synthesis helpers ─────────────────────────────────────────────────────

function createGain(ctx: AudioContext, volume: number): GainNode {
  const gain = ctx.createGain()
  gain.gain.value = volume
  gain.connect(ctx.destination)
  return gain
}

function playTone(
  ctx: AudioContext,
  dest: GainNode,
  freq: number,
  type: OscillatorType,
  startOffset: number,
  duration: number,
  attack: number,
  decay: number,
  volume: number,
  freqEnd?: number,  // optional end frequency for pitch slides
): void {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(env)
  env.connect(dest)

  const now = ctx.currentTime + startOffset
  env.gain.setValueAtTime(0.0001, now)
  env.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0001), now + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, now + duration - decay * 0.5)

  // Optional frequency slide for organic feel
  if (freqEnd !== undefined) {
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration * 0.8)
  }

  osc.start(now)
  osc.stop(now + duration)
}

// ── Sound compositions ────────────────────────────────────────────────────

type SoundComposer = (ctx: AudioContext, gain: GainNode) => void

const compositions: Record<SoundEvent, SoundComposer> = {
  // Cyan — warm glass ping, ascending dyad with harmonic shimmer
  'inbound-reply': (ctx, g) => {
    playTone(ctx, g, 880, 'sine', 0, 0.20, 0.005, 0.08, 0.38, 920)
    playTone(ctx, g, 1320, 'sine', 0.04, 0.16, 0.005, 0.06, 0.22, 1380)
    playTone(ctx, g, 1760, 'sine', 0.08, 0.12, 0.005, 0.04, 0.10, 1820)
    playTone(ctx, g, 2640, 'sine', 0.10, 0.08, 0.003, 0.03, 0.04)
  },

  // Red — urgent descending sting with growl
  'hot-lead-escalation': (ctx, g) => {
    playTone(ctx, g, 660, 'sawtooth', 0, 0.14, 0.002, 0.05, 0.28, 580)
    playTone(ctx, g, 440, 'sawtooth', 0.06, 0.18, 0.002, 0.08, 0.32, 380)
    playTone(ctx, g, 880, 'sine', 0, 0.22, 0.005, 0.10, 0.13, 840)
  },

  // Red — sharp double-tap alert with metallic ring
  'alert-triggered': (ctx, g) => {
    playTone(ctx, g, 520, 'square', 0, 0.06, 0.001, 0.02, 0.22)
    playTone(ctx, g, 520, 'square', 0.10, 0.06, 0.001, 0.02, 0.22)
    playTone(ctx, g, 780, 'sine', 0.02, 0.16, 0.005, 0.06, 0.10, 820)
    playTone(ctx, g, 1560, 'sine', 0.03, 0.10, 0.003, 0.04, 0.05)
  },

  // Green — warm resolution chime with shimmer tail
  'title-clear': (ctx, g) => {
    playTone(ctx, g, 660, 'sine', 0, 0.28, 0.01, 0.12, 0.32, 680)
    playTone(ctx, g, 990, 'sine', 0.06, 0.22, 0.01, 0.10, 0.22, 1010)
    playTone(ctx, g, 1320, 'sine', 0.12, 0.20, 0.01, 0.08, 0.16, 1350)
    playTone(ctx, g, 1980, 'sine', 0.18, 0.14, 0.008, 0.06, 0.06)
  },

  // Green — success tone, ascending triad
  'closing-scheduled': (ctx, g) => {
    playTone(ctx, g, 440, 'sine', 0, 0.20, 0.008, 0.10, 0.30)
    playTone(ctx, g, 554, 'sine', 0.08, 0.18, 0.008, 0.08, 0.25)
    playTone(ctx, g, 660, 'sine', 0.16, 0.22, 0.008, 0.10, 0.30)
  },

  // Cyan — discovery pulse with rising shimmer
  'buyer-match': (ctx, g) => {
    playTone(ctx, g, 740, 'sine', 0, 0.18, 0.005, 0.06, 0.28, 780)
    playTone(ctx, g, 932, 'triangle', 0.05, 0.14, 0.005, 0.05, 0.18, 960)
    playTone(ctx, g, 1480, 'sine', 0.08, 0.10, 0.004, 0.04, 0.06)
  },

  // Purple — soft AI process cue with resonant tail
  'ai-response': (ctx, g) => {
    playTone(ctx, g, 392, 'sine', 0, 0.32, 0.02, 0.15, 0.18, 410)
    playTone(ctx, g, 523, 'sine', 0.10, 0.28, 0.02, 0.12, 0.14, 540)
    playTone(ctx, g, 784, 'triangle', 0.15, 0.20, 0.01, 0.08, 0.07, 800)
    playTone(ctx, g, 1046, 'sine', 0.20, 0.14, 0.008, 0.06, 0.03)
  },

  // Purple — ambient command blip
  'autopilot-action': (ctx, g) => {
    playTone(ctx, g, 600, 'triangle', 0, 0.08, 0.002, 0.03, 0.20)
    playTone(ctx, g, 900, 'sine', 0.03, 0.12, 0.005, 0.05, 0.15)
  },

  // Neutral — subtle notification chime
  'notification': (ctx, g) => {
    playTone(ctx, g, 1047, 'sine', 0, 0.12, 0.005, 0.05, 0.25)
    playTone(ctx, g, 1319, 'sine', 0.05, 0.10, 0.005, 0.04, 0.15)
  },

  // Amber — muted escalation cue
  'queue-issue': (ctx, g) => {
    playTone(ctx, g, 330, 'sawtooth', 0, 0.15, 0.003, 0.06, 0.18)
    playTone(ctx, g, 277, 'sawtooth', 0.08, 0.15, 0.003, 0.06, 0.18)
  },

  // Green — contract milestone ding
  'contract-milestone': (ctx, g) => {
    playTone(ctx, g, 784, 'sine', 0, 0.20, 0.008, 0.10, 0.30)
    playTone(ctx, g, 1047, 'sine', 0.08, 0.16, 0.008, 0.06, 0.20)
  },

  // UI — glass tap with sparkle
  'ui-tap': (ctx, g) => {
    playTone(ctx, g, 2400, 'sine', 0, 0.05, 0.001, 0.015, 0.10, 2600)
    playTone(ctx, g, 4800, 'sine', 0.005, 0.03, 0.001, 0.01, 0.03)
  },

  // UI — soft confirmation click with chime
  'ui-confirm': (ctx, g) => {
    playTone(ctx, g, 1200, 'sine', 0, 0.07, 0.002, 0.025, 0.13, 1260)
    playTone(ctx, g, 1600, 'sine', 0.02, 0.06, 0.002, 0.02, 0.09, 1660)
  },

  // UI — muted error
  'ui-error': (ctx, g) => {
    playTone(ctx, g, 280, 'square', 0, 0.08, 0.001, 0.03, 0.15)
    playTone(ctx, g, 220, 'square', 0.05, 0.10, 0.001, 0.04, 0.15)
  },

  // AI — copilot activation hum, ascending resonance
  'copilot-wake': (ctx, g) => {
    playTone(ctx, g, 220, 'sine', 0, 0.35, 0.02, 0.15, 0.15, 330)
    playTone(ctx, g, 440, 'sine', 0.10, 0.28, 0.02, 0.12, 0.10, 520)
    playTone(ctx, g, 660, 'triangle', 0.18, 0.20, 0.01, 0.08, 0.06, 720)
  },

  // System — briefing panel arrival, deep tone
  'briefing-open': (ctx, g) => {
    playTone(ctx, g, 180, 'sine', 0, 0.30, 0.01, 0.15, 0.20, 200)
    playTone(ctx, g, 360, 'sine', 0.08, 0.22, 0.01, 0.10, 0.12, 380)
    playTone(ctx, g, 540, 'sine', 0.15, 0.16, 0.008, 0.06, 0.06)
  },

  // Interface — split view slide, soft whoosh
  'split-open': (ctx, g) => {
    playTone(ctx, g, 1800, 'sine', 0, 0.08, 0.002, 0.03, 0.08, 1200)
    playTone(ctx, g, 3600, 'sine', 0.01, 0.05, 0.002, 0.02, 0.03, 2400)
  },

  // System — toast notification ping
  'toast-arrive': (ctx, g) => {
    playTone(ctx, g, 1047, 'sine', 0, 0.10, 0.003, 0.04, 0.20, 1100)
    playTone(ctx, g, 1568, 'sine', 0.04, 0.08, 0.003, 0.03, 0.12)
  },

  // Voice — activation chime, ascending warmth
  'voice-start': (ctx, g) => {
    playTone(ctx, g, 440, 'sine', 0, 0.18, 0.005, 0.08, 0.20, 520)
    playTone(ctx, g, 660, 'sine', 0.06, 0.14, 0.005, 0.06, 0.15, 740)
    playTone(ctx, g, 880, 'triangle', 0.12, 0.12, 0.005, 0.05, 0.08, 940)
  },

  // Voice — deactivation, descending close
  'voice-stop': (ctx, g) => {
    playTone(ctx, g, 660, 'sine', 0, 0.12, 0.003, 0.05, 0.15, 520)
    playTone(ctx, g, 440, 'sine', 0.04, 0.10, 0.003, 0.04, 0.10, 360)
  },

  // Command — crisp acceptance tick
  'command-accept': (ctx, g) => {
    playTone(ctx, g, 1400, 'sine', 0, 0.04, 0.001, 0.01, 0.16, 1500)
    playTone(ctx, g, 2100, 'sine', 0.015, 0.03, 0.001, 0.01, 0.06)
  },

  // Command — completion resolution
  'command-complete': (ctx, g) => {
    playTone(ctx, g, 880, 'sine', 0, 0.15, 0.005, 0.06, 0.22, 920)
    playTone(ctx, g, 1320, 'sine', 0.05, 0.12, 0.005, 0.05, 0.14, 1380)
    playTone(ctx, g, 1760, 'sine', 0.10, 0.10, 0.005, 0.04, 0.06)
  },

  // Theme — deep tonal shift
  'theme-switch': (ctx, g) => {
    playTone(ctx, g, 200, 'sine', 0, 0.25, 0.01, 0.12, 0.12, 240)
    playTone(ctx, g, 400, 'sine', 0.08, 0.20, 0.01, 0.08, 0.08, 420)
    playTone(ctx, g, 600, 'triangle', 0.14, 0.14, 0.008, 0.06, 0.04)
  },

  // Ambient — low continuous hum (short burst)
  'ambient-hum': (ctx, g) => {
    playTone(ctx, g, 110, 'sine', 0, 0.40, 0.05, 0.20, 0.06, 115)
    playTone(ctx, g, 220, 'sine', 0.10, 0.30, 0.04, 0.15, 0.03, 225)
  },

  // Room — surface transition whoosh
  'room-enter': (ctx, g) => {
    playTone(ctx, g, 2400, 'sine', 0, 0.06, 0.001, 0.02, 0.06, 1600)
    playTone(ctx, g, 800, 'sine', 0.02, 0.10, 0.005, 0.04, 0.10, 900)
  },

  // Action — routing progress tone
  'action-route': (ctx, g) => {
    playTone(ctx, g, 600, 'triangle', 0, 0.06, 0.002, 0.02, 0.12)
    playTone(ctx, g, 800, 'triangle', 0.08, 0.06, 0.002, 0.02, 0.12)
    playTone(ctx, g, 1000, 'sine', 0.16, 0.08, 0.003, 0.03, 0.08)
  },
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Play a sound event if enabled in settings.
 * Safe to call at any time — silently no-ops if sound is disabled
 * or the specific event category is turned off.
 */
export function playSound(event: SoundEvent): void {
  const settings = loadSettings()
  if (!settings.soundEnabled) return

  // Check per-event toggle
  const def = SOUND_LIBRARY.find((s) => s.id === event)
  if (def?.settingsKey) {
    const key = def.settingsKey as keyof typeof settings
    if (settings[key] === false) return
  }

  const ctx = getAudioContext()
  const masterGain = createGain(ctx, settings.soundVolume)
  const composer = compositions[event]
  composer(ctx, masterGain)
}

/**
 * Preview a sound at full volume, ignoring per-event toggles.
 * Used in Settings to audition sounds.
 */
export function previewSound(event: SoundEvent): void {
  const ctx = getAudioContext()
  const masterGain = createGain(ctx, 0.6)
  const composer = compositions[event]
  composer(ctx, masterGain)
}
