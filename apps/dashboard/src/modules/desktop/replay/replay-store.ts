import { useSyncExternalStore } from 'react'
import type { FeedSubject } from '../feed/feed-model'

/**
 * Which subject the Time Machine is replaying (one at a time). Opening a replay
 * publishes nothing to linked context — replay reads, it never steers panes.
 */

let current: FeedSubject | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function openReplay(subject: FeedSubject) {
  if (!subject?.id) return
  if (current && current.type === subject.type && current.id === subject.id) return
  current = subject
  emit()
}

export function closeReplay() {
  if (!current) return
  current = null
  emit()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useReplaySubject = () => useSyncExternalStore(subscribe, () => current, () => current)
export const replaySubjectNow = () => current
