import * as L from './workspace/layout'
import { getWorkspace, markPaneInteraction as mark, openApp, resetWorkspace, useWorkspace } from './workspace/workspace-store'

/**
 * Compatibility surface for callers of the old flat split workspace. The
 * workspace is now a layout tree (modules/desktop/workspace); these names map
 * onto it so older callers keep working while they migrate.
 */

export const MAIN = 'main'
export const MAX_PANES = 4

export interface SplitPane { id: string; path: string }
export interface SplitState { panes: SplitPane[]; focused: string }

function toSplit(): SplitState {
  const ws = getWorkspace().layout
  const panes = L.panes(ws.root)
    .map((p) => ws.instances[p.active])
    .filter((i): i is L.Instance => Boolean(i) && i.id !== ws.primary)
    .map((i) => ({ id: i.id, path: i.path }))
  return { panes, focused: ws.focus }
}

export const getSplitState = toSplit

export function useSplitWorkspace(): SplitState {
  useWorkspace()
  return toSplit()
}

export function openInSplit(path: string) {
  return openApp(path, 'beside')
}

export function markPaneInteraction(paneId: string) {
  if (paneId !== MAIN) mark(paneId)
}

/** "Close split panes": back to the focused application alone. */
export function clearSplit() {
  resetWorkspace()
}
