/**
 * Inbox 2 / 3 / 4 — a pane instance with its own query surface (Multi-Inbox §3-§10).
 *
 * Its bucket, search, filters, sort, conversation and scroll are this pane's
 * alone; its rows come from the shared pane data layer (pane-data.ts), its
 * counts from Inbox 1's canonical counts. The triage list is the same desk
 * ledger as Inbox 1, under this pane's header.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { LCButton, LCIconButton, LCMenu, LCSearch, LCStatus, cx, type LCMenuEntry } from '../../../shared/lc'
import { InboxDeskLedger, type BesideApp } from '../desk/InboxDeskLedger'
import { MORE_LENSES, PRIMARY_LENSES, lensCount, lensDef, type DeskLens } from '../desk/ledger-model'
import { AdvancedFiltersModal } from '../components/AdvancedFiltersModal'
import ScheduledFollowupsPanel from '../components/ScheduledFollowupsPanel'
import { buildInboxFilterChips } from '../../../domain/inbox/inbox-filter-catalog-runtime'
import { markThreadRead, snoozeThread, type InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { lcToast } from '../../../shared/lc'
import { usePaneQuery, getPaneQueryCache } from './pane-data'
import { PaneConversation } from './PaneConversation'
import {
  PANE_SORTS,
  setPaneFilters,
  setPaneLens,
  setPaneSearch,
  setPaneSort,
  openPaneConversation,
  closePaneConversation,
  type MultiInboxState,
  type PaneSort,
  type PaneState,
} from './multi-inbox-model'

export interface SecondaryPaneProps {
  index: number
  pane: PaneState
  counts: Record<string, unknown>
  focused: boolean
  /** the pane is on screen (count ≥ index + 1) */
  visible: boolean
  sameAsPane: number | null
  update: (fn: (s: MultiInboxState) => MultiInboxState) => void
  onClosePane: () => void
  onOpenBeside: (() => void) | null
  onOpenAppBeside: (thread: InboxWorkflowThread, app: BesideApp) => void
  /** a write here changed the Inbox (counts and other panes re-read) */
  onChanged: () => void
}

