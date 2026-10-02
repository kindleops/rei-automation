import { useState } from 'react'
import { LCButton } from '../../../shared/lc'
import { canonicalWatchKey, setWatched, useWatches } from '../../../lib/data/watchStore'
import { watchTargetOf, type WatchableRef } from './watch-target'

/**
 * The Universal Inspector's "Watch" action (Signal Center). Rendered only for a
 * subject the watchlist can hold: sellers and properties always, campaigns once
 * the Signal Center migration has formalised the watchlist (the server says so in
 * supported_types). It writes through /api/cockpit/signals/watches — nothing else.
 */
export function InspectorWatch({ subject, replayId, label }: { subject: WatchableRef; replayId?: string | null; label?: string | null }) {
  const watches = useWatches()
  const [error, setError] = useState<string | null>(null)
  const target = watchTargetOf(subject, replayId)
  if (!target || watches.status !== 'ready' || !watches.supportedTypes.includes(target.type)) return null
  const key = canonicalWatchKey(target.type, target.id)
  const on = watches.keys.has(key)
  const pending = watches.pending.has(key)
  const toggle = async () => {
    setError(null)
    try { await setWatched(target.type, target.id, !on, { label: label ?? null }) }
    catch (e) { setError(e instanceof Error ? e.message : 'The watch was not saved.') }
  }
  return (
    <LCButton
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      icon="eye"
      loading={pending}
      aria-pressed={on}
      title={error ?? (on ? 'Watching — watched activity becomes a signal. Click to stop.' : 'Watch — turn this subject’s activity into signals.')}
      onClick={() => void toggle()}
    >
      {on ? 'Watching' : 'Watch'}
    </LCButton>
  )
}
