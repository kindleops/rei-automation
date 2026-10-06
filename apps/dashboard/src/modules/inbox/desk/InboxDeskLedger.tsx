import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import {
  LCButton,
  LCContextMenu,
  LCEmpty,
  LCError,
  LCFilterBar,
  LCIconButton,
  LCMenu,
  LCSegmented,
  LCStatus,
  LCTooltip,
  cx,
  type LCMenuEntry,
  type LCSegmentOption,
} from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { gestureOf, handleObjectClick, objectAttrs, objectMenuEntries } from '../../desktop/objects'
import { ledgerRowObject } from './ledger-object'
import {
  MORE_LENSES,
  PRIMARY_LENSES,
  buildLedgerRow,
  filteredCountLabel,
  formatCount,
  isLoadMoreExhausted,
  isPrimaryLens,
  lensCount,
  lensDef,
  moveCursor,
  shouldShowLoadMore,
  type DeskLens,
  type DeskLensKey,
  type LedgerRowModel,
  type LoadMoreProbe,
} from './ledger-model'
import { readLedgerFacts, useLedgerFacts } from './ledger-facts'
import { enableRowSignals, useRowArrival, useRowSignal, type RowSignal } from './live-row-signals'
import { useLedgerClock } from './use-ledger-clock'
import { LCBulkBar, useLcSelection } from '../../../shared/lc'
import { useBulkArchive, type BulkItemState } from '../../../lib/data/useBulkArchive'
import { useBulkLeadState, type BulkLeadStateAction } from '../../../lib/data/bulkLeadStateData'
import { BulkChoiceDialog, type BulkChoiceKind } from './BulkChoiceDialog'
import type { BulkRunReport } from '../../../lib/data/bulkArchiveData'
import { anchoredRowShift, heldScrollTop, snapshotVisibleRows, type VisibleRowsSnapshot } from '../list-scroll-hold'
import './inbox-desk.css'

/**
 * INBOX DESKTOP 4.0 — THE TRIAGE LEDGER.
 *
 * Full width when no conversation is open; the left plane of the split when
 * one is. One coherent information plane: fixed-height rows (live state never
 * changes a row's height), windowed rendering, progressive density by the
 * ledger's own width (container queries — never the viewport).
 *
 * It renders canonical state and asks nothing of it: lens membership and
 * counts come from the server's bucket predicate, a row's state chip from the
 * same predicate's flags, its transient from realtime events that already
 * arrive on the Inbox channel.
 */

export type BesideApp = 'deal-intelligence' | 'map' | 'entity-graph'

export interface InboxDeskLedgerProps {
  threads: InboxWorkflowThread[]
  /** rows hidden locally after a confirmed write (`hidden:<id>` set from the store) */
  hiddenIds?: ReadonlySet<string>
  lens: DeskLensKey
  counts: Record<string, unknown>
  loading: boolean
  error: string | null
  canLoadMore: boolean
  /** the filtered lens's own exact total (server count), when known */
  filteredTotal: number | null
  filterChips: ReadonlyArray<{ key: string; label: string }>
  /** the thread the conversation room is showing (null when closed) */
  selectedId: string | null
  onLens: (lens: DeskLens) => void
  onOpenFilters: () => void
  onRemoveFilterChip: (key: string) => void
  onClearFilters: () => void
  onOpen: (threadId: string) => void
  /** may return the load's promise; the footer uses it to learn that a load added nothing */
  onLoadMore: () => void | Promise<unknown>
  onRetry: () => void
  onSnooze: (threadId: string) => void
  onMarkRead: (threadId: string) => void
  onOpenBeside: (thread: InboxWorkflowThread, app: BesideApp) => void
  /** the Scheduled lens reads send_queue, not thread rows */
  scheduledPanel?: ReactNode
  density?: 'standard' | 'dense'
  /** [8.3] after a bulk archive / undo changed threads — refresh counts and the list */
  onBulkChanged?: () => void
  /** Multi-Inbox: replaces the desk header (lens tabs) with the pane's own header */
  headerOverride?: ReactNode
  /** Multi-Inbox: extra controls in the desk header (the 1|2|3|4 control) */
  headerExtra?: ReactNode
  /** unique per mounted ledger (aria ids) */
  idPrefix?: string
  /** a short accessible name for this list ("Inbox 2 · New Replies") */
  ariaLabel?: string
}

const ROW_HEIGHT = { standard: 64, dense: 48 } as const

const EMPTY_KEYS: ReadonlySet<string> = new Set()
const THREAD_NOUN = { one: 'conversation', many: 'conversations' }
const THREAD_ARCHIVE_EFFECTS = [
  { kind: 'stops' as const, text: 'They leave every Inbox lens and count, and the analytics that read archived state.' },
  { kind: 'keeps' as const, text: 'Messages, stage and suppression are untouched.' },
]

