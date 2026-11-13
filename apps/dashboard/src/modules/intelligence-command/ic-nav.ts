import * as L from '../desktop/workspace/layout'
import { getWorkspace, openApp, toggleMaximize } from '../desktop/workspace/workspace-store'

export const IC_ROUTE = '/intelligence-command'
export const IC_APP_ID = 'intelligence-command'

/** Fill the workspace with the Intelligence Command pane (no-op when it already does). */
export function maximizeIntelligenceCommand() {
  const ws = getWorkspace()
  const inst = L.instanceForApp(ws.layout, IC_APP_ID)
  const pane = inst ? L.paneOf(ws.layout, inst.id) : null
  if (pane && ws.layout.maximized !== pane.id) toggleMaximize(pane.id)
}

/** Open Intelligence Command (one instance, like every app) and let it fill the workspace. */
export function openIntelligenceCommand() {
  openApp(IC_ROUTE, 'beside')
  // the layout settles after the open; maximize the pane that now holds it
  window.setTimeout(maximizeIntelligenceCommand, 0)
}

export const isIcFocused = () => L.focusedInstance(getWorkspace().layout)?.app === IC_APP_ID
