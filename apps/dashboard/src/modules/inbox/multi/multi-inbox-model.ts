/**
 * MULTI-INBOX — 1 / 2 / 3 / 4 simultaneous Inbox panes in ONE Inbox app.
 *
 * INSTANCE REPRESENTATION
 *   Pane 1 is the existing desk Inbox: its query (lens, filters, search) and its
 *   conversation room are InboxPage's own state, unchanged. Panes 2-4 are pane
 *   instances described here: each owns its query, sort, scroll, conversation
 *   and filter-sheet state. Nothing is a global filter object — changing pane 2
 *   can only change pane 2.
 *
 *   All four panes keep their state when the count drops: reducing 4 → 2 hides
 *   panes 3 and 4; going back to 4 restores them exactly (same session) and,
 *   for the persisted fields, across reloads.
 *
 * Pure: no React, no I/O. The layout rule (`layoutFor`) is decided from the
 * Inbox's own measured width, never the viewport.
 */
import type { InboxAdvancedFilters } from '../inbox-ui-helpers'
import type { InboxStageSelectValue } from '../../../domain/inbox/inbox-view-types'
import type { DeskLensKey } from '../desk/ledger-model'

export type PaneCount = 1 | 2 | 3 | 4
export const PANE_COUNTS: readonly PaneCount[] = [1, 2, 3, 4]
export const MAX_PANES = 4

export type PaneSort = 'newest' | 'oldest' | 'unread_first'
export const PANE_SORTS: ReadonlyArray<{ id: PaneSort; label: string }> = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest loaded first' },
  { id: 'unread_first', label: 'Unread first' },
]

export interface PaneQuery {
  /** a real desk lens (bucket), or 'filtered' = advanced filters over all conversations */
  lens: DeskLensKey
  /** the search box (server-backed, same semantics as pane 1) */
  q: string
  stage: InboxStageSelectValue
  advanced: InboxAdvancedFilters
  sort: PaneSort
}

export interface PaneConversationRef {
  threadId: string
  threadKey: string | null
}

export interface PaneState {
  id: string
  /** optional operator label ("MN", "Cleanup"); the underlying view stays visible */
  label: string | null
  query: PaneQuery
  /** the conversation open IN this pane (list mode when null) */
  conversation: PaneConversationRef | null
  /** list scroll offset, restored when the conversation closes */
  scrollTop: number
}

export interface MultiInboxState {
  version: 1
  count: PaneCount
  /** index 0 = pane 1 (the desk; its query lives in InboxPage). Always MAX_PANES long. */
  panes: PaneState[]
  /** focused pane index — keyboard actions go here */
  focused: number
  /** column proportions per count (sum 1) */
  sizes: Partial<Record<PaneCount, number[]>>
}

const DEFAULT_ADVANCED: InboxAdvancedFilters = { outOfStateOwner: 'all' } as InboxAdvancedFilters

/** Distinct, real buckets for panes 2-4 so a new pane is useful at once (no setup screen). */
export const DEFAULT_SECONDARY_LENSES: readonly DeskLensKey[] = ['new_replies', 'needs_review', 'follow_up']

export function defaultQuery(lens: DeskLensKey): PaneQuery {
  return { lens, q: '', stage: 'all_stages' as InboxStageSelectValue, advanced: { ...DEFAULT_ADVANCED }, sort: 'newest' }
}

export function defaultPane(index: number): PaneState {
  const lens = index === 0 ? 'priority' : DEFAULT_SECONDARY_LENSES[(index - 1) % DEFAULT_SECONDARY_LENSES.length]
  return { id: `pane-${index + 1}`, label: null, query: defaultQuery(lens), conversation: null, scrollTop: 0 }
}

/** New / no saved state: exactly ONE pane. */
export function defaultMultiInbox(): MultiInboxState {
  return { version: 1, count: 1, panes: Array.from({ length: MAX_PANES }, (_, i) => defaultPane(i)), focused: 0, sizes: {} }
}

export const clampCount = (n: unknown): PaneCount => {
  const v = Math.round(Number(n))
  return (v >= 1 && v <= 4 ? v : 1) as PaneCount
}

/* ── reducers ─────────────────────────────────────────────────────────── */

export function setCount(state: MultiInboxState, count: PaneCount): MultiInboxState {
  const next = clampCount(count)
  if (next === state.count) return state
  return { ...state, count: next, focused: Math.min(state.focused, next - 1) }
}

