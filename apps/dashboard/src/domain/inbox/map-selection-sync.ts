import { getConversationThreadIdForThread } from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { resolveCoordinatesFromContext } from '../comp-intelligence/coordinate-resolver'
import type { AnyRecord } from '../../lib/data/shared'

export type MapPinIdentity = {
  id?: string
  conversation_id?: string
  property_id?: string | null
}

export function threadRefKeys(
  thread: InboxWorkflowThread | null | undefined,
  extraIds: Array<string | null | undefined> = [],
): string[] {
  if (!thread) {
    return [...new Set(extraIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
  }
  const conversationId = getConversationThreadIdForThread(thread)
  const keys = [
    thread.id,
    thread.threadKey,
    conversationId,
    thread.propertyId,
    ...extraIds,
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
  return [...new Set(keys)]
}

export function pinMatchesThread(
  pin: MapPinIdentity,
  thread: InboxWorkflowThread | null | undefined,
  extraIds: Array<string | null | undefined> = [],
): boolean {
  if (!thread) return false
  const keys = new Set(threadRefKeys(thread, extraIds))
  const conversationId = pin.conversation_id ? String(pin.conversation_id).trim() : ''
  const pinId = pin.id ? String(pin.id).trim() : ''
  const propertyId = pin.property_id ? String(pin.property_id).trim() : ''
  if (conversationId && keys.has(conversationId)) return true
  if (pinId && keys.has(pinId)) return true
  if (propertyId && thread.propertyId && propertyId === String(thread.propertyId).trim()) return true
  return false
}

export function findPinForThread<T extends MapPinIdentity>(
  pins: T[],
  thread: InboxWorkflowThread | null | undefined,
  extraIds: Array<string | null | undefined> = [],
): T | undefined {
  if (!thread || pins.length === 0) return undefined
  return pins.find((pin) => pinMatchesThread(pin, thread, extraIds))
}

export function isMappableCoord(lat: number, lng: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && Math.abs(lat) > 0.001
    && Math.abs(lng) > 0.001
}

function threadLat(thread: InboxWorkflowThread | null | undefined): number {
  if (!thread) return 0
  const row = thread as unknown as AnyRecord
  return Number(row.lat ?? row.latitude ?? 0)
}

function threadLng(thread: InboxWorkflowThread | null | undefined): number {
  if (!thread) return 0
  const row = thread as unknown as AnyRecord
  return Number(row.lng ?? row.longitude ?? 0)
}

export function resolveSubjectPropertyId(
  thread: InboxWorkflowThread | null | undefined,
  context?: AnyRecord | null,
): string {
  const row = (thread ?? {}) as unknown as AnyRecord
  return String(
    context?.propertyId
    ?? context?.property_id
    ?? row.propertyId
    ?? row.property_id
    ?? row.final_property_id
    ?? row.selected_property_id
    ?? row.thread_property_id
    ?? '',
  ).trim()
}

export function mergeThreadCoordinates(
  thread: InboxWorkflowThread,
  lat: number,
  lng: number,
): InboxWorkflowThread {
  return {
    ...thread,
    lat,
    lng,
    latitude: lat,
    longitude: lng,
  }
}

export function threadNeedsCoordinates(
  thread: InboxWorkflowThread | null | undefined,
): boolean {
  if (!thread) return false
  return !isMappableCoord(threadLat(thread), threadLng(thread))
}

export function applySubjectCoordinates(
  thread: InboxWorkflowThread | null | undefined,
  context?: AnyRecord | null,
  propertyRecord?: AnyRecord | null,
): InboxWorkflowThread | null {
  if (!thread) return null
  if (isMappableCoord(threadLat(thread), threadLng(thread))) return thread

  const resolved = resolveCoordinatesFromContext({
    dealContext: context,
    thread: thread as unknown as AnyRecord,
    propertyRecord,
  })
  if (resolved.lat === null || resolved.lng === null || !isMappableCoord(resolved.lat, resolved.lng)) {
    return thread
  }

  return mergeThreadCoordinates(thread, resolved.lat, resolved.lng)
}