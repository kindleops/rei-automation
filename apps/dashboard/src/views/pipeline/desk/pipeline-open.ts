/**
 * PIPELINE · CROSS-APP OPENS — every way the desktop Pipeline hands a deal to
 * another application, in one place.
 *
 * THE TRAP THIS REPLACES. Pipeline is hosted by InboxPage (/pipeline renders
 * the Inbox workspace in "pipeline" mode). "Open conversation" and "Deal
 * Intelligence" used to call that host's callbacks, which flipped the host's
 * own internal workspace views to the SMS thread or to the Inbox's embedded
 * IntelligencePanel — no URL change, no history entry, the sidebar still on
 * Pipeline. The operator was stuck inside the conversation with no way back,
 * and the "Deal Intelligence" they saw was the Inbox panel, not the app.
 *
 * THE RULE NOW (Shell 6.0 interaction grammar): Open Beside.
 *   - the target app opens in a new pane beside Pipeline, or — one instance
 *     per app — the open instance is focused and re-aimed at the deal;
 *   - Pipeline stays mounted with its mode, filters, scroll and selection;
 *   - the deal is published as the linked subject first, so open linked
 *     panes follow it too.
 * When the workspace cannot place a pane (it is full, or no shell is
 * running) the target takes this pane through a real navigation — a history
 * entry, so Back works — and Pipeline's exact state is saved first and
 * restored when the operator comes back (./pipeline-return).
 *
 * Nothing here writes business data. Opening a conversation is the explicit
 * "Open conversation" (thread-read-policy: an open, never a background read).
 */
import { pushRoutePath } from '../../../app/router'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { stageInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import { announceWorkspace, isWorkspaceRunning, openApp } from '../../../modules/desktop/workspace/workspace-store'
import type { DeskCard } from './pipeline-desk-api'

export type PipelineTarget = 'conversation' | 'deal_intelligence' | 'entity_graph' | 'buyer_match' | 'comps' | 'closing'

type CardIds = Pick<DeskCard, 'id'> & Partial<Pick<DeskCard, 'propertyId' | 'threadKey' | 'masterOwnerId' | 'address'>>

const LABEL: Record<PipelineTarget, string> = {
  conversation: 'Inbox',
  deal_intelligence: 'Deal Intelligence',
  entity_graph: 'Entity Graph',
  buyer_match: 'Buyer Match',
  comps: 'Comp Intelligence',
  closing: 'Closing Desk',
}

const q = (o: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) s.set(k, v)
  const t = s.toString()
  return t ? `?${t}` : ''
}

/**
 * The canonical path for a deal in the target app, or null when the deal has
 * no identifier that app can open. Pure — tested.
 *
 * Deal Intelligence is THE app (/deal-intelligence, the desktop decision
 * room), aimed by property first (its canonical subject), thread second.
 */
export function pipelineTargetPath(target: PipelineTarget, c: CardIds): string | null {
  const pid = c.propertyId || null
  switch (target) {
    case 'conversation':
      return c.threadKey ? `/inbox${q({ thread: c.threadKey })}` : null
    case 'deal_intelligence':
      if (pid) return `/deal-intelligence${q({ property_id: pid })}`
      return c.threadKey ? `/deal-intelligence${q({ thread_key: c.threadKey })}` : null
    case 'entity_graph':
      return pid ? `/entity-graph/property/${encodeURIComponent(pid)}` : null
    case 'buyer_match':
      return pid ? `/buyer-match${q({ property_id: pid })}` : null
    case 'comps':
      return pid ? `/comp-intelligence${q({ property_id: pid })}` : null
    case 'closing':
      return pid || c.masterOwnerId ? `/closing-desk${q({ property_id: pid, master_owner_id: c.masterOwnerId })}` : '/closing-desk'
    default:
      return null
  }
}

export interface OpenDeps {
  running: () => boolean
  openBeside: (path: string) => 'opened' | 'moved' | 'focused' | 'refused'
  navigate: (path: string) => void
  publish: (c: CardIds) => void
  stageThread: (threadKey: string, propertyId: string | null) => void
  announce: (text: string) => void
  /** save Pipeline's exact state before this pane is taken over */
  saveReturn: () => void
}

const DEFAULT_DEPS: Omit<OpenDeps, 'saveReturn'> = {
  running: isWorkspaceRunning,
  openBeside: (path) => openApp(path, 'beside'),
  navigate: pushRoutePath,
  publish: (c) => { setPropertyLocator({ propertyId: c.propertyId ?? undefined, threadKey: c.threadKey ?? undefined, masterOwnerId: c.masterOwnerId ?? undefined, opportunityId: c.id, address: c.address ?? undefined }) },
  stageThread: (threadKey, propertyId) => stageInboxThread({ threadKey, propertyId }),
  announce: announceWorkspace,
}

export type OpenOutcome = 'beside' | 'focused' | 'navigated' | 'unavailable'

/** Open the deal in the target app beside Pipeline (see the module comment). */
export function openFromPipeline(target: PipelineTarget, card: CardIds, deps: Partial<OpenDeps> & Pick<OpenDeps, 'saveReturn'>): OpenOutcome {
  const d: OpenDeps = { ...DEFAULT_DEPS, ...deps }
  const path = pipelineTargetPath(target, card)
  if (!path) return 'unavailable'
  d.publish(card)
  // The Inbox opens exactly this conversation when it mounts or is focused.
  if (target === 'conversation' && card.threadKey) d.stageThread(card.threadKey, card.propertyId ?? null)
  if (d.running()) {
    const r = d.openBeside(path)
    if (r === 'focused') return 'focused'
    if (r !== 'refused') return 'beside'
    d.announce(`${LABEL[target]} opened here — the workspace has no room beside Pipeline. Back returns to Pipeline.`)
  }
  d.saveReturn()
  d.navigate(path)
  return 'navigated'
}