/** "Open another Inbox beside" — the next pane, keeping its preserved state. */
export function openBeside(state: MultiInboxState): MultiInboxState {
  if (state.count >= MAX_PANES) return state
  const count = (state.count + 1) as PaneCount
  return { ...state, count, focused: count - 1 }
}

/** Close pane `index` (2..4): later panes shift left, the closed pane's state is kept at the end. */
export function closePane(state: MultiInboxState, index: number): MultiInboxState {
  if (index <= 0 || index >= state.count) return state
  const panes = [...state.panes]
  const [closed] = panes.splice(index, 1)
  panes.push({ ...closed, conversation: null })
  const count = (state.count - 1) as PaneCount
  return { ...state, panes, count, focused: Math.min(state.focused >= index ? state.focused - 1 : state.focused, count - 1) }
}

const updatePane = (state: MultiInboxState, index: number, fn: (pane: PaneState) => PaneState): MultiInboxState => {
  if (index < 0 || index >= MAX_PANES) return state
  const panes = state.panes.map((pane, i) => (i === index ? fn(pane) : pane))
  return { ...state, panes }
}

export function setPaneLens(state: MultiInboxState, index: number, lens: DeskLensKey): MultiInboxState {
  return updatePane(state, index, (pane) => ({
    ...pane,
    // a bucket is its own question: filters stay additive only on the filtered lens
    query: lens === 'filtered' ? { ...pane.query, lens } : { ...pane.query, lens, advanced: { ...DEFAULT_ADVANCED }, stage: 'all_stages' as InboxStageSelectValue },
    scrollTop: 0,
  }))
}

export function setPaneSearch(state: MultiInboxState, index: number, q: string): MultiInboxState {
  return updatePane(state, index, (pane) => (pane.query.q === q ? pane : { ...pane, query: { ...pane.query, q }, scrollTop: 0 }))
}

export function setPaneSort(state: MultiInboxState, index: number, sort: PaneSort): MultiInboxState {
  return updatePane(state, index, (pane) => ({ ...pane, query: { ...pane.query, sort } }))
}

export function setPaneFilters(state: MultiInboxState, index: number, stage: InboxStageSelectValue, advanced: InboxAdvancedFilters): MultiInboxState {
  return updatePane(state, index, (pane) => ({ ...pane, query: { ...pane.query, lens: 'filtered', stage, advanced }, scrollTop: 0 }))
}

export function setPaneLabel(state: MultiInboxState, index: number, label: string | null): MultiInboxState {
  const clean = (label ?? '').trim().slice(0, 24) || null
  return updatePane(state, index, (pane) => ({ ...pane, label: clean }))
}

/** Open a conversation in the pane, remembering exactly where the list was. */
export function openPaneConversation(state: MultiInboxState, index: number, ref: PaneConversationRef, scrollTop: number): MultiInboxState {
  return updatePane(state, index, (pane) => ({ ...pane, conversation: ref, scrollTop }))
}

/** Close → the pane's exact previous list state (query untouched, scroll restored by the list). */
export function closePaneConversation(state: MultiInboxState, index: number): MultiInboxState {
  return updatePane(state, index, (pane) => (pane.conversation ? { ...pane, conversation: null } : pane))
}

export function focusPane(state: MultiInboxState, index: number): MultiInboxState {
  const focused = Math.max(0, Math.min(index, state.count - 1))
  return focused === state.focused ? state : { ...state, focused }
}

export function setSizes(state: MultiInboxState, count: PaneCount, sizes: number[]): MultiInboxState {
  return { ...state, sizes: { ...state.sizes, [count]: normalizeSizes(sizes, count) } }
}

export function normalizeSizes(sizes: readonly number[] | undefined, count: number): number[] {
  const raw = Array.isArray(sizes) && sizes.length === count ? sizes.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)) : []
  const sum = raw.reduce((a, b) => a + b, 0)
  if (!raw.length || sum <= 0 || raw.some((v) => v <= 0)) return Array.from({ length: count }, () => 1 / count)
  return raw.map((v) => v / sum)
}

/* ── layout by the Inbox's own width ──────────────────────────────────── */

export type PaneLayout =
  | { kind: 'single' }
  | { kind: 'columns'; sizes: number[] }
  | { kind: 'grid2x2' }

/** No pane narrower than this; four never squeeze into 1440. */
export const MIN_PANE_PX = 420

export function defaultSizes(count: PaneCount, width: number): number[] {
  if (count === 3 && width < 2400) return [0.5, 0.25, 0.25]
  return Array.from({ length: count }, () => 1 / count)
}

