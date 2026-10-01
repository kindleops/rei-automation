import type { IconName } from '../../../shared/icons'
import type { MissionSubject } from '../workspace/missions'
import type { EntityRef, EntityType } from './inspector-store'

/**
 * HOW EACH OBJECT TYPE IS INSPECTED.
 *
 * A renderer reads the owning application's EXISTING endpoint and shapes the
 * answer into one consistent model: identity, status, the few facts that
 * matter, relationships (each itself inspectable), latest real activity and
 * where to go next. It never writes and never invents: a value the read did
 * not return is absent, not estimated.
 */

export type InspectorTone = 'neutral' | 'live' | 'attention' | 'ok' | 'crit'

export interface InspectorModel {
  title: string
  subtitle?: string | null
  /** identity line under the title (market, stage, type) */
  eyebrow?: string | null
  status?: { label: string; tone: InspectorTone } | null
  /** the facts that matter for this type, in order (value omitted = not recorded) */
  facts: Array<{ label: string; value: string | null; hint?: string }>
  /** money/value facts kept apart from identity facts */
  value?: Array<{ label: string; value: string | null; hint?: string }>
  /** related objects — each opens in the inspector (Back returns) */
  relations?: Array<{ label: string; ref: EntityRef }>
  /** latest real events, newest first */
  activity?: Array<{ at: string; text: string }>
  /** where the full surface lives: the first is Open / Open beside */
  open?: Array<{ label: string; path: string }>
  /** what a mission can carry from this object */
  mission?: MissionSubject | null
  /** "as of" for the read, when the source says */
  freshness?: string | null
}

export interface InspectorRenderer {
  type: EntityType
  noun: string
  glyph: IconName
  load: (ref: EntityRef, signal: AbortSignal) => Promise<InspectorModel>
}

const REGISTRY = new Map<EntityType, InspectorRenderer>()

export function registerInspector(r: InspectorRenderer) { REGISTRY.set(r.type, r) }
export const inspectorFor = (type: EntityType): InspectorRenderer | null => REGISTRY.get(type) ?? null
export const inspectableTypes = (): EntityType[] => [...REGISTRY.keys()]