const sortNewestFirst = (rows: InboxWorkflowThread[]) => [...rows].sort((a, b) => {
  const at = (row: InboxWorkflowThread) => {
    const ms = Date.parse(String(row.lastMessageAt || (row as unknown as { latest_message_at?: string }).latest_message_at || row.updatedAt || ''))
    return Number.isFinite(ms) ? ms : 0
  }
  return at(b) - at(a)
})

const factsKeyOf = (thread: InboxWorkflowThread): string => {
  const row = thread as unknown as Record<string, unknown>
  return String(row.thread_key ?? row.threadKey ?? '').trim()
}

/* ── a row ──────────────────────────────────────────────────────────────── */

interface RowHandlers {
  onOpen: (threadId: string) => void
  onCursor: (threadId: string) => void
  onSnooze: (threadId: string) => void
  onMarkRead: (threadId: string) => void
  onOpenBeside: (thread: InboxWorkflowThread, app: BesideApp) => void
  /** [8.3] a selection gesture on a row (checkbox, or ⇧/⌘ while a selection is active); true = consumed */
  onSelectGesture: (threadId: string, e: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, onCheckbox?: boolean) => boolean
  selectable: boolean
}

function TransientChip({ signal }: { signal: RowSignal }) {
  switch (signal.kind) {
    case 'replying':
      return (
        <span className="ixl-live is-replying" role="status">
          <span className="ixl-live__dots" aria-hidden="true"><i /><i /><i /></span>
          {signal.automation ? 'LeadCommand replying' : 'Sending'}
        </span>
      )
    case 'queued':
      return (
        <span className="ixl-live is-queued" role="status">
          <Icon name="check" size={12} aria-hidden="true" />
          {signal.automation ? 'Reply queued' : 'Queued'}
        </span>
      )
    case 'held':
      return <LCStatus state="needs_you" title="The automation held this reply for a person" />
    case 'failed':
      return <LCStatus label="Send failed" tone="crit" title="The reply did not send — open the conversation for the reason" />
    default:
      return null
  }
}

/** [8.3.2] one row's part of a bulk run: working → ✓ / ✗ reason / unconfirmed. */
function BulkMark({ state }: { state: BulkItemState }) {
  if (state.phase !== 'done') {
    return <LCStatus label={state.phase === 'recheck' ? 'Rechecking…' : 'Working…'} tone="exec" quiet title="This item is being written" />
  }
  const { result } = state
  if (result.outcome === 'archived' || result.outcome === 'unarchived' || result.outcome === 'unchanged' || result.outcome === 'changed') {
    const label = result.outcome === 'unchanged' ? '✓ Already done' : result.outcome === 'archived' ? '✓ Archived' : result.outcome === 'unarchived' ? '✓ Restored' : '✓ Done'
    return <LCStatus label={label} tone="ok" title={result.message || (result.reason === 'confirmed_on_recheck' ? 'Confirmed on a second check' : 'Written')} />
  }
  if (result.outcome === 'unconfirmed') {
    return <LCStatus label="? Unconfirmed" tone="attn" title={result.message || 'No answer in time — it may still have completed.'} />
  }
  return <LCStatus label={result.outcome === 'blocked' ? '✗ Blocked' : '✗ Not written'} tone={result.outcome === 'blocked' ? 'attn' : 'crit'} title={result.message || result.reason || 'Not changed'} />
}