export function layoutFor(count: PaneCount, width: number, saved?: number[]): PaneLayout {
  if (count === 1) return { kind: 'single' }
  if (count === 4 && width < MIN_PANE_PX * 4 + 120) return { kind: 'grid2x2' }
  const sizes = saved && saved.length === count ? normalizeSizes(saved, count) : defaultSizes(count, width)
  return { kind: 'columns', sizes }
}

/* ── persistence (sanitised; transient state is not stored) ───────────── */

export interface PersistedMultiInbox {
  version: 1
  count: PaneCount
  panes: Array<{ id: string; label: string | null; query: Omit<PaneQuery, 'q'> }>
  sizes: Partial<Record<PaneCount, number[]>>
}

/**
 * Stored: pane count, order, sizes, lens, filters, sort, labels.
 * NOT stored: the open conversation and the search text (transient, like the
 * existing saved-workspace semantics that drop selection), scroll.
 */
export function toPersisted(state: MultiInboxState): PersistedMultiInbox {
  return {
    version: 1,
    count: state.count,
    panes: state.panes.map((pane) => ({ id: pane.id, label: pane.label, query: { lens: pane.query.lens, stage: pane.query.stage, advanced: pane.query.advanced, sort: pane.query.sort } })),
    sizes: state.sizes,
  }
}

const LENS_KEYS = new Set<string>(['priority', 'new_replies', 'needs_review', 'waiting', 'follow_up', 'scheduled', 'snoozed', 'suppressed', 'cold', 'dead', 'archived', 'all_conversations', 'filtered'])
const SORT_KEYS = new Set<string>(PANE_SORTS.map((s) => s.id))

export function fromPersisted(raw: unknown): MultiInboxState {
  const base = defaultMultiInbox()
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Partial<PersistedMultiInbox>
  if (data.version !== 1) return base
  const panes = base.panes.map((fallback, i) => {
    const stored = Array.isArray(data.panes) ? data.panes[i] : null
    if (!stored || typeof stored !== 'object') return fallback
    const query = (stored as { query?: Partial<PaneQuery> }).query ?? {}
    const lens = typeof query.lens === 'string' && LENS_KEYS.has(query.lens) ? query.lens as DeskLensKey : fallback.query.lens
    const sort = typeof query.sort === 'string' && SORT_KEYS.has(query.sort) ? query.sort as PaneSort : 'newest'
    const advanced = query.advanced && typeof query.advanced === 'object' ? query.advanced as InboxAdvancedFilters : { ...DEFAULT_ADVANCED }
    const stage = typeof query.stage === 'string' ? query.stage as InboxStageSelectValue : fallback.query.stage
    const label = typeof stored.label === 'string' ? stored.label.trim().slice(0, 24) || null : null
    return { ...fallback, id: typeof stored.id === 'string' && stored.id ? stored.id : fallback.id, label, query: { lens, q: '', stage, advanced, sort } }
  })
  const sizes: Partial<Record<PaneCount, number[]>> = {}
  for (const count of [2, 3, 4] as PaneCount[]) {
    const s = data.sizes?.[count]
    if (Array.isArray(s) && s.length === count) sizes[count] = normalizeSizes(s, count)
  }
  return { version: 1, count: clampCount(data.count), panes, focused: 0, sizes }
}

/* ── keyboard (audited 2026-10-04) ─────────────────────────────────────
 * ⌘/Ctrl+1-9 belong to the browser (tab switching) and the shell avoids them
 * (desktop/workspace/keys.ts); ⌥⇧+arrows/M/W are the shell's pane keys.
 * Multi-Inbox uses ⌥1-⌥4 (no Shift, no ⌘/Ctrl), only while focus is inside the
 * Inbox and not in a text field.
 */
export function paneIndexForKey(e: { altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; code: string }): number | null {
  if (!e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return null
  const m = /^Digit([1-4])$/.exec(e.code)
  return m ? Number(m[1]) - 1 : null
}

/** "Same view as Inbox 1" — a non-blocking hint, identical panes are allowed. */
export function sameViewAs(state: MultiInboxState, index: number, primary: Pick<PaneQuery, 'lens' | 'q'>): number | null {
  const mine = index === 0 ? primary : state.panes[index]?.query
  if (!mine) return null
  for (let i = 0; i < state.count; i += 1) {
    if (i === index) continue
    const other = i === 0 ? primary : state.panes[i].query
    if (other.lens === mine.lens && other.q.trim() === mine.q.trim() && other.lens !== 'filtered') return i
  }
  return null
}
