import { useEffect } from 'react'
import * as L from './layout'
import { closeApp, focusPane, getWorkspace, toggleMaximize } from './workspace-store'

/**
 * Workspace keyboard — chosen to avoid the browser's own chords (⌘W, ⌘1-9,
 * ⌥⌘←/→) and never active while the operator is typing:
 *   ⌥⇧ ←/→/↑/↓   focus the neighbouring pane
 *   ⌥⇧ M          maximize / restore the focused pane
 *   ⌥⇧ W          close the focused app
 */
const editing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
}

function rects(): Record<string, L.Rect> {
  const out: Record<string, L.Rect> = {}
  document.querySelectorAll<HTMLElement>('[data-ws-pane]').forEach((el) => {
    const r = el.getBoundingClientRect()
    out[el.dataset.wsPane!] = { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  return out
}

export function useWorkspaceKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey || editing(e.target)) return
      const ws = getWorkspace().layout
      const side: L.Side | null = e.code === 'ArrowLeft' ? 'left' : e.code === 'ArrowRight' ? 'right' : e.code === 'ArrowUp' ? 'top' : e.code === 'ArrowDown' ? 'bottom' : null
      if (side) {
        const to = L.neighbour(ws, ws.focus, side, rects())
        if (to) { e.preventDefault(); focusPane(to) }
        return
      }
      if (e.code === 'KeyM' && L.panes(ws.root).length > 1) { e.preventDefault(); toggleMaximize(ws.focus) }
      else if (e.code === 'KeyW') {
        const pane = L.findPane(ws.root, ws.focus)
        if (pane) { e.preventDefault(); closeApp(pane.active) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
