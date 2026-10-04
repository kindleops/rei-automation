/**
 * THE REAL APP, NOT THE EMBEDDED IMPOSTOR (desktop hosts of InboxPage).
 *
 * The Map and the classic Calendar are InboxPage instances; their "Deal
 * Intelligence" swapped the host's internal view to the embedded
 * IntelligencePanel — no URL change, no history entry, the operator trapped.
 * Same rule the Pipeline desk uses (views/pipeline/desk/pipeline-open.ts):
 * publish the subject as the linked property, open the real
 * /deal-intelligence beside (or focus the open instance); when the workspace
 * cannot place a pane, a real navigation with a history entry, so Back works.
 * Nothing here writes business data.
 */
import { pushRoutePath } from '../../app/router'
import { setPropertyLocator } from '../../domain/locator/property-locator'
import { announceWorkspace, isWorkspaceRunning, openApp } from '../desktop/workspace/workspace-store'

export interface RealAppSubject {
  propertyId: string | null
  threadKey: string | null
  masterOwnerId?: string | null
  address?: string | null
}

export function dealIntelligencePath(s: RealAppSubject): string | null {
  if (s.propertyId) return `/deal-intelligence?property_id=${encodeURIComponent(s.propertyId)}`
  if (s.threadKey) return `/deal-intelligence?thread_key=${encodeURIComponent(s.threadKey)}`
  return null
}

export interface OpenRealDeps {
  running: () => boolean
  openBeside: (path: string) => 'opened' | 'moved' | 'focused' | 'refused'
  navigate: (path: string) => void
  publish: (s: RealAppSubject) => void
  announce: (text: string) => void
}

const DEFAULTS: OpenRealDeps = {
  running: isWorkspaceRunning,
  openBeside: (path) => openApp(path, 'beside'),
  navigate: pushRoutePath,
  publish: (s) => setPropertyLocator({
    propertyId: s.propertyId ?? undefined,
    threadKey: s.threadKey ?? undefined,
    masterOwnerId: s.masterOwnerId ?? undefined,
    address: s.address ?? undefined,
  }),
  announce: announceWorkspace,
}

export type RealOpenOutcome = 'beside' | 'focused' | 'navigated' | 'unavailable'

export function openRealDealIntelligence(subject: RealAppSubject, deps: Partial<OpenRealDeps> = {}): RealOpenOutcome {
  const d = { ...DEFAULTS, ...deps }
  const path = dealIntelligencePath(subject)
  if (!path) return 'unavailable'
  d.publish(subject)
  if (d.running()) {
    const r = d.openBeside(path)
    if (r === 'focused') return 'focused'
    if (r !== 'refused') return 'beside'
    d.announce('Deal Intelligence opened here — the workspace has no room beside. Back returns.')
  }
  d.navigate(path)
  return 'navigated'
}
