/**
 * NEXUS CopilotShell — Mode Orchestrator
 *
 * Top-level copilot component that reads copilotMode from settings
 * and renders the appropriate presence:
 * - Orb: Floating neural core trigger (always visible when enabled)
 * - Sidecar: Right-edge intelligence rail (on-demand)
 * - Console: Full workspace intelligence surface (on-demand)
 *
 * Handles mode transitions, open/close state, and action forwarding.
 */

import { useState, useEffect, useCallback } from 'react'
import type { CopilotMode, ResolvedIntent } from './copilot-state'
import { CopilotOrb } from './CopilotOrb'
import { CopilotSidecar } from './CopilotSidecar'
import type { CopilotContext } from './CopilotSidecar'
import { CopilotConsole } from './CopilotConsole'
import { loadSettings, subscribeSettings } from '../settings'
import type { NexusSettings } from '../settings'

interface CopilotShellProps {
  open: boolean
  context: CopilotContext
  onClose: () => void
  onAction: (intent: ResolvedIntent) => void
  onToggle: () => void
}

export function CopilotShell({ open, context, onClose, onAction, onToggle }: CopilotShellProps) {
  const [settings, setSettings] = useState<NexusSettings>(loadSettings)
  const [orbState, setOrbState] = useState<'idle' | 'listening' | 'greeting'>('idle')
  const [orbAmplitude] = useState(0)

  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), [])

  const mode: CopilotMode = (settings.copilotMode as CopilotMode) ?? 'sidecar'
  const enabled = settings.copilotEnabled !== false

  if (!enabled) return null

  const handleOrbClick = useCallback(() => {
    onToggle()
  }, [onToggle])

  const handlePushToTalk = useCallback(() => {
    setOrbState('listening')
    // Actual voice activation is handled inside Sidecar/Console
    if (!open) onToggle()
  }, [open, onToggle])

  const handlePushToTalkRelease = useCallback(() => {
    setOrbState('idle')
  }, [])

  const handleAction = useCallback((intent: ResolvedIntent) => {
    onAction(intent)
  }, [onAction])

  return (
    <>
      {/* Orb — always rendered as floating trigger */}
      {!open && (
        <CopilotOrb
          state={orbState === 'listening' ? 'listening' : 'idle'}
          amplitude={orbAmplitude}
          onClick={handleOrbClick}
          onPushToTalk={handlePushToTalk}
          onPushToTalkRelease={handlePushToTalkRelease}
          className="nx-copilot-orb--floating"
        />
      )}

      {/* Sidecar mode */}
      {mode === 'sidecar' && (
        <CopilotSidecar
          open={open}
          context={context}
          onClose={onClose}
          onAction={handleAction}
        />
      )}

      {/* Console mode */}
      {mode === 'console' && (
        <CopilotConsole
          open={open}
          context={context}
          onClose={onClose}
          onAction={handleAction}
        />
      )}

      {/* Orb-only mode — still uses sidecar when opened */}
      {mode === 'orb' && open && (
        <CopilotSidecar
          open={open}
          context={context}
          onClose={onClose}
          onAction={handleAction}
        />
      )}
    </>
  )
}

export type { CopilotContext } from './CopilotSidecar'
