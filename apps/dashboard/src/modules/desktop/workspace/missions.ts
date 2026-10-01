import { getApp, type AppId } from '../../../domain/app-registry/app-registry'
import { resolveAppDestination } from '../../../domain/app-registry/contextual-navigation'
import type { PropertyLocator } from '../../../domain/locator/property-locator'
import type { Zone } from './layout'

/**
 * MISSIONS — a task-shaped workspace around one real subject.
 *
 * A mission is NOT automation: it performs no work, writes nothing and owns no
 * state beyond the arrangement it composed. "Work this seller" opens Inbox on
 * the seller's thread with Deal Intelligence, Comps and Map aimed at the same
 * property; the operator then works. Exiting returns the exact workspace that
 * was there before (the store keeps it).
 *
 * This module is pure: a mission kind + subject → the panes to compose. Every
 * destination is the app's own contextual URL (the registry's declared
 * context support, or a query parameter the app is known to read), so a
 * mission can never aim an app at a subject it does not understand.
 */

export type MissionKind = 'work_seller' | 'move_deal' | 'run_campaign' | 'close_deal'

export interface MissionSubject {
  /** what the Command Deck names: an address, a campaign, a closing */
  label: string
  propertyId?: string | null
  threadKey?: string | null
  prospectId?: string | null
  masterOwnerId?: string | null
  opportunityId?: string | null
  campaignId?: string | null
  closingId?: string | null
  address?: string | null
}

/** One pane of a composed mission: the first anchors, the rest place relative to an earlier pane. */
export interface MissionPane {
  path: string
  /** index of an earlier pane in the plan, and where to go relative to it */
  at: { of: number; zone: Extract<Zone, 'right' | 'bottom' | 'stack'> } | null
}

export interface MissionPlan {
  kind: MissionKind
  title: string
  subject: MissionSubject
  panes: MissionPane[]
  /** the property context the linked workspace follows, when the subject has one */
  locator: Partial<PropertyLocator> | null
}

export interface MissionDef {
  kind: MissionKind
  title: string
  /** the Command Deck verb: "Work seller", "Run campaign" */
  verb: string
  description: string
  /** which subject fields make this mission meaningful */
  accepts: (s: MissionSubject) => boolean
}

export const MISSIONS: MissionDef[] = [
  { kind: 'work_seller', title: 'Work seller', verb: 'Work this seller', description: 'Inbox with Deal Intelligence, Comps and Map on the same property', accepts: (s) => Boolean(s.threadKey || s.propertyId) },
  { kind: 'move_deal', title: 'Move deal', verb: 'Move this deal', description: 'Pipeline with Buyer Match, Comp Intelligence and Entity Graph', accepts: (s) => Boolean(s.opportunityId || s.propertyId) },
  { kind: 'run_campaign', title: 'Run campaign', verb: 'Run this campaign', description: 'Campaign Command with Queue, Workflow Studio and Analytics', accepts: (s) => Boolean(s.campaignId) },
  { kind: 'close_deal', title: 'Close deal', verb: 'Close this deal', description: 'Closing Desk with Email Command and Calendar', accepts: (s) => Boolean(s.closingId) },
]

export const missionDef = (kind: MissionKind): MissionDef => MISSIONS.find((m) => m.kind === kind)!

/** Missions that make sense for this subject, in canonical order. */
export const missionsFor = (s: MissionSubject): MissionDef[] => MISSIONS.filter((m) => m.accepts(s))

const enc = encodeURIComponent

function locatorOf(s: MissionSubject): PropertyLocator | null {
  if (!s.propertyId && !s.threadKey && !s.opportunityId) return null
  return {
    propertyId: s.propertyId ?? null,
    threadKey: s.threadKey ?? null,
    prospectId: s.prospectId ?? null,
    masterOwnerId: s.masterOwnerId ?? null,
    opportunityId: s.opportunityId ?? null,
    address: s.address ?? s.label ?? null,
    setAt: 0,
  }
}

/**
 * The app's own contextual destination for this subject — or its plain route
 * when it cannot read the subject (honest: never a URL that looks focused and
 * is not).
 */
function contextual(app: AppId, loc: PropertyLocator | null): string {
  const def = getApp(app)
  if (!def) return `/${app}`
  if (!loc) return def.route
  const dest = resolveAppDestination(def, loc, 'contextual')
  return dest.path ?? def.route
}

export function planMission(kind: MissionKind, subject: MissionSubject): MissionPlan | null {
  const def = missionDef(kind)
  if (!def || !def.accepts(subject)) return null
  const loc = locatorOf(subject)
  const pane = (path: string, at: MissionPane['at'] = null): MissionPane => ({ path, at })
  let panes: MissionPane[]
  switch (kind) {
    case 'work_seller':
      // Inbox anchors on the left; Deal Intelligence (Comps one tab away) above Map on the right
      panes = [
        // Inbox seeds its thread from the locator the store publishes at start
        pane(contextual('inbox', loc)),
        pane(contextual('deal-intelligence', loc), { of: 0, zone: 'right' }),
        pane(contextual('comp-intelligence', loc), { of: 1, zone: 'stack' }),
        pane(contextual('map', loc), { of: 1, zone: 'bottom' }),
      ]
      break
    case 'move_deal':
      panes = [
        pane(contextual('pipeline', loc)),
        pane(contextual('buyer-match', loc), { of: 0, zone: 'right' }),
        pane(contextual('entity-graph', loc), { of: 1, zone: 'stack' }),
        pane(contextual('comp-intelligence', loc), { of: 1, zone: 'bottom' }),
      ]
      break
    case 'run_campaign':
      panes = [
        pane(`/campaign-command?campaign=${enc(subject.campaignId!)}`),
        pane('/queue', { of: 0, zone: 'right' }),
        pane('/analytics', { of: 1, zone: 'stack' }),
        pane('/workflow-studio', { of: 1, zone: 'bottom' }),
      ]
      break
    case 'close_deal':
      panes = [
        pane(`/closing-desk?case=${enc(subject.closingId!)}`),
        pane('/email-command', { of: 0, zone: 'right' }),
        pane('/calendar', { of: 1, zone: 'bottom' }),
      ]
      break
  }
  return { kind, title: def.title, subject, panes, locator: loc }
}
