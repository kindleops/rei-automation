/**
 * CLOSING A CONVERSATION STAYS CLOSED (S0, 2026-10-04).
 *
 * Owner: "When a property click opens a thread, there's no way to exit it
 * except opening a different thread."
 *
 * Repro (InboxPage.tsx, the re-anchor effect on `effectiveActiveContext`): a
 * linked property / pin / Pipeline card sets the routing context to that
 * seller and selects the thread. Close clears the selection — and the effect
 * immediately sees "context names a thread, nothing is selected" and selects it
 * again from the same context. On every host that draws the selected thread
 * (Map / Pipeline / Calendar panes, multi-view) the conversation reappears; on
 * the desk the room stays shut but the selection is silently restored.
 *
 * Close now records WHICH context it dismissed. The re-anchor skips that exact
 * context; a different entity (or an explicit open) clears the dismissal. The
 * workspace's linked property itself is untouched — other panes stay linked.
 */
import type { ActiveInboxContext } from './active-context'

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

/** The identity a re-anchor would select from; null when the context names no seller/thread. */
export function contextIdentity(ctx: ActiveInboxContext | null | undefined): string | null {
  if (!ctx) return null
  const parts = [norm(ctx.threadKey), norm(ctx.propertyId), norm(ctx.sellerId), norm(ctx.masterOwnerId)]
  if (!parts.some(Boolean)) return null
  return parts.join('|')
}

/**
 * Should the context re-select a thread right now?
 * The legacy rule was: context names an entity and nothing matching is selected.
 */
export function shouldReanchorFromContext(
  ctx: ActiveInboxContext | null | undefined,
  { selectedMatches, dismissed }: { selectedMatches: boolean; dismissed: string | null },
): boolean {
  const identity = contextIdentity(ctx)
  if (!identity || selectedMatches) return false
  return identity !== dismissed
}

/** The dismissal survives only while the context still names the dismissed entity. */
export function nextDismissal(ctx: ActiveInboxContext | null | undefined, dismissed: string | null): string | null {
  if (!dismissed) return null
  return contextIdentity(ctx) === dismissed ? dismissed : null
}
