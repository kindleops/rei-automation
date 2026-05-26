import type {
  DeliveryStatus,
  FailureReason,
  QueueItem,
  QueueItemPriority,
  QueueItemStatus,
  QueueModel,
  RiskLevel,
} from '../../modules/queue/queue.types'

export type {
  DeliveryStatus,
  FailureReason,
  QueueItem,
  QueueItemPriority,
  QueueItemStatus,
  QueueModel,
  RiskLevel,
}
import * as backendClient from '../api/backendClient'




export { fetchQueueModel } from './fetchQueueModel'

// ── Queue Actions ─────────────────────────────────────────────────────────

export interface QueueActionResult {
  ok: boolean
  errorMessage: string | null
  updatedItem?: QueueItem
}

export const approveQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.approveQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'scheduled', approvedByOperator: 'operator' } }
}

export const holdQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.holdQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'held' } }
}

export const rescheduleQueueItem = async (item: QueueItem, newTime: string): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.rescheduleQueueItem(String(item.id), newTime)
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'scheduled', scheduledForLocal: newTime } }
}

export const cancelQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.cancelQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'held' } }
}

export const retryRoutingForItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  // Backend re-resolves routing and reschedules.
  const result = await backendClient.retryRoutingForQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'scheduled' } }
}

export const retryQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.retryQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'retry', retryCount: (item.retryCount || 0) + 1 } }
}
