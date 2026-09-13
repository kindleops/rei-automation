import { useCallback, useEffect, useState } from 'react'
import { getQueueControlSettings } from '../../lib/api/backendClient'
import { getQueueProcessorHealth, type QueueProcessorHealth } from '../../lib/data/inboxData'
import type {
  CampaignControlDiagnostics,
  QueueCommandCaps,
  QueueCommandMode,
} from '../inbox/components/QueueCommandCenter'

/**
 * REAL queue operating state for the mobile shell.
 *
 * PortableCommandShell — the top bar on every route outside the inbox family — used to
 * render the Queue Intelligence sheet with a mode and caps that were LITERALS in the
 * component:
 *
 *     const queueMode: QueueCommandMode = 'assisted'
 *     const queueCaps = { sends_per_run: 25, max_per_number_per_day: 200, ... }
 *
 * None of those numbers came from anywhere. They did not match the caps the inbox top
 * bar showed for the same system (10 / 40 / 75 by default, then reconciled against
 * system_control), and they did not match production. An operator opening the queue
 * sheet from Campaigns was reading invented throughput limits for a live SMS system.
 *
 * This hook reads the same authority the inbox path reads — the queue control
 * diagnostics endpoint — so both top bars answer the same question the same way, and
 * a cap that has not loaded yet is reported as unknown rather than guessed.
 */

/**
 * Only used until the control endpoint answers. Kept identical to InboxPage's
 * DEFAULT_QUEUE_COMMAND_CAPS so the two top bars cannot show different numbers for the
 * same system during the first second after boot.
 */
const DEFAULT_QUEUE_COMMAND_CAPS: QueueCommandCaps = {
  sends_per_run: 10,
  auto_replies_per_run: 10,
  followups_per_run: 25,
  first_touches_per_run: 25,
  max_per_number_per_day: 40,
  max_per_market_per_hour: 75,
}

/**
 * The control endpoint answers with `queue_*` keys that CampaignControlDiagnostics does
 * not declare (it declares the un-prefixed aliases). InboxPage reads both; so does this.
 */
const control_ = (diagnostics: CampaignControlDiagnostics, key: string): unknown =>
  (diagnostics as unknown as Record<string, unknown>)[key]

/** Mirrors InboxPage.queueModeFromControl — the mode is derived, never assumed. */
const queueModeFromControl = (diagnostics?: CampaignControlDiagnostics | null): QueueCommandMode => {
  const campaignMode = String(diagnostics?.campaign_mode || '').toLowerCase()
  const processorMode = String(diagnostics?.queue_processor_mode || '').toLowerCase()
  if (campaignMode === 'paused' || processorMode === 'off' || processorMode === 'paused') return 'paused'
  if (campaignMode === 'live_limited' || processorMode === 'live' || processorMode === 'automatic') return 'automatic'
  return 'assisted'
}

export interface QueueCommandState {
  health: QueueProcessorHealth | null
  control: CampaignControlDiagnostics | null
  mode: QueueCommandMode
  caps: QueueCommandCaps
  loading: boolean
  /** False until the control endpoint has answered — the caps are defaults, not truth. */
  hydrated: boolean
  refresh: () => void
}

export function useQueueCommandState(pollMs = 60_000): QueueCommandState {
  const [health, setHealth] = useState<QueueProcessorHealth | null>(null)
  const [control, setControl] = useState<CampaignControlDiagnostics | null>(null)
  const [mode, setMode] = useState<QueueCommandMode>('paused')
  const [caps, setCaps] = useState<QueueCommandCaps>(DEFAULT_QUEUE_COMMAND_CAPS)
  const [loading, setLoading] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [healthResult, controlResult] = await Promise.allSettled([
        getQueueProcessorHealth(),
        getQueueControlSettings(),
      ])

      setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null)

      if (controlResult.status === 'fulfilled' && controlResult.value.ok) {
        const diagnostics = controlResult.value.data?.diagnostics as CampaignControlDiagnostics | undefined
        if (diagnostics) {
          setControl(diagnostics)
          setMode(queueModeFromControl(diagnostics))
          setCaps((current) => ({
            ...current,
            sends_per_run: Math.max(1, Number(
              control_(diagnostics, 'queue_run_limit') || diagnostics.max_batch_size || current.sends_per_run,
            )),
            max_per_number_per_day: Math.max(1, Number(
              control_(diagnostics, 'queue_per_number_cap')
              || control_(diagnostics, 'queue_sender_throttle')
              || diagnostics.per_number_cap
              || current.max_per_number_per_day,
            )),
            max_per_market_per_hour: Math.max(1, Number(
              control_(diagnostics, 'queue_market_cap')
              || control_(diagnostics, 'queue_market_throttle')
              || diagnostics.market_cap
              || current.max_per_market_per_hour,
            )),
          }))
          setHydrated(true)
        }
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    // Deferred by a microtask so the effect body itself performs no synchronous
    // setState — refresh() flips `loading` on its first line.
    void Promise.resolve().then(() => { if (!cancelled) void refresh() })
    const interval = window.setInterval(() => { void refresh() }, pollMs)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [pollMs, refresh])

  return {
    health,
    control,
    mode,
    caps,
    loading,
    hydrated,
    refresh: () => { void refresh() },
  }
}
