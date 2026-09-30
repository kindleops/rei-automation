import type { IconName } from '../../../shared/icons'
import type { NodeFamily, WorkflowFamily } from './observatory-types'

/**
 * Node families: one restrained semantic colour each, never a rainbow.
 *   trigger cobalt · action cyan · AI / decision violet · wait amber ·
 *   approval / human gold · success green · failure red · system graphite.
 * Geometry carries the meaning before colour does (entry capsule, glass
 * rectangle, split decision, timing capsule, gold-edged human plane, small
 * terminal), so the board still reads in monochrome and for colour-blind eyes.
 */
export interface FamilyMeta {
  label: string
  tone: 'cobalt' | 'cyan' | 'violet' | 'amber' | 'gold' | 'graphite' | 'green' | 'red'
  shape: 'capsule' | 'rect' | 'split' | 'timer' | 'plane' | 'stack' | 'terminal' | 'portal' | 'loop'
  icon: IconName
  w: number
  h: number
}

export const FAMILY: Record<NodeFamily, FamilyMeta> = {
  TRIGGER: { label: 'Trigger', tone: 'cobalt', shape: 'capsule', icon: 'bolt', w: 224, h: 63 },
  ACTION: { label: 'Action', tone: 'cyan', shape: 'rect', icon: 'zap', w: 216, h: 72 },
  AI: { label: 'AI · Classification', tone: 'violet', shape: 'rect', icon: 'brain', w: 216, h: 72 },
  DECISION: { label: 'Decision', tone: 'violet', shape: 'split', icon: 'target', w: 216, h: 72 },
  CONDITION: { label: 'Condition', tone: 'violet', shape: 'split', icon: 'filter', w: 216, h: 72 },
  WAIT: { label: 'Wait', tone: 'amber', shape: 'timer', icon: 'clock', w: 207, h: 60 },
  APPROVAL: { label: 'Approval', tone: 'gold', shape: 'plane', icon: 'check', w: 224, h: 76 },
  HUMAN_REVIEW: { label: 'Human review', tone: 'gold', shape: 'plane', icon: 'user', w: 224, h: 76 },
  SUBWORKFLOW: { label: 'Subworkflow', tone: 'graphite', shape: 'stack', icon: 'layers', w: 224, h: 76 },
  RETRY: { label: 'Retry', tone: 'amber', shape: 'loop', icon: 'refresh-cw', w: 185, h: 58 },
  DATA_LOOKUP: { label: 'Data lookup', tone: 'graphite', shape: 'rect', icon: 'database', w: 216, h: 72 },
  STATE_CHANGE: { label: 'State change', tone: 'graphite', shape: 'rect', icon: 'activity', w: 216, h: 72 },
  NOTIFICATION: { label: 'Notification', tone: 'graphite', shape: 'rect', icon: 'bell', w: 202, h: 63 },
  TERMINAL: { label: 'End', tone: 'graphite', shape: 'terminal', icon: 'check', w: 158, h: 49 },
  HANDOFF: { label: 'Handoff', tone: 'cobalt', shape: 'portal', icon: 'external-link', w: 224, h: 63 },
}

export const WORKFLOW_FAMILY_LABEL: Record<WorkflowFamily, string> = {
  SELLER: 'Seller', ACQUISITION: 'Acquisition', COMMUNICATION: 'Communication', CAMPAIGN: 'Campaign',
  DELIVERY: 'Delivery', EMAIL: 'Email', BUYER: 'Buyer', CLOSING: 'Closing', SYSTEM: 'System',
}

export const WORKFLOW_FAMILY_ICON: Record<WorkflowFamily, IconName> = {
  SELLER: 'message', ACQUISITION: 'target', COMMUNICATION: 'bell', CAMPAIGN: 'bolt',
  DELIVERY: 'send', EMAIL: 'mail', BUYER: 'users', CLOSING: 'key', SYSTEM: 'cpu',
}

export const EDGE_LABEL: Record<string, string> = {
  yes: 'YES', no: 'NO', blocked: 'IF BLOCKED', failed: 'IF FAILED', timeout: 'TIMEOUT', retry: 'RETRY',
}

/** Terminal tone: a terminal's colour is its meaning (done / failed / human). */
export const terminalTone = (t: string | null | undefined): FamilyMeta['tone'] =>
  t === 'success' ? 'green' : t === 'failure' ? 'red' : t === 'human' ? 'gold' : 'graphite'
