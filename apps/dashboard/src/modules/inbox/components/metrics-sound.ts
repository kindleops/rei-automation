/**
 * metrics-sound — audio alert helpers for the NEXUS metrics war room.
 *
 * Extracted from MetricsWarRoom.tsx so that the component module exports ONLY
 * React components. Mixing component and non-component exports in a single file
 * breaks React Fast Refresh ("[vite] Failed to reload …"), because the module
 * can no longer be treated as a self-accepting HMR boundary.
 */

import type { KpiAlert } from '../../../lib/data/kpiDashboardData'

export type SoundMode = 'off' | 'critical' | 'war_room' | 'soft'

export const SOUND_LABELS: Record<SoundMode, string> = {
  off: 'SND:OFF',
  critical: 'SND:CRIT',
  war_room: 'SND:WAR',
  soft: 'SND:SOFT',
}

let _audioCtx: AudioContext | null = null
function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!_audioCtx) _audioCtx = new AudioContext()
    return _audioCtx
  } catch { return null }
}

export function playAlertSound(severity: KpiAlert['severity'], mode: SoundMode): void {
  if (mode === 'off') return
  if (mode === 'critical' && severity !== 'critical') return
  const ctx = getAudioCtx()
  if (!ctx) return
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    const t = ctx.currentTime
    const vol = mode === 'war_room' ? 0.16 : 0.08
    if (severity === 'critical') {
      osc.frequency.setValueAtTime(880, t)
      osc.frequency.setValueAtTime(660, t + 0.12)
      gain.gain.setValueAtTime(vol, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38)
      osc.start(t); osc.stop(t + 0.38)
    } else if (severity === 'warning') {
      osc.frequency.setValueAtTime(660, t)
      gain.gain.setValueAtTime(vol * 0.6, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
      osc.start(t); osc.stop(t + 0.22)
    } else {
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, t)
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.1)
      gain.gain.setValueAtTime(vol * 0.4, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
      osc.start(t); osc.stop(t + 0.18)
    }
  } catch { /* non-fatal */ }
}
