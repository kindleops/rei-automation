import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { useClaimedKeys } from '../../../shared/lc/keys'
import { useAppInstance } from '../../../modules/desktop/workspace/instance-context'
import { focusedInstance } from '../../../modules/desktop/workspace/layout'
import { useWorkspace } from '../../../modules/desktop/workspace/workspace-store'
import { mapOverlayTarget } from '../map-overlay-host'
import './map-focus.css'

/**
 * Map focus keys (desktop) — documented in the shortcut sheet:
 *   F             fly back to the selected property (re-frame it)
 *   Esc           clear the selection (the Map's existing card handler)
 *   ⌘/Ctrl+Enter  open the selected property beside
 * Active only while the Map is the focused pane and the operator is not
 * typing; F is claimed while active so the global single-key shortcuts yield.
 * A small leaf component: workspace changes re-render THIS, not the Map.
 */
export function MapFocusKeys({ enabled, onFocusSelected, onOpenBeside }: { enabled: boolean; onFocusSelected: () => void; onOpenBeside: () => void }) {
  const { instanceId } = useAppInstance()
  const ws = useWorkspace()
  const focused = !instanceId || focusedInstance(ws.layout)?.id === instanceId
  const active = enabled && focused
  useClaimedKeys(['f'], active)
  const handlers = useRef({ onFocusSelected, onOpenBeside })
  useEffect(() => { handlers.current = { onFocusSelected, onOpenBeside } })
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        handlers.current.onFocusSelected()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        handlers.current.onOpenBeside()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
  return null
}

/** "Show on Map unavailable" — the honest answer when no canonical location exists. Quiet, dismissible, self-clearing. */
export function MapFocusNotice({ notice, onDismiss }: { notice: { label: string | null; reason: string } | null; onDismiss: () => void }) {
  const dismiss = useRef(onDismiss)
  useEffect(() => { dismiss.current = onDismiss })
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => dismiss.current(), 7000)
    return () => window.clearTimeout(t)
  }, [notice])
  if (!notice || typeof document === 'undefined') return null
  return createPortal(
    <div className="mx-focusset lc-map-focus-notice" style={{ ['--tone' as string]: 'var(--lc-ink-3, #8a94a6)' }} role="status">
      <span className="lc-map-focus-notice__glyph" aria-hidden="true"><Icon name="map" size={13} /></span>
      <span className="mx-focusset__text">
        <b>Show on Map unavailable</b>
        {notice.label ? <span> · {notice.label}</span> : null}
        <span className="lc-map-focus-notice__why"> — {notice.reason}</span>
      </span>
      <button type="button" className="mx-focusset__x" onClick={onDismiss} aria-label="Dismiss"><Icon name="close" /></button>
    </div>,
    mapOverlayTarget(),
  )
}
