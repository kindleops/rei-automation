/**
 * Composer draft continuity — drafts keyed by canonical thread identity.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md §D / DD-017):
 *   `draftText` is a single component-level string (`InboxPage.tsx:691`) shared by every
 *   thread. Bucket switches tear the selection down and the composer keeps whatever text
 *   was in it, so unsent text written for thread A can end up aimed at thread B.
 *
 * Rules enforced here:
 *   - drafts are keyed by the canonical thread selection key — never by array index and
 *     never by row-object identity,
 *   - a poll, realtime patch, bucket request or intelligence refresh never touches a draft,
 *   - `clear` is explicit only: nothing in this module discards or sends a draft on its own.
 *
 * Pure and dependency-free — testable under `node --test`.
 */

export interface ComposerDraftStore {
  /** Draft text for a thread. Empty string when none — never null, so inputs stay controlled. */
  read(threadKey: string | null | undefined): string
  /** Persist unsent text. Writing an empty string removes the entry. */
  write(threadKey: string | null | undefined, text: string): void
  /** Explicit discard. Only ever called after a successful send or an operator discard. */
  clear(threadKey: string | null | undefined): void
  has(threadKey: string | null | undefined): boolean
  keys(): string[]
  size(): number
  snapshot(): Record<string, string>
  /** Bound long sessions. Never evicts `retain` keys. */
  trim(maxEntries: number, retain?: readonly string[]): number
}

const normalizeKey = (key: string | null | undefined): string => String(key ?? '').trim()

export function createComposerDraftStore(
  initial: Record<string, string> = {},
): ComposerDraftStore {
  const drafts = new Map<string, string>()
  for (const [key, value] of Object.entries(initial)) {
    const normalized = normalizeKey(key)
    if (normalized && value) drafts.set(normalized, value)
  }

  return {
    read(threadKey) {
      const key = normalizeKey(threadKey)
      if (!key) return ''
      return drafts.get(key) ?? ''
    },

    write(threadKey, text) {
      const key = normalizeKey(threadKey)
      if (!key) return
      // An empty draft is an absent draft — keeps `has`/`size` honest for the UI.
      if (text === '') {
        drafts.delete(key)
        return
      }
      drafts.delete(key)
      drafts.set(key, text)
    },

    clear(threadKey) {
      const key = normalizeKey(threadKey)
      if (!key) return
      drafts.delete(key)
    },

    has(threadKey) {
      const key = normalizeKey(threadKey)
      return Boolean(key) && drafts.has(key)
    },

    keys: () => Array.from(drafts.keys()),
    size: () => drafts.size,
    snapshot: () => Object.fromEntries(drafts.entries()),

    trim(maxEntries, retain = []) {
      if (drafts.size <= maxEntries) return 0
      const retained = new Set(retain.map(normalizeKey).filter(Boolean))
      let removed = 0
      for (const key of Array.from(drafts.keys())) {
        if (drafts.size <= maxEntries) break
        if (retained.has(key)) continue
        drafts.delete(key)
        removed += 1
      }
      return removed
    },
  }
}
