import { pushRoutePath } from '../../../app/router'
import { getApp, type AppId } from '../../../domain/app-registry/app-registry'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { writeMapFocusSet, type MapFocusPoint } from '../../../domain/map/map-focus-set'
import { isUsableLngLat, writeMapPropertyFocus } from '../../../domain/map/map-property-focus'
import type { IconName } from '../../../shared/icons'
import { sound } from '../../../shared/sound'
import { inspectorFor } from '../inspector/inspector-registry'
import { closeInspector, openInspector, readInspectorState } from '../inspector/inspector-store'
import * as L from '../workspace/layout'
import { planMission, type MissionKind } from '../workspace/missions'
import { announceWorkspace, getWorkspace, isWorkspaceRunning, openApp, revealInstance, startMission } from '../workspace/workspace-store'
import { hintOf, objectCapabilities, propertyIdOf, type ObjectRef } from './object-registry'

/**
 * THE UNIVERSAL OBJECT ACTIONS (System Refinement 8.2 §2).
 *
 *   OPEN         the owning app takes the pane being acted in (the router's
 *                interceptor: an app already open elsewhere is focused there)
 *   OPEN BESIDE  the existing workspace split + placement (openApp 'beside')
 *   INSPECT      the Universal Inspector — never a new mini-sidebar
 *   SHOW ON MAP  the Map focuses the canonical property: an open Map pane is
 *                revealed in place (the operator's pane keeps focus), a closed
 *                one opens beside. Pinned Maps stay put.
 *
 * Every action names objects by canonical id (see ./object-registry) and
 * returns what happened, so a caller can say it honestly. Nothing here writes
 * business data: the only state touched is navigation, the linked locator,
 * the inspector stack and the Map focus request.
 */

export interface ObjectActionResult {
  ok: boolean
  /** what happened, for the caller (and tests) */
  outcome: 'opened' | 'beside' | 'focused' | 'inspected' | 'revealed' | 'map-opened' | 'navigated' | 'pinned' | 'unavailable' | 'refused' | 'mission'
  /** why not, in operator words */
  reason?: string
}

const appLabel = (app: AppId) => { try { return getApp(app)?.label ?? app } catch { return app } }

/** Publish the object as the linked workspace subject (apps that understand it follow; pinned panes do not). */
function publishLinked(ref: ObjectRef) {
  const loc = objectCapabilities(ref).spec.locator(ref)
  if (loc) setPropertyLocator(loc)
}

/** A click on an object yields an unpinned inspector, exactly like a click outside it would. */
function yieldInspector() {
  const s = readInspectorState()
  if (s.current && !s.pinned) closeInspector()
}

export function openObject(ref: ObjectRef): ObjectActionResult {
  const cap = objectCapabilities(ref)
  if (!cap.open) return { ok: false, outcome: 'unavailable', reason: `This ${cap.spec.noun.toLowerCase()} has no canonical id to open` }
  publishLinked(ref)
  yieldInspector()
  pushRoutePath(cap.open)
  return { ok: true, outcome: 'opened' }
}

export function openObjectBeside(ref: ObjectRef): ObjectActionResult {
  const cap = objectCapabilities(ref)
  if (!cap.beside) return { ok: false, outcome: 'unavailable', reason: `This ${cap.spec.noun.toLowerCase()} has no canonical id to open` }
  publishLinked(ref)
  yieldInspector()
  if (!isWorkspaceRunning()) { pushRoutePath(cap.beside); return { ok: true, outcome: 'navigated' } }
  const r = openApp(cap.beside, 'beside')
  if (r === 'refused') {
    announceWorkspace(`${appLabel(cap.spec.primaryApp)} could not open beside — the workspace is full.`)
    return { ok: false, outcome: 'refused', reason: 'No room for another pane' }
  }
  sound.workspace.drop('split')
  return { ok: true, outcome: r === 'focused' ? 'focused' : 'beside' }
}

export function inspectObject(ref: ObjectRef): ObjectActionResult {
  if (!inspectorFor(ref.type)) return { ok: false, outcome: 'unavailable', reason: 'No quick view for this yet' }
  openInspector(ref, { replace: true })
  sound.ui.select()
  return { ok: true, outcome: 'inspected' }
}

export function startObjectMission(ref: ObjectRef, kind: MissionKind): ObjectActionResult {
  const subject = objectCapabilities(ref).missionSubject
  const plan = subject ? planMission(kind, subject) : null
  if (!plan) return { ok: false, outcome: 'unavailable', reason: 'This mission needs a subject this object does not carry' }
  closeInspector()
  return startMission(plan) ? { ok: true, outcome: 'mission' } : { ok: false, outcome: 'refused' }
}