const LedgerRow = memo(function LedgerRow({
  thread, model, selected, cursor, picked, selecting, optionId, handlers, bulkState,
}: {
  thread: InboxWorkflowThread
  model: LedgerRowModel
  selected: boolean
  cursor: boolean
  /** [8.3] in the bulk selection */
  picked: boolean
  /** [8.3] a bulk selection is active (checkboxes stay visible) */
  selecting: boolean
  optionId: string
  handlers: RowHandlers
  /** [8.3.2] this row's state in a running / just-finished bulk action */
  bulkState?: BulkItemState | null
}) {
  const signal = useRowSignal(model.threadKey)
  const stateTransient = signal && signal.kind !== 'arrival' && signal.kind !== 'stage' ? signal : null
  const stageMove = signal?.kind === 'stage' ? signal : null
  const arriving = signal?.kind === 'arrival' && !signal.quiet

  // the row's canonical object: the seller's thread (property as a hint), or the property alone
  const rowObject = useMemo(() => ledgerRowObject(model), [model])

  const menu = useMemo<LCMenuEntry[]>(() => {
    const items: LCMenuEntry[] = [
      { id: 'open', label: 'Open conversation', icon: 'message', onSelect: () => handlers.onOpen(model.id) },
    ]
    const beside: LCMenuEntry[] = []
    if (model.propertyId || model.threadKey) beside.push({ id: 'di', label: 'Open Deal Intelligence beside', icon: 'target', onSelect: () => handlers.onOpenBeside(thread, 'deal-intelligence') })
    if (model.propertyId) beside.push({ id: 'map', label: 'Open Map beside', icon: 'map', onSelect: () => handlers.onOpenBeside(thread, 'map') })
    if (model.propertyId) beside.push({ id: 'eg', label: 'Open Entity Graph beside', icon: 'link', onSelect: () => handlers.onOpenBeside(thread, 'entity-graph') })
    if (beside.length) items.push({ kind: 'separator', id: 'sep-beside' }, ...beside)
    // [8.2] the canonical object actions (Inspect, Show on Map, missions) — Open
    // and Open beside stay the Inbox's own, above
    const act: LCMenuEntry[] = [{ id: 'snooze', label: 'Snooze 24 hours', icon: 'clock', onSelect: () => handlers.onSnooze(model.id) }]
    if (model.unread) act.push({ id: 'read', label: 'Mark read', icon: 'check', onSelect: () => handlers.onMarkRead(model.id) })
    const object = objectMenuEntries(rowObject, { omit: ['open', 'beside'], showOnMap: { source: 'inbox' } })
    items.push({ kind: 'separator', id: 'sep-object' }, ...object, { kind: 'separator', id: 'sep-act' }, ...act)
    return items
  }, [handlers, model.id, model.propertyId, model.threadKey, model.unread, thread, rowObject])

  const stageFace = stageMove
    ? <span className="ixl-stage is-moving" aria-label={`Stage moved ${stageMove.from} to ${stageMove.to}`}>{stageMove.from}<Icon name="chevron-right" size={11} aria-hidden="true" />{stageMove.to}</span>
    : model.stage
      ? <span className={cx('ixl-stage', `is-band-${model.stage.band}`)}>{model.stage.short}</span>
      : null

  return (
    <LCContextMenu items={menu} label={`${model.name} actions`} title={model.name}>
      <div
        id={optionId}
        role="option"
        aria-selected={selected}
        className={cx(
          'ixl-row',
          selected && 'is-selected',
          cursor && 'is-cursor',
          model.unread && 'is-unread',
          model.needsYou && 'is-needs-you',
          model.suppressed && 'is-suppressed',
          model.direction === 'outbound' && 'is-outbound',
          arriving && 'is-arriving',
          picked && 'is-picked',
          selecting && 'is-selecting',
        )}
        data-thread-id={model.id}
        {...objectAttrs(rowObject)}
        onClick={(e) => {
          // [8.3] while a selection is active, ⇧-click extends it and ⌘-click toggles (LCDataGrid grammar)
          if (handlers.onSelectGesture(model.id, e)) { e.preventDefault(); return }
          // click opens the conversation · ⇧-click inspects the seller · ⌘/Ctrl-click opens Deal Intelligence beside
          if (gestureOf(e) === 'beside' && (model.propertyId || model.threadKey)) { e.preventDefault(); handlers.onOpenBeside(thread, 'deal-intelligence'); return }
          handleObjectClick(e, rowObject, () => { handlers.onCursor(model.id); handlers.onOpen(model.id) })
        }}
      >
        <span className="ixl-row__lead">
          {handlers.selectable ? (
            <button
              type="button"
              className="lc-rowcheck ixl-row__check"
              role="checkbox"
              aria-checked={picked}
              aria-label={`Select ${model.name}`}
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); handlers.onSelectGesture(model.id, e, true) }}
            >
              <span className={cx('lc-check', picked && 'is-on')} aria-hidden="true" />
            </button>
          ) : null}
          <span className="ixl-row__marks" aria-hidden="true">
            {model.needsYou ? <i className="ixl-mark is-attn" /> : model.unread ? <i className="ixl-mark is-unread" /> : null}
          </span>
        </span>

        <span className="ixl-row__who">
          <span className="ixl-row__name">{model.name}</span>
          <span className="ixl-row__stage-inline">{stageFace}</span>
          {model.street ? <span className="ixl-row__street">{model.street}</span> : <span className="ixl-row__street is-unknown">Address not linked</span>}
        </span>

        <span className="ixl-row__said">
          <span className="ixl-row__msg">
            <span className="ixl-row__dir" aria-label={model.direction === 'inbound' ? 'Seller' : model.direction === 'outbound' ? 'You' : undefined}>
              {model.direction === 'inbound' ? '↙' : model.direction === 'outbound' ? '↗' : ''}
            </span>
            {model.message || <span className="is-muted">No message text</span>}
          </span>
          <span className="ixl-row__intent">
            {model.intent ?? model.locality ?? ''}
          </span>
        </span>

        <span className="ixl-row__deal">
          <span className="ixl-row__deal-stage">
            {stageFace}
            {model.stage && !stageMove ? <span className="ixl-row__stage-label">{model.stage.label.replace(/^S\d+ · /, '')}</span> : null}
          </span>
          <span className="ixl-row__facts">
            {[model.propertyType, model.value, model.equity].filter(Boolean).join(' · ') || model.locality || ''}
          </span>
        </span>

        <span className="ixl-row__state">
          {bulkState ? <BulkMark state={bulkState} /> : stateTransient ? <TransientChip signal={stateTransient} /> : model.lane ? (
            <LCStatus label={model.lane.label} tone={model.lane.tone} quiet={model.lane.quiet} title={model.needsYouWhy ?? model.lane.title} />
          ) : null}
          {model.laneDetail && !stateTransient ? <span className="ixl-row__detail">{model.laneDetail}</span> : null}
        </span>

        <span className="ixl-row__when">
          {model.timeLabel ? (
            <LCTooltip content={model.timeExact} side="left">
              <time dateTime={model.timeIso ?? undefined}>{model.timeLabel}</time>
            </LCTooltip>
          ) : null}
        </span>

        <span className="ixl-row__actions" onClick={(e) => e.stopPropagation()}>
          <LCIconButton icon="message" label="Open conversation" size="sm" variant="glass" onClick={() => handlers.onOpen(model.id)} />
          <LCIconButton icon="clock" label="Snooze 24 hours" size="sm" variant="glass" onClick={() => handlers.onSnooze(model.id)} />
          {model.unread ? <LCIconButton icon="check" label="Mark read" size="sm" variant="glass" onClick={() => handlers.onMarkRead(model.id)} /> : null}
          {model.propertyId || model.threadKey ? (
            <LCIconButton icon="target" label="Open Deal Intelligence beside" size="sm" variant="glass" onClick={() => handlers.onOpenBeside(thread, 'deal-intelligence')} />
          ) : null}
        </span>
      </div>
    </LCContextMenu>
  )
})

