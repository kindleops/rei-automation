import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import {
  resolveInboxThreadState,
  type CanonicalBucket,
  type BucketClassification,
} from '../../domain/inbox/resolveInboxThreadState'

export type { CanonicalBucket, BucketClassification }

export const classifyInboxBucket = (
  thread: InboxWorkflowThread,
  now: Date = new Date(),
): BucketClassification => resolveInboxThreadState(thread, now)

export const getCanonicalBucketCounts = (
  threads: InboxWorkflowThread[],
  now: Date = new Date(),
): Record<CanonicalBucket, number> => {
  const counts: Record<CanonicalBucket, number> = {
    suppressed: 0,
    needs_review: 0,
    priority: 0,
    new_replies: 0,
    follow_up: 0,
    cold: 0,
    dead: 0,
    all: threads.length,
    negotiating: 0,
    waiting_on_seller: 0,
    automated: 0,
  }
  for (const thread of threads) {
    const { bucket } = resolveInboxThreadState(thread, now)
    counts[bucket] = (counts[bucket] || 0) + 1
  }
  return counts
}