/* ── Show on Map ──────────────────────────────────────────────────────── */

export interface ShowOnMapOptions {
  /** where a CLOSED Map opens: beside the acting pane (default — the operator stays where they are) or in it */
  where?: 'beside' | 'here'
  /** the app asking (display / audit only) */
  source?: string | null
  /** label for a multi-property set ("Comps for 3831 Sheridan Ave N") */
  setLabel?: string
  /** the Universal Inspector itself is asking: it stays open beside the Map */
  keepInspector?: boolean
}

/** Make the Map visible for a focus request, without moving the operator unless the Map was closed. */
function bringMap(where: 'beside' | 'here'): ObjectActionResult {
  const ws = getWorkspace()
  const map = L.instanceForApp(ws.layout, 'map')
  if (map) {
    const r = revealInstance(map.id)
    return { ok: true, outcome: r === 'revealed' ? 'revealed' : 'focused' }
  }
  if (where === 'here') { pushRoutePath('/map'); return { ok: true, outcome: 'map-opened' } }
  const r = openApp('/map', 'beside')
  if (r === 'refused') { pushRoutePath('/map'); return { ok: true, outcome: 'map-opened' } }
  sound.workspace.drop('split')
  return { ok: true, outcome: 'map-opened' }
}

/** The pinned Map, if the workspace has one (a pin keeps the Map on its subject — Show on Map never moves it). */
function pinnedMap(): { label: string | null } | null {
  if (!isWorkspaceRunning()) return null
  const map = L.instanceForApp(getWorkspace().layout, 'map')
  return map?.pinned ? { label: map.pinLabel ?? null } : null
}

const num = (v: string | null) => (v === null ? null : Number(v))

/**
 * Show one object — or a set of properties — on the Map.
 *
 * One object: the Map makes the canonical selection for its property id (the
 * same state a pin tap produces) and flies there. Coordinates the caller
 * already holds from a canonical read ride along as the fallback; nothing is
 * geocoded from an address here.
 *
 * Several objects: the existing Map focus set lights and frames every one
 * that carries coordinates; the ones that do not are reported, never placed.
 */
export function showOnMap(target: ObjectRef | ObjectRef[], opts: ShowOnMapOptions = {}): ObjectActionResult {
  const refs = (Array.isArray(target) ? target : [target]).filter(Boolean)
  if (!refs.length) return { ok: false, outcome: 'unavailable', reason: 'Nothing to show' }
  const where = opts.where ?? 'beside'
  const pinned = pinnedMap()
  if (pinned) {
    const reason = `Map is pinned${pinned.label ? ` to ${pinned.label}` : ''}. Unpin it to show this here.`
    announceWorkspace(reason)
    return { ok: false, outcome: 'pinned', reason }
  }

  if (refs.length === 1) {
    const ref = refs[0]
    const cap = objectCapabilities(ref)
    if (!cap.map.propertyId) {
      const reason = `Show on Map unavailable — ${cap.map.reason}`
      announceWorkspace(reason)
      return { ok: false, outcome: 'unavailable', reason }
    }
    if (!opts.keepInspector) yieldInspector()
    writeMapPropertyFocus({
      propertyId: cap.map.propertyId,
      label: ref.type === 'property' ? ref.label ?? null : hintOf(ref, 'property_label'),
      threadKey: hintOf(ref, 'thread_key'),
      lat: num(hintOf(ref, 'lat')),
      lng: num(hintOf(ref, 'lng')),
      source: opts.source ?? hintOf(ref, 'source'),
    })
    if (!isWorkspaceRunning()) { pushRoutePath('/map'); return { ok: true, outcome: 'navigated' } }
    return bringMap(where)
  }

  const points: MapFocusPoint[] = []
  let missing = 0
  for (const ref of refs) {
    const lat = hintOf(ref, 'lat'), lng = hintOf(ref, 'lng')
    if (isUsableLngLat(lat, lng)) points.push({ lat: Number(lat), lng: Number(lng), id: propertyIdOf(ref) ?? ref.id, label: ref.label ?? null })
    else missing += 1
  }
  if (!points.length || !writeMapFocusSet({ label: opts.setLabel ?? `${points.length === 1 ? 'property' : 'properties'}`, tone: 'property', points })) {
    const reason = 'Show on Map unavailable — none of these properties has coordinates on record'
    announceWorkspace(reason)
    return { ok: false, outcome: 'unavailable', reason }
  }
  yieldInspector()
  const shown: ObjectActionResult = isWorkspaceRunning() ? bringMap(where) : (pushRoutePath('/map'), { ok: true, outcome: 'navigated' })
  // said last, so it is what the live region holds (not "Map opened")
  if (missing) announceWorkspace(`${missing} of ${refs.length} have no coordinates on record and are not shown.`)
  return shown
}

