/**
 * ONE COUNTS READ FOR EVERY INBOX INSTANCE ON THE PAGE.
 *
 * Inbox, Map and Pipeline are all InboxPage instances; a seeded multi-app
 * workspace mounted three and each forced its own fresh counts read at mount
 * (3 reads for one answer). Concurrent / back-to-back forced refreshes now join
 * one in-flight request; a new read starts once that one settled and
 * `joinWindowMs` passed, so a change we were told about still re-reads.
 */
export function createSharedFetch<T>(fetcher: (signal?: AbortSignal) => Promise<T>, { joinWindowMs = 1500, now = () => Date.now() } = {}) {
  let current: { startedAt: number; settled: boolean; promise: Promise<T> } | null = null
  return (): Promise<T> => {
    const t = now()
    if (current && (!current.settled || t - current.startedAt < joinWindowMs)) return current.promise
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const entry = { startedAt: t, settled: false, promise: fetcher(controller?.signal ?? undefined) }
    entry.promise.then(() => { entry.settled = true }, () => { entry.settled = true })
    current = entry
    return entry.promise
  }
}