const threadKeyOf = (t: InboxWorkflowThread) => String(t.threadKey ?? (t as unknown as Record<string, unknown>).thread_key ?? t.id ?? '')
const ms = (v: unknown) => { const n = Date.parse(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

function sortRows(rows: InboxWorkflowThread[], sort: PaneSort): InboxWorkflowThread[] {
  if (sort === 'newest') return rows
  const copy = [...rows]
  if (sort === 'oldest') copy.sort((a, b) => ms(a.lastMessageIso ?? a.latestMessageAt) - ms(b.lastMessageIso ?? b.latestMessageAt))
  else copy.sort((a, b) => Number(Boolean(b.unreadCount)) - Number(Boolean(a.unreadCount)))
  return copy
}

export function InboxSecondaryPane({
  index, pane, counts, focused, visible, sameAsPane, update, onClosePane, onOpenBeside, onOpenAppBeside, onChanged,
}: SecondaryPaneProps) {
  const { query } = pane
  const { entry, loadMore, retry } = usePaneQuery(query, visible)
  const number = index + 1
  const lensLabel = query.lens === 'filtered' ? 'Filtered' : lensDef(query.lens as DeskLens).label
  const title = pane.label ? `${pane.label} · ${lensLabel}` : lensLabel
  const def = query.lens === 'filtered' ? null : lensDef(query.lens as DeskLens)
  const count = def ? lensCount(counts, def) : entry.total

  // search: a draft, committed after a pause (same server search as Inbox 1)
  const [draft, setDraft] = useState(query.q)
  const [draftFor, setDraftFor] = useState(query.q)
  if (draftFor !== query.q) { setDraftFor(query.q); setDraft(query.q) }
  useEffect(() => {
    if (draft === query.q) return
    const timer = window.setTimeout(() => update((s) => setPaneSearch(s, index, draft)), 300)
    return () => window.clearTimeout(timer)
  }, [draft, index, query.q, update])

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filterDraft, setFilterDraft] = useState(query.advanced)
  const filterChips = useMemo(() => buildInboxFilterChips(query.advanced, { stage: query.stage, view: 'all_conversations' } as never), [query.advanced, query.stage])

  const rows = useMemo(() => sortRows(entry.rows, query.sort), [entry.rows, query.sort])
  const rowsRef = useRef(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

  const conversationThread = pane.conversation
    ? rows.find((t) => t.id === pane.conversation?.threadId || threadKeyOf(t) === pane.conversation?.threadKey) ?? null
    : null
  // the conversation is open but its row left this list (archived, moved bucket): keep the last copy
  const [lastConversation, setLastConversation] = useState<InboxWorkflowThread | null>(null)
  if (conversationThread && conversationThread !== lastConversation) setLastConversation(conversationThread)
  const openThread = pane.conversation ? conversationThread ?? lastConversation : null

  const lensItems: LCMenuEntry[] = [
    { kind: 'label', id: 'l', label: 'Set view' },
    ...[...PRIMARY_LENSES, ...MORE_LENSES].map((l) => ({
      id: `lens-${l.id}`,
      label: l.label,
      hint: l.definition,
      checked: query.lens === l.id,
      onSelect: () => update((s) => setPaneLens(s, index, l.id)),
    })),
  ]
  const sortItems: LCMenuEntry[] = PANE_SORTS.map((s) => ({ id: `sort-${s.id}`, label: s.label, checked: query.sort === s.id, onSelect: () => update((st) => setPaneSort(st, index, s.id)) }))
  const paneMenu: LCMenuEntry[] = [
    { kind: 'sub', id: 'view', label: 'Set view', items: lensItems.slice(1) },
    { kind: 'sub', id: 'sort', label: 'Sort', items: sortItems },
    { kind: 'separator', id: 's1' },
    ...(onOpenBeside ? [{ id: 'beside', label: 'Open another Inbox beside', icon: 'plus' as const, onSelect: onOpenBeside }] : []),
    { id: 'close', label: `Close Inbox ${number}`, icon: 'x' as const, onSelect: onClosePane },
  ]

  const header = (
    <header className={cx('ixm-head', focused && 'is-focused')}>
      <div className="ixm-head__id">
        <span className="ixm-head__num" aria-hidden="true">{number}</span>
        <LCMenu
          label={`Inbox ${number} view`}
          items={lensItems}
          width={320}
          align="start"
          trigger={(
            <button type="button" className="ixm-head__view" aria-label={`Inbox ${number}: ${title}. Change view`}>
              <span className="ixm-head__title">{title}</span>
              <span className="ixm-head__count">{typeof count === 'number' ? count.toLocaleString('en-US') : '—'}</span>
            </button>
          )}
        />
        {sameAsPane != null ? <LCStatus label={`Same view as Inbox ${sameAsPane + 1}`} tone="neutral" quiet /> : null}
      </div>
      <div className="ixm-head__tools">
        <LCSearch
          className="ixm-head__search"
          value={draft}
          onChange={setDraft}
          label={`Search Inbox ${number}`}
          placeholder="Search"
          loading={entry.refreshing && Boolean(query.q)}
        />
        <LCIconButton icon="filter" label={`Filters · Inbox ${number}`} size="sm" variant={query.lens === 'filtered' ? 'glass' : 'plain'} onClick={() => { setFilterDraft(query.advanced); setFiltersOpen(true) }} />
        <LCMenu label={`Inbox ${number} menu`} items={paneMenu} width={260} trigger={<LCIconButton icon="more" label={`Inbox ${number} menu`} size="sm" variant="plain" />} />
      </div>
    </header>
  )

  return (
    <div className={cx('ixm-pane-body', openThread && 'has-conversation')}>
      {/* the list stays mounted under an open conversation, so Close returns to the exact scroll */}
      <div className="ixm-pane-list" aria-hidden={openThread ? true : undefined}>
        <InboxDeskLedger
          threads={rows}
          lens={query.lens}
          counts={counts}
          loading={entry.status === 'loading' || entry.refreshing}
          error={entry.error}
          canLoadMore={entry.hasMore}
          filteredTotal={query.lens === 'filtered' ? entry.total : null}
          filterChips={filterChips.map((chip) => ({ key: chip.key, label: chip.label }))}
          selectedId={null}
          onLens={(lens) => update((s) => setPaneLens(s, index, lens))}
          onOpenFilters={() => { setFilterDraft(query.advanced); setFiltersOpen(true) }}
          onRemoveFilterChip={(key) => {
            const chip = filterChips.find((c) => c.key === key)
            if (chip) update((s) => setPaneFilters(s, index, query.stage, chip.clear(query.advanced)))
          }}
          onClearFilters={() => update((s) => setPaneLens(s, index, 'all_conversations'))}
          onOpen={(threadId) => {
            const thread = rowsRef.current.find((t) => t.id === threadId)
            if (thread) update((s) => openPaneConversation(s, index, { threadId: thread.id, threadKey: threadKeyOf(thread) || null }, 0))
          }}
          onLoadMore={() => loadMore() ?? Promise.resolve()}
          onRetry={retry}
          onSnooze={(threadId) => {
            const thread = rowsRef.current.find((t) => t.id === threadId)
            if (!thread) return
            void snoozeThread(thread).then((res) => {
              lcToast({ title: res.ok ? 'Snoozed' : 'Not snoozed', detail: res.ok ? undefined : res.errorMessage ?? undefined, severity: res.ok ? 'success' : 'warning', source: 'inbox' })
              if (res.ok) { getPaneQueryCache().invalidateSoon(); onChanged() }
            })
          }}
          onMarkRead={(threadId) => {
            const thread = rowsRef.current.find((t) => t.id === threadId)
            if (!thread) return
            void markThreadRead(thread).then((res) => { if (res.ok) { getPaneQueryCache().invalidateSoon(); onChanged() } })
          }}
          onOpenBeside={onOpenAppBeside}
          scheduledPanel={query.lens === 'scheduled' ? <ScheduledFollowupsPanel onOpenThread={(threadKey) => {
            const thread = rowsRef.current.find((t) => threadKeyOf(t) === threadKey)
            if (thread) update((s) => openPaneConversation(s, index, { threadId: thread.id, threadKey: threadKeyOf(thread) || null }, 0))
          }} /> : undefined}
          density="dense"
          onBulkChanged={() => { getPaneQueryCache().invalidateSoon(); onChanged() }}
          headerOverride={header}
          idPrefix={`ixm-${number}-opt`}
          ariaLabel={`Inbox ${number} · ${title}`}
        />
      </div>
      {openThread ? (
        <PaneConversation
          thread={openThread}
          paneLabel={`Inbox ${number}`}
          onClose={() => update((s) => closePaneConversation(s, index))}
          onReadWritten={onChanged}
          onSent={() => { getPaneQueryCache().invalidateSoon(); onChanged() }}
        />
      ) : null}
      {filtersOpen ? (
        <AdvancedFiltersModal
          open
          stageFilter={query.stage}
          viewFilter="all_conversations"
          inboxBucket="all"
          advancedFilters={filterDraft}
          onAdvancedFiltersChange={setFilterDraft}
          onReset={() => { update((s) => setPaneLens(s, index, 'all_conversations')); setFiltersOpen(false) }}
          onClose={() => setFiltersOpen(false)}
          onApply={(payload) => { update((s) => setPaneFilters(s, index, payload.stage, payload.advanced)); setFiltersOpen(false) }}
        />
      ) : null}
      {entry.error && rows.length > 0 ? <div className="ixm-pane-stale" role="status">Showing the last loaded list · {entry.error} <LCButton size="sm" variant="quiet" onClick={retry}>Retry</LCButton></div> : null}
    </div>
  )
}
