/**
 * AGENT CONTEXT — what the operator is looking at, as removable chips
 * (arch §8.1 AgentContextBus, read side).
 *
 * Derived READ-ONLY from what the shell already publishes — no app had to
 * change: the focused pane (workspace store) and that app's own subject words
 * (deck-subject) give the "Sees · <app>" chip, which follows focus and
 * navigation; the linked property locator (linked-property-bus) gives the
 * property chip, attributed to the app the selection was made in.
 *
 * S3: the property chip is the subject of a LIVE Quick Scan (read-only) when
 * the operator launches one from the preflight; nothing is sent until then.
 * Entity Graph publishes the property id only (no address) — the chip shows a
 * masked id until a live run reports the display address.
 */
import { useSyncExternalStore } from 'react'
import { getApp, type AppId } from '../../../domain/app-registry/app-registry'
import { LINKED_PROPERTY_EVENT, type LinkedPropertySignal } from '../../../domain/locator/linked-property-bus'
import { PROPERTY_LOCATOR_EVENT, readPropertyLocator } from '../../../domain/locator/property-locator'
import { useFocusedDeckSubject } from '../../desktop/workspace/deck-subject'
import * as L from '../../desktop/workspace/layout'
import { selectionInSession, useWorkspace } from '../../desktop/workspace/workspace-store'

export interface ContextChip {
  id: string
  kind: 'app' | 'property' | 'selection'
  label: string
  detail: string | null
  appId: AppId | null
}

export interface AgentContextSnapshot {
  app: AppId | null
  appLabel: string | null
  screenTitle: string | null
  property: { id: string | null; address: string | null; sourceApp: AppId | null; sourceLabel: string | null } | null
  /** the Entity Graph row selection, when EG publishes it (see ENTITY_GRAPH_SELECTION_EVENT) */
  selection: PublishedSelection | null
  chips: ContextChip[]
}

/**
 * PROPOSED minimal published context (for the Entity Graph owner to adopt;
 * nothing here writes it). EG keeps its own selection state — this is only
 * the read-out the agent consumes, so there is no second selection model:
 *
 *   window.dispatchEvent(new CustomEvent('lc:entity-graph-selection', { detail }))
 *   sessionStorage['lc.entityGraph.selection.v1'] = JSON.stringify(detail)
 *
 *   detail = { v: 1, scope: 'properties', property_ids: string[] (≤ 200),
 *              count: number (true selection size), focused: { property_id, address } | null,
 *              instance_id: string | null, at: number (ms) }
 *
 * Until EG publishes it, the agent uses the linked property (single property).
 */
export const ENTITY_GRAPH_SELECTION_EVENT = 'lc:entity-graph-selection'
export const ENTITY_GRAPH_SELECTION_KEY = 'lc.entityGraph.selection.v1'
export interface PublishedSelection { scope: string; property_ids: string[]; count: number; focused: { property_id: string; address: string | null } | null; instance_id: string | null; at: number }

function readPublishedSelection(): PublishedSelection | null {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(ENTITY_GRAPH_SELECTION_KEY) || 'null') as Partial<PublishedSelection> & { v?: number } | null
    if (!raw || raw.v !== 1 || raw.scope !== 'properties' || !Array.isArray(raw.property_ids)) return null
    const ids = raw.property_ids.map(String).filter(Boolean).slice(0, 200)
    const f = raw.focused && typeof raw.focused === 'object' && raw.focused.property_id ? { property_id: String(raw.focused.property_id), address: raw.focused.address ? String(raw.focused.address) : null } : null
    return { scope: 'properties', property_ids: ids, count: Number.isFinite(raw.count) ? Number(raw.count) : ids.length, focused: f, instance_id: raw.instance_id ?? null, at: Number(raw.at) || 0 }
  } catch { return null }
}
let selStamp = 0
if (typeof window !== 'undefined') window.addEventListener(ENTITY_GRAPH_SELECTION_EVENT, () => { selStamp += 1 })
function usePublishedSelection(): PublishedSelection | null {
  const stamp = useSyncExternalStore(
    (l) => { window.addEventListener(ENTITY_GRAPH_SELECTION_EVENT, l); return () => window.removeEventListener(ENTITY_GRAPH_SELECTION_EVENT, l) },
    () => selStamp,
    () => 0,
  )
  void stamp
  return typeof window === 'undefined' ? null : readPublishedSelection()
}

/* the app a linked selection came from (the bus carries the acting instance id) */
let lastSource: { instanceId: string | null } = { instanceId: null }
let sourceVersion = 0
if (typeof window !== 'undefined') {
  window.addEventListener(LINKED_PROPERTY_EVENT, (e) => {
    const sig = (e as CustomEvent<LinkedPropertySignal>).detail
    lastSource = { instanceId: sig?.source ?? null }
    sourceVersion += 1
  })
}

function useLocator() {
  return useSyncExternalStore(
    (l) => { window.addEventListener(PROPERTY_LOCATOR_EVENT, l); window.addEventListener(LINKED_PROPERTY_EVENT, l); return () => { window.removeEventListener(PROPERTY_LOCATOR_EVENT, l); window.removeEventListener(LINKED_PROPERTY_EVENT, l) } },
    () => (selectionInSession() ? `${readPropertyLocator()?.setAt ?? 0}:${sourceVersion}` : '0'),
    () => '0',
  )
}

const mask = (id: string) => `••${id.replace(/[^a-z0-9]/gi, '').slice(-4)}`

function appInfo(id: string | null | undefined): { id: AppId; label: string } | null {
  if (!id) return null
  try { const a = getApp(id as AppId); return a ? { id: a.id, label: a.label } : null } catch { return null }
}

export function useAgentContextSnapshot(): AgentContextSnapshot {
  const ws = useWorkspace()
  const focused = L.focusedInstance(ws.layout)
  const subject = useFocusedDeckSubject(focused?.id ?? null)
  const stamp = useLocator()
  const loc = stamp !== '0' ? readPropertyLocator() : null
  const app = appInfo(focused?.app)
  const published = usePublishedSelection()
  const selection = published && published.property_ids.length ? published : null
  const chips: ContextChip[] = []
  if (app) chips.push({ id: `app:${app.id}:${focused?.id ?? ''}`, kind: 'app', label: app.label, detail: subject?.title ?? null, appId: app.id })
  let property: AgentContextSnapshot['property'] = null
  if (loc && (loc.propertyId || loc.address)) {
    let src: { id: AppId; label: string } | null = null
    if (lastSource.instanceId) src = appInfo(ws.layout.instances[lastSource.instanceId]?.app)
    // EG's published focused row can name the address the locator does not carry
    const addr = loc.address ?? (selection?.focused && selection.focused.property_id === loc.propertyId ? selection.focused.address : null)
    property = { id: loc.propertyId, address: addr, sourceApp: src?.id ?? null, sourceLabel: src?.label ?? null }
    chips.push({ id: `property:${loc.propertyId ?? loc.address}`, kind: 'property', label: addr ?? `Property ${mask(loc.propertyId ?? '')}`, detail: src ? `linked · ${src.label}` : 'linked selection', appId: src?.id ?? null })
  }
  if (selection && selection.count > 1) chips.push({ id: 'selection:eg', kind: 'selection', label: `${selection.count} selected`, detail: 'Entity Graph rows', appId: 'entity-graph' as AppId })
  return { app: app?.id ?? null, appLabel: app?.label ?? null, screenTitle: subject?.title ?? null, property, selection, chips }
}