/* ── the windowed list ──────────────────────────────────────────────────── */

interface SlotProps {
  rows: InboxWorkflowThread[]
  lens: DeskLensKey
  selectedId: string | null
  cursorId: string | null
  picked: ReadonlySet<string>
  bulkItems: ReadonlyMap<string, BulkItemState>
  now: number
  factsVersion: number
  idPrefix: string
  handlers: RowHandlers
}

function LedgerSlot({ index, style, rows, lens, selectedId, cursorId, picked, bulkItems, now, idPrefix, handlers }: RowComponentProps<SlotProps>) {
  const thread = rows[index]
  const factsKey = thread ? factsKeyOf(thread) : ''
  const arrivedAt = useRowArrival(factsKey || null)
  if (!thread) return null
  const model = buildLedgerRow(thread, { lens, facts: readLedgerFacts(factsKey), now, arrivedAt })
  return (
    <div style={style} className="ixl-slot">
      <LedgerRow
        thread={thread}
        model={model}
        selected={selectedId === thread.id}
        cursor={cursorId === thread.id}
        picked={picked.has(thread.id)}
        selecting={picked.size > 0}
        optionId={`${idPrefix}-${index}`}
        handlers={handlers}
        bulkState={factsKey ? bulkItems.get(factsKey) ?? null : null}
      />
    </div>
  )
}

function SkeletonRows({ count, rowHeight }: { count: number; rowHeight: number }) {
  return (
    <div className="ixl-skeleton" role="status" aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ixl-skeleton__row" style={{ height: rowHeight }}>
          <i className="lc-skel" style={{ width: 8, height: 8, borderRadius: 99 }} />
          <span className="ixl-skeleton__col">
            <i className="lc-skel" style={{ width: `${46 - ((i * 7) % 16)}%`, height: 11 }} />
            <i className="lc-skel" style={{ width: `${30 - ((i * 5) % 12)}%`, height: 9 }} />
          </span>
          <span className="ixl-skeleton__col is-wide">
            <i className="lc-skel" style={{ width: `${78 - ((i * 13) % 30)}%`, height: 11 }} />
            <i className="lc-skel" style={{ width: `${40 - ((i * 9) % 18)}%`, height: 9 }} />
          </span>
          <i className="lc-skel" style={{ width: 64, height: 18, borderRadius: 99 }} />
        </div>
      ))}
    </div>
  )
}

/* ── the ledger ─────────────────────────────────────────────────────────── */

