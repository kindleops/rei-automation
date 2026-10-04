import { useEffect, useRef } from 'react'
import { createLinkedFollower, readLastLinkedSignal, subscribeLinkedProperty, type LinkedHandler } from '../../../domain/locator/linked-property-bus'
import { useAppInstance } from './instance-context'

/**
 * FOLLOW THE WORKSPACE SELECTION — the one way an app subscribes to linked
 * context (domain/locator/linked-property-bus).
 *
 * The handler runs only while this pane follows (workspace linked, pane not
 * pinned), never for a selection this pane made itself, never twice for the
 * subject it already shows, and once per settled click (debounced, latest
 * wins: `ctx.signal` aborts when a newer selection arrives). Anything the
 * handler publishes while applying — directly, or later through `ctx.apply`
 * — is a re-selection, not a new selection, so it never re-broadcasts.
 *
 * Only mounted apps hear it: nothing is launched and focus never moves.
 */
export function useLinkedProperty(handler: LinkedHandler, opts: { enabled?: boolean } = {}) {
  const { instanceId, follows } = useAppInstance()
  const enabled = (opts.enabled ?? true) && follows
  const ref = useRef(handler)
  useEffect(() => { ref.current = handler }, [handler])
  // A pane that is re-linked (unpinned / workspace linked again) catches up
  // with the current selection; a pane that merely mounts does not — a
  // newly composed pane opens on its own path, never on a stale selection.
  const wasDisabled = useRef(false)
  useEffect(() => {
    if (!enabled) { wasDisabled.current = true; return }
    const follower = createLinkedFollower(instanceId, (loc, ctx) => ref.current(loc, ctx))
    const stop = subscribeLinkedProperty(follower.onSignal)
    if (wasDisabled.current) {
      wasDisabled.current = false
      const last = readLastLinkedSignal()
      if (last) follower.onSignal({ ...last, source: null })
    }
    return () => { stop(); follower.dispose() }
  }, [enabled, instanceId])
}
