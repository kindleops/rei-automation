import type { IconName } from '../../../../shared/icons'
import type { NodeFamily, SystemEdgeKind, WorkflowFamily } from './types'

/**
 * NODE FAMILIES — restrained semantic colour, never a rainbow.
 *   trigger cobalt · action cyan · decision violet · wait amber ·
 *   approval gold · external teal · completion green · failure red (only
 *   on actual failure) · everything else graphite.
 * Geometry carries the meaning before colour does (entry capsule, glass
 * module, chamfered decision, timer, gold plane, stacked subworkflow, portal,
 * small terminal), so a board still reads in monochrome.
 */
export type Tone = 'cobalt' | 'cyan' | 'violet' | 'amber' | 'gold' | 'teal' | 'green' | 'red' | 'graphite'
export type Shape = 'capsule' | 'module' | 'split' | 'timer' | 'plane' | 'stack' | 'portal' | 'loop' | 'terminal'

export interface FamilyMeta {
  /** what the operator reads */
  label: string
  /** the orchestration semantic it maps to */
  kind: 'Trigger' | 'Action' | 'Decision' | 'Wait' | 'Approval' | 'External' | 'Subworkflow' | 'State' | 'Completion'
  tone: Tone
  shape: Shape
  icon: IconName
  w: number
  h: number
}

export const FAMILY: Record<NodeFamily, FamilyMeta> = {
  TRIGGER: { label: 'Trigger', kind: 'Trigger', tone: 'cobalt', shape: 'capsule', icon: 'bolt', w: 212, h: 56 },
  ACTION: { label: 'Action', kind: 'Action', tone: 'cyan', shape: 'module', icon: 'zap', w: 204, h: 60 },
  AI: { label: 'Classification', kind: 'Decision', tone: 'violet', shape: 'module', icon: 'brain', w: 204, h: 60 },
  DECISION: { label: 'Decision', kind: 'Decision', tone: 'violet', shape: 'split', icon: 'target', w: 208, h: 60 },
  CONDITION: { label: 'Condition', kind: 'Decision', tone: 'violet', shape: 'split', icon: 'filter', w: 208, h: 60 },
  WAIT: { label: 'Wait', kind: 'Wait', tone: 'amber', shape: 'timer', icon: 'clock', w: 200, h: 56 },
  RETRY: { label: 'Bounded loop', kind: 'Wait', tone: 'amber', shape: 'loop', icon: 'refresh-cw', w: 196, h: 56 },
  APPROVAL: { label: 'Approval', kind: 'Approval', tone: 'gold', shape: 'plane', icon: 'check', w: 212, h: 62 },
  HUMAN_REVIEW: { label: 'Human review', kind: 'Approval', tone: 'gold', shape: 'plane', icon: 'user', w: 212, h: 62 },
  SUBWORKFLOW: { label: 'Subworkflow', kind: 'Subworkflow', tone: 'graphite', shape: 'stack', icon: 'layers', w: 212, h: 62 },
  HANDOFF: { label: 'External runtime', kind: 'External', tone: 'teal', shape: 'portal', icon: 'external-link', w: 208, h: 58 },
  DATA_LOOKUP: { label: 'Lookup', kind: 'Action', tone: 'graphite', shape: 'module', icon: 'database', w: 200, h: 56 },
  STATE_CHANGE: { label: 'State change', kind: 'State', tone: 'graphite', shape: 'module', icon: 'activity', w: 204, h: 60 },
  NOTIFICATION: { label: 'Notification', kind: 'Action', tone: 'graphite', shape: 'module', icon: 'bell', w: 196, h: 56 },
  TERMINAL: { label: 'End', kind: 'Completion', tone: 'graphite', shape: 'terminal', icon: 'check', w: 150, h: 44 },
}

/** A terminal's colour is its meaning: done · failed · handed to a person · neutral. */
export const terminalTone = (t: string | null | undefined): Tone => (t === 'success' ? 'green' : t === 'failure' ? 'red' : t === 'human' ? 'gold' : 'graphite')

export const WORKFLOW_FAMILY: Record<WorkflowFamily, { label: string; icon: IconName }> = {
  SELLER: { label: 'Seller', icon: 'message' },
  ACQUISITION: { label: 'Acquisition', icon: 'target' },
  COMMUNICATION: { label: 'Communication', icon: 'bell' },
  CAMPAIGN: { label: 'Campaign', icon: 'bolt' },
  DELIVERY: { label: 'Delivery', icon: 'send' },
  EMAIL: { label: 'Email', icon: 'mail' },
  BUYER: { label: 'Buyer', icon: 'users' },
  CLOSING: { label: 'Closing', icon: 'key' },
  SYSTEM: { label: 'System', icon: 'cpu' },
}

export const SYSTEM_EDGE: Record<SystemEdgeKind, { label: string; hint: string }> = {
  event: { label: 'Event', hint: 'reacts to something another runtime recorded' },
  action: { label: 'Action', hint: 'asks another runtime’s canonical interface to act' },
  subworkflow: { label: 'Subworkflow', hint: 'invokes a nested workflow of its own' },
  external: { label: 'External', hint: 'a provider outside LeadCommand' },
  state: { label: 'State', hint: 'writes or reads canonical state another runtime honours' },
}

/** Edge labels in the workflow branch vocabulary, concise. */
export const branchWord = (label: string | null | undefined) => (label ? label.replace(/^IF /, '') : null)