export function InboxDeskLedger(props: InboxDeskLedgerProps) {
  const {
    threads, hiddenIds, lens, counts, loading, error, canLoadMore, filteredTotal, filterChips, selectedId,
    onLens, onOpenFilters, onRemoveFilterChip, onClearFilters, onOpen, onLoadMore, onRetry, onSnooze, onMarkRead,
    onOpenBeside, scheduledPanel, density = 'standard', onBulkChanged, headerOverride, headerExtra,
    idPrefix = 'ixl-opt', ariaLabel,
  } = props
  const rowHeight = ROW_HEIGHT[density]
  const now = useLedgerClock()
  const listRef = useRef<ListImperativeAPI | null>(null)
  const [cursorId, setCursorId] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)

  // The live-row store reads the Inbox channel's events only while a ledger is mounted.
  useEffect(() => enableRowSignals(), [])

  // [8.3] threads a bulk run moved out of this lens leave the list at once (Undo brings them back).
  // Scoped to the lens: a thread archived from Priority must still show in Archived.
  const [goneHere, setGoneHere] = useState<{ lens: DeskLensKey; keys: ReadonlySet<string> }>(() => ({ lens, keys: new Set() }))
  const goneKeys = goneHere.lens === lens ? goneHere.keys : EMPTY_KEYS
  const rows = useMemo(
    () => sortNewestFirst(threads.filter((thread) => !hiddenIds?.has(`hidden:${thread.id}`) && !goneKeys.has(factsKeyOf(thread)))),
    [goneKeys, hiddenIds, threads],
  )
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows])

  /* [8.3] multi-select + bulk archive (thread rows only — the Scheduled lens is send_queue) */
  const selectable = lens !== 'scheduled'
  const selectionOrder = useMemo(() => (selectable ? rowIds : []), [rowIds, selectable])
  const selection = useLcSelection(selectionOrder)
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const nameByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of rows) {
      const key = factsKeyOf(row)
      const raw = row as unknown as Record<string, unknown>
      if (key) map.set(key, String(raw.ownerName ?? raw.seller_display_name ?? raw.display_name ?? '').trim() || key)
    }
    return map
  }, [rows])
  const labelOf = useCallback((key: string) => nameByKey.get(key) ?? key, [nameByKey])
  const archivedLens = lens === 'archived'
  const onBulkReport = useCallback((report: BulkRunReport) => {
    // archiving leaves a normal lens; restoring leaves the Archived lens
    const leaving = (report.action === 'archive') !== archivedLens
    setGoneHere((prev) => {
      const next = new Set(prev.lens === lens ? prev.keys : [])
      for (const key of report.changedIds) {
        if (leaving) next.add(key)
        else next.delete(key)
      }
      return { lens, keys: next }
    })
    onBulkChanged?.()
  }, [archivedLens, lens, onBulkChanged])
  const bulk = useBulkArchive({
    objectType: 'inbox_thread',
    noun: THREAD_NOUN,
    consequences: THREAD_ARCHIVE_EFFECTS,
    labelOf,
    onChanged: onBulkReport,
    source: 'inbox',
  })
  const { clear: clearSelection, ids: selectedIds, onRowClick: selectionRowClick } = selection
  const { archive: bulkArchive, undo: bulkRestore, items: archiveItems, clearItems: clearArchiveItems } = bulk
  // [bulk bar] stage / status / follow-up / snooze / read — one server authority, per-item progress
  const onLeadChanged = useCallback((changedIds: string[], action: BulkLeadStateAction) => {
    // a snooze leaves every operational lens (Snoozed shows it); the others re-read
    if (action === 'snooze' && lens !== 'snoozed') {
      setGoneHere((prev) => {
        const next = new Set(prev.lens === lens ? prev.keys : [])
        for (const key of changedIds) next.add(key)
        return { lens, keys: next }
      })
    }
    onBulkChanged?.()
  }, [lens, onBulkChanged])
  const leadActionRef = useRef<BulkLeadStateAction>('read')
  const leadBulk = useBulkLeadState({ noun: THREAD_NOUN, labelOf, onChanged: (ids) => onLeadChanged(ids, leadActionRef.current) })
  const [choice, setChoiceState] = useState<{ kind: BulkChoiceKind; at: number } | null>(null)
  const setChoice = useCallback((kind: BulkChoiceKind | null) => setChoiceState(kind ? { kind, at: Date.now() } : null), [])
  const runLead = useCallback(async (action: BulkLeadStateAction, value: string | null = null) => {
    const keys = selectedIds.map((id) => rowById.get(id)).map((row) => (row ? factsKeyOf(row) : '')).filter(Boolean)
    if (!keys.length) return
    leadActionRef.current = action
    clearArchiveItems()
    const report = await leadBulk.run(action, keys, value)
    if (report && report.summary.changed > 0) clearSelection()
  }, [clearArchiveItems, clearSelection, leadBulk, rowById, selectedIds])
  // the most recent run's per-row marks
  const bulkItems = leadBulk.items.size ? leadBulk.items : archiveItems
  const anyBulkBusy = bulk.busy || leadBulk.busy
  const archiveSelected = useCallback(async () => {
    const keys = selectedIds.map((id) => rowById.get(id)).map((row) => (row ? factsKeyOf(row) : '')).filter(Boolean)
    if (archivedLens) {
      clearSelection()
      await bulkRestore(keys)
      return
    }
    const report = await bulkArchive(keys)
    if (report) clearSelection()
  }, [archivedLens, bulkArchive, bulkRestore, clearSelection, rowById, selectedIds])
  const factsKeys = useMemo(() => rows.slice(0, 160).map(factsKeyOf).filter(Boolean), [rows])
  const factsVersion = useLedgerFacts(factsKeys)

  // The cursor follows the open conversation when one opens elsewhere (search, deep link).
  const [seenSelected, setSeenSelected] = useState(selectedId)
  if (seenSelected !== selectedId) {
    setSeenSelected(selectedId)
    if (selectedId) setCursorId(selectedId)
  }

  const handlers = useMemo<RowHandlers>(() => ({
    onOpen,
    onCursor: setCursorId,
    onSnooze,
    onMarkRead,
    onOpenBeside,
    onSelectGesture: (id, e, onCheckbox) => (selectable ? selectionRowClick(id, e, onCheckbox) : false),
    selectable,
  }), [onMarkRead, onOpen, onOpenBeside, onSnooze, selectable, selectionRowClick])

  const picked = selection.selected
  const rowProps = useMemo<SlotProps>(() => ({
    rows, lens, selectedId, cursorId, picked, bulkItems, now, factsVersion, idPrefix, handlers,
  }), [bulkItems, cursorId, factsVersion, handlers, idPrefix, lens, now, picked, rows, selectedId])

  /*
   * Scroll hold: data never moves the list (see list-scroll-hold.ts). A reply
   * landing above the fold is compensated so the rows you are reading stay
   * put; a visible row re-sorting to the top does NOT drag the viewport with
   * it; Load More appends below and leaves scrollTop alone.
   */
  const anchorRef = useRef<VisibleRowsSnapshot | null>(null)
  const onRowsRendered = useCallback((visible: { startIndex: number; stopIndex: number }) => {
    anchorRef.current = snapshotVisibleRows(rowIds, visible.startIndex, visible.stopIndex)
  }, [rowIds])
  useLayoutEffect(() => {
    const element = listRef.current?.element
    const before = anchorRef.current
    if (!element || !before) return
    const next = heldScrollTop(element.scrollTop, before, rowIds, rowHeight)
    if (next !== element.scrollTop) element.scrollTop = next
    const shift = anchoredRowShift(before, rowIds)
    anchorRef.current = { startIndex: Math.max(0, before.startIndex + shift), ids: before.ids }
  }, [rowHeight, rowIds])

  // Only an explicit keyboard move scrolls the list to the cursor. This used to
  // be an effect keyed on the row ids, so every realtime event, poll and Load
  // More snapped the list back to the last opened conversation.
  const scrollCursorIntoView = (id: string | null) => {
    if (!id) return
    const index = rowIds.indexOf(id)
    if (index >= 0) listRef.current?.scrollToRow({ index, align: 'smart', behavior: 'instant' })
  }
  const moveCursorTo = (id: string | null) => {
    setCursorId(id)
    scrollCursorIntoView(id)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // [8.3] Esc clears the bulk selection first; Space toggles the cursor row into it
    if (selection.onKeyDown(event)) return
    if (event.key === ' ' && selectable && cursorId && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      selection.onRowClick(cursorId, event, true)
      return
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1
      : event.key === 'PageDown' ? 10 : event.key === 'PageUp' ? -10 : 0
    if (step) {
      event.preventDefault()
      moveCursorTo(moveCursor(rowIds, cursorId ?? selectedId, step))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveCursorTo(rowIds.length ? (event.key === 'Home' ? rowIds[0] : rowIds[rowIds.length - 1]) : null)
      return
    }
    if (event.key === 'Enter' && cursorId) {
      event.preventDefault()
      onOpen(cursorId)
    }
  }

  /* header */
  const activePrimary = isPrimaryLens(lens) ? lens : null
  const secondary = !activePrimary && lens !== 'filtered' ? lensDef(lens as DeskLens) : null
  const segmentValue = (activePrimary ?? (lens === 'filtered' ? 'filtered' : secondary?.id ?? 'priority')) as string
  const options = useMemo<LCSegmentOption<string>[]>(() => {
    const base: LCSegmentOption<string>[] = PRIMARY_LENSES.map((def) => ({
      value: def.id,
      label: def.label,
      accessory: <span className="ixl-lens__count">{formatCount(lensCount(counts, def))}</span>,
    }))
    if (secondary) base.push({ value: secondary.id, label: secondary.label, accessory: <span className="ixl-lens__count">{formatCount(lensCount(counts, secondary))}</span> })
    if (lens === 'filtered') base.push({ value: 'filtered', label: 'Filtered', accessory: <span className="ixl-lens__count">{typeof filteredTotal === 'number' ? formatCount(filteredTotal) : formatCount(rows.length)}</span> })
    return base
  }, [counts, filteredTotal, lens, rows.length, secondary])

  const moreItems = useMemo<LCMenuEntry[]>(() => MORE_LENSES.map((def) => ({
    id: def.id,
    label: def.label,
    hint: `${formatCount(lensCount(counts, def))} · ${def.definition}`,
    checked: lens === def.id,
    onSelect: () => onLens(def.id),
  })), [counts, lens, onLens])

  const summary = useMemo(() => {
    const value = (key: string) => {
      const raw = counts?.[key]
      const num = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(num) ? num : null
    }
    const parts: string[] = []
    const replies = value('new_replies')
    const review = value('needs_review')
    const waiting = value('waiting')
    if (replies !== null) parts.push(`${replies.toLocaleString('en-US')} new ${replies === 1 ? 'reply' : 'replies'}`)
    if (review !== null) parts.push(`${review.toLocaleString('en-US')} ${review === 1 ? 'needs' : 'need'} review`)
    if (waiting !== null) parts.push(`${waiting.toLocaleString('en-US')} waiting on ${waiting === 1 ? 'a seller' : 'sellers'}`)
    return parts.join(' · ')
  }, [counts])

  /*
   * ROWS BELONG TO THE QUESTION THAT FETCHED THEM. Changing the lens or the
   * filters kept painting the previous list under the new header ("Filtered ·
   * 0 conversations" over a page of unrelated threads) until the response
   * landed. The rows are stamped with the view they answered; while a
   * different view is loading, the list shows its loading state instead.
   */
  const viewKey = `${lens}|${filterChips.map((chip) => `${chip.key}=${chip.label}`).join('&')}`
  const [rowsViewKey, setRowsViewKey] = useState(viewKey)
  if (!loading && rowsViewKey !== viewKey) setRowsViewKey(viewKey)
  const rowsStale = loading && rowsViewKey !== viewKey

  const currentDef = lens === 'filtered' ? null : lensDef(lens as DeskLens)
  const lensTotal = currentDef ? lensCount(counts, currentDef) : filteredTotal
  // [8.3.2] a Load more that settles without adding a row ends the paging for this question
  const [loadProbe, setLoadProbe] = useState<LoadMoreProbe | null>(null)
  const loadExhausted = isLoadMoreExhausted(loadProbe, viewKey, rows.length)
  const showLoadMore = shouldShowLoadMore({ rowCount: rows.length, canLoadMore, lensTotal, exhausted: loadExhausted })
  const handleLoadMore = useCallback(() => {
    const probe = { key: viewKey, before: rows.length, settled: false }
    setLoadProbe(probe)
    Promise.resolve(onLoadMore()).catch(() => undefined).finally(() => {
      setLoadProbe((current) => (current === probe ? { ...probe, settled: true } : current))
    })
  }, [onLoadMore, rows.length, viewKey])

  let body: ReactNode
  if (lens === 'scheduled' && scheduledPanel) {
    body = <div className="ixl-scheduled">{scheduledPanel}</div>
  } else if ((rows.length === 0 && loading) || rowsStale) {
    body = <SkeletonRows count={9} rowHeight={rowHeight} />
  } else if (rows.length === 0 && error) {
    body = <div className="ixl-state"><LCError what="Conversations didn't load" detail={error} onRetry={onRetry} /></div>
  } else if (rows.length === 0) {
    body = (
      <div className="ixl-state">
        {lens === 'filtered' ? (
          <LCEmpty title="No matches" body="No conversation matches these filters." icon="filter" action={{ label: 'Clear filters', onClick: onClearFilters }} />
        ) : (
          <LCEmpty title={currentDef?.empty.title ?? 'No conversations'} body={currentDef?.empty.body} tone="calm" icon="inbox" />
        )}
      </div>
    )
  } else {
    body = (
      <List<SlotProps>
        listRef={listRef}
        className="ixl-list"
        rowComponent={LedgerSlot}
        rowCount={rows.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        overscanCount={6}
        onRowsRendered={onRowsRendered}
        style={{ height: '100%' }}
        role="listbox"
        tabIndex={0}
        aria-label={`${lens === 'filtered' ? 'Filtered' : currentDef?.label ?? 'Inbox'} conversations`}
        aria-activedescendant={cursorId && rowIds.includes(cursorId) ? `${idPrefix}-${rowIds.indexOf(cursorId)}` : undefined}
        onKeyDown={onListKeyDown}
      />
    )
  }

  return (
    <section className={cx('ixl', `is-density-${density}`, headerOverride != null && 'is-pane')} data-lens={lens} aria-label={ariaLabel ?? 'Inbox triage'}>
      {headerOverride != null ? headerOverride : (
      <header className="ixl-head">
        <div className="ixl-head__top">
          <div className="ixl-head__title">
            <h1>Inbox</h1>
            {summary ? <p className="ixl-head__summary">{summary}</p> : null}
          </div>
          <div className="ixl-head__tools">
            {headerExtra}
            {lens !== 'filtered' ? (
              <LCButton variant="quiet" size="sm" icon="filter" onClick={onOpenFilters} className="ixl-head__filters">
                Filters
              </LCButton>
            ) : null}
          </div>
        </div>
        <div className="ixl-head__lens">
          <LCSegmented
            className="ixl-lens"
            size="sm"
            label="Triage lens"
            options={options}
            value={segmentValue}
            onChange={(value) => {
              if (value === 'filtered' || value === lens) return
              onLens(value as DeskLens)
            }}
          />
          <LCMenu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            label="More lenses"
            items={moreItems}
            width={320}
            align="start"
            trigger={(
              <LCButton variant="quiet" size="sm" trailingIcon="chevron-down" className={cx('ixl-more-trigger', secondary && 'is-active')} aria-label="More lenses">
                More
              </LCButton>
            )}
          />
        </div>
        {lens === 'filtered' ? (
          <LCFilterBar
            className="ixl-fbar"
            filters={filterChips.map((chip) => ({ id: chip.key, value: chip.label, onRemove: () => onRemoveFilterChip(chip.key) }))}
            onOpen={onOpenFilters}
            onClearAll={onClearFilters}
            count={typeof filteredTotal === 'number' ? filteredTotal : null}
            countNoun={filteredTotal === 1 ? 'conversation' : 'conversations'}
            persistent
          />
        ) : null}
      </header>
      )}

      <div className="ixl-plane">
        {rows.length > 0 && lens !== 'scheduled' ? (
          <div className="ixl-colhead" aria-hidden="true">
            <span />
            <span>Seller</span>
            <span>Latest</span>
            <span className="ixl-colhead__deal">Stage · Property</span>
            <span>State</span>
            <span className="ixl-colhead__when">Time</span>
          </div>
        ) : null}
        <div className="ixl-body">{body}</div>
        {selectable ? (
          <LCBulkBar
            className="ixl-bulkbar"
            count={selection.count}
            inView={rows.length}
            all={selection.all}
            noun={THREAD_NOUN}
            onSelectAll={selection.selectAll}
            onClear={selection.clear}
            actions={[
              archivedLens
                ? { id: 'unarchive', label: 'Unarchive', icon: 'refresh-cw', onRun: () => { leadBulk.clearItems(); void archiveSelected() }, disabled: anyBulkBusy }
                : { id: 'archive', label: 'Archive', icon: 'archive', onRun: () => { leadBulk.clearItems(); void archiveSelected() }, disabled: anyBulkBusy },
              { id: 'stage', label: 'Stage…', icon: 'layers', onRun: () => setChoice('stage'), disabled: anyBulkBusy },
              { id: 'follow_up', label: 'Follow-up…', icon: 'calendar', onRun: () => setChoice('follow_up'), disabled: anyBulkBusy },
              lens === 'snoozed'
                ? { id: 'unsnooze', label: 'Unsnooze', icon: 'clock', onRun: () => { void runLead('unsnooze') }, disabled: anyBulkBusy }
                : { id: 'snooze', label: 'Snooze…', icon: 'clock', onRun: () => setChoice('snooze'), disabled: anyBulkBusy },
              { id: 'read', label: 'Mark read', icon: 'check', onRun: () => { void runLead('read') }, disabled: anyBulkBusy },
              { id: 'unread', label: 'Mark unread', icon: 'message', onRun: () => { void runLead('unread') }, disabled: anyBulkBusy },
              { id: 'status', label: 'Status…', icon: 'activity', onRun: () => setChoice('status'), disabled: anyBulkBusy },
            ]}
            progress={bulk.progress ?? leadBulk.progress}
            outcome={bulk.outcome ?? leadBulk.outcome}
            onDismissOutcome={() => { bulk.dismissOutcome(); leadBulk.dismissOutcome() }}
          />
        ) : null}
        <BulkChoiceDialog
          kind={choice?.kind ?? null}
          openedAt={choice?.at ?? 0}
          count={selection.count}
          noun={THREAD_NOUN}
          onCancel={() => setChoice(null)}
          onConfirm={(value) => { const kind = choice?.kind; setChoice(null); if (kind) void runLead(kind, value) }}
        />
        {showLoadMore && lens !== 'scheduled' ? (
          <footer className="ixl-foot">
            <span className="ixl-foot__count">
              {lens === 'filtered'
                ? filteredCountLabel(filteredTotal, rows.length, canLoadMore)
                : `Showing ${rows.length.toLocaleString('en-US')}${typeof lensTotal === 'number' ? ` of ${lensTotal.toLocaleString('en-US')}` : ''}`}
            </span>
            <LCButton variant="quiet" size="sm" onClick={handleLoadMore} loading={loading || Boolean(loadProbe && !loadProbe.settled)}>
              Load more
            </LCButton>
          </footer>
        ) : loadExhausted && lens !== 'scheduled' ? (
          <footer className="ixl-foot">
            <span className="ixl-foot__count">
              {`Showing ${rows.length.toLocaleString('en-US')}${typeof lensTotal === 'number' && lensTotal > rows.length ? ` of ${lensTotal.toLocaleString('en-US')} counted` : ''} · nothing more loads for this list`}
            </span>
          </footer>
        ) : null}
      </div>
    </section>
  )
}