/* ── the action list (one canonical object menu) ──────────────────────── */

export type ObjectActionId = 'open' | 'beside' | 'inspect' | 'map' | `mission:${MissionKind}`

export interface ObjectAction {
  id: ObjectActionId
  label: string
  icon: IconName
  /** the gesture that does the same thing, shown quietly in the menu */
  shortcut?: string
  disabled?: boolean
  reason?: string
  run: () => ObjectActionResult
}

export interface ObjectActionsOptions {
  /** actions this surface already IS (inside Map, "Show on Map" is the selection itself) */
  omit?: ObjectActionId[]
  showOnMap?: ShowOnMapOptions
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

/** Every action an object supports, in canonical order. Actions that cannot run say why. */
export function objectActions(ref: ObjectRef, opts: ObjectActionsOptions = {}): ObjectAction[] {
  const cap = objectCapabilities(ref)
  const omit = new Set(opts.omit ?? [])
  const out: ObjectAction[] = []
  if (cap.open) out.push({ id: 'open', label: `Open in ${appLabel(cap.spec.primaryApp)}`, icon: 'arrow-up-right', shortcut: 'Click', run: () => openObject(ref) })
  if (cap.beside) out.push({ id: 'beside', label: 'Open beside', icon: 'layout-split', shortcut: `${MOD_KEY}-click`, run: () => openObjectBeside(ref) })
  out.push({ id: 'inspect', label: 'Inspect', icon: 'eye', shortcut: '⇧-click', disabled: !cap.inspectable, reason: cap.inspectable ? undefined : 'No quick view for this yet', run: () => inspectObject(ref) })
  if (cap.spec.mapBehaviour !== 'none') {
    out.push({ id: 'map', label: 'Show on Map', icon: 'map', disabled: !cap.map.propertyId, reason: cap.map.reason ?? undefined, run: () => showOnMap(ref, opts.showOnMap) })
  }
  for (const m of cap.missions) out.push({ id: `mission:${m.kind}`, label: m.verb, icon: 'target', run: () => startObjectMission(ref, m.kind) })
  return out.filter((a) => !omit.has(a.id))
}

/* ── click grammar ────────────────────────────────────────────────────── */

export type ObjectGesture = 'activate' | 'inspect' | 'beside'

interface ModifierEvent { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; preventDefault?: () => void; stopPropagation?: () => void }

/**
 *   CLICK            focus / open in the most contextual way (the surface decides)
 *   SHIFT+CLICK      inspect
 *   CMD/CTRL+CLICK   open beside
 * (Alt is left to the surface — some use it for their own gestures.)
 */
export function gestureOf(e: ModifierEvent | null | undefined): ObjectGesture {
  if (!e) return 'activate'
  if (e.shiftKey && !e.metaKey && !e.ctrlKey) return 'inspect'
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey) return 'beside'
  return 'activate'
}

/**
 * Apply the click grammar to an object. `onActivate` is the surface's own
 * contextual click (select the row, open its local panel); without one, a
 * plain click opens the object in its owning app. Shift-click on an object
 * the inspector cannot read falls back to the plain click, never a dead click.
 */
export function handleObjectClick(e: ModifierEvent | null | undefined, ref: ObjectRef | null, onActivate?: () => void): ObjectGesture {
  const g = ref ? gestureOf(e) : 'activate'
  // a modified click is a command, not a text selection (⇧-click extends the browser's selection)
  if (g !== 'activate' && typeof window !== 'undefined') { try { window.getSelection?.()?.removeAllRanges() } catch { /* ignore */ } }
  if (g === 'inspect' && ref && inspectorFor(ref.type)) {
    e?.preventDefault?.()
    e?.stopPropagation?.()
    inspectObject(ref)
    return 'inspect'
  }
  if (g === 'beside' && ref && objectCapabilities(ref).beside) {
    e?.preventDefault?.()
    e?.stopPropagation?.()
    openObjectBeside(ref)
    return 'beside'
  }
  if (onActivate) { yieldInspector(); onActivate() }
  else if (ref) openObject(ref)
  return 'activate'
}

/** Attributes for an element that represents an object: the inspector stays open across object clicks. */
export function objectAttrs(ref: ObjectRef | null): Record<string, string> {
  return ref ? { 'data-inspect': '', 'data-object': `${ref.type}:${ref.id}` } : {}
}
