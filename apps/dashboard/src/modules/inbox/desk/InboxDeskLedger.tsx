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
  isPrimaryLens,
  lensCount,
  lensDef,
  moveCursor,
  type DeskLens,
  type DeskLensKey,
  type LedgerRowModel,
} from './ledger-model'
import { readLedgerFacts, useLedgerFacts } from './ledger-facts'
import { enableRowSignals, useRowArrival, useRowSignal, type RowSignal } from './live-row-signals'
import { useLedgerClock } from './use-ledger-clock'
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
  onLoadMore: () => void
  onRetry: () => void
  onSnooze: (threadId: string) => void
  onMarkRead: (threadId: string) => void
  onOpenBeside: (thread: InboxWorkflowThread, app: BesideApp) => void
  /** the Scheduled lens reads send_queue, not thread rows */
  scheduledPanel?: ReactNode
  density?: 'standard' | 'dense'
}

const ROW_HEIGHT = { standard: 64, dense: 48 } as const

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

const LedgerRow = memo(function LedgerRow({
  thread, model, selected, cursor, optionId, handlers,
}: {
  thread: InboxWorkflowThread
  model: LedgerRowModel
  selected: boolean
  cursor: boolean
  optionId: string
  handlers: RowHandlers
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
        )}
        data-thread-id={model.id}
        {...objectAttrs(rowObject)}
        onClick={(e) => {
          // click opens the conversation · ⇧-click inspects the seller · ⌘/Ctrl-click opens Deal Intelligence beside
          if (gestureOf(e) === 'beside' && (model.propertyId || model.threadKey)) { e.preventDefault(); handlers.onOpenBeside(thread, 'deal-intelligence'); return }
          handleObjectClick(e, rowObject, () => { handlers.onCursor(model.id); handlers.onOpen(model.id) })
        }}
      >
        <span className="ixl-row__lead" aria-hidden="true">
          {model.needsYou ? <i className="ixl-mark is-attn" /> : model.unread ? <i className="ixl-mark is-unread" /> : null}
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
          {stateTransient ? <TransientChip signal={stateTransient} /> : model.lane ? (
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
  now: number
  factsVersion: number
  idPrefix: string
  handlers: RowHandlers
}

function LedgerSlot({ index, style, rows, lens, selectedId, cursorId, now, idPrefix, handlers }: RowComponentProps<SlotProps>) {
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
        optionId={`${idPrefix}-${index}`}
        handlers={handlers}
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
    onOpenBeside, scheduledPanel, density = 'standard',
  } = props
  const rowHeight = ROW_HEIGHT[density]
  const now = useLedgerClock()
  const listRef = useRef<ListImperativeAPI | null>(null)
  const [cursorId, setCursorId] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const idPrefix = 'ixl-opt'

  // The live-row store reads the Inbox channel's events only while a ledger is mounted.
  useEffect(() => enableRowSignals(), [])

  const rows = useMemo(
    () => sortNewestFirst(threads.filter((thread) => !hiddenIds?.has(`hidden:${thread.id}`))),
    [hiddenIds, threads],
  )
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows])
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
  }), [onMarkRead, onOpen, onOpenBeside, onSnooze])

  const rowProps = useMemo<SlotProps>(() => ({
    rows, lens, selectedId, cursorId, now, factsVersion, idPrefix, handlers,
  }), [cursorId, factsVersion, handlers, lens, now, rows, selectedId])

  /* scroll anchoring: a reply landing above the fold never moves what you are reading */
  const anchorRef = useRef<{ id: string; index: number } | null>(null)
  const onRowsRendered = useCallback((visible: { startIndex: number; stopIndex: number }) => {
    const id = rowIds[visible.startIndex]
    anchorRef.current = id ? { id, index: visible.startIndex } : null
  }, [rowIds])
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const element = listRef.current?.element
    if (!anchor || !element || element.scrollTop <= 0) return
    const next = rowIds.indexOf(anchor.id)
    if (next >= 0 && next !== anchor.index) {
      element.scrollTop += (next - anchor.index) * rowHeight
      anchorRef.current = { id: anchor.id, index: next }
    }
  }, [rowHeight, rowIds])

  const scrollCursorIntoView = useCallback((id: string | null) => {
    if (!id) return
    const index = rowIds.indexOf(id)
    if (index >= 0) listRef.current?.scrollToRow({ index, align: 'smart', behavior: 'instant' })
  }, [rowIds])

  useEffect(() => { scrollCursorIntoView(cursorId) }, [cursorId, scrollCursorIntoView])

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1
      : event.key === 'PageDown' ? 10 : event.key === 'PageUp' ? -10 : 0
    if (step) {
      event.preventDefault()
      setCursorId((current) => moveCursor(rowIds, current ?? selectedId, step))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setCursorId(rowIds.length ? (event.key === 'Home' ? rowIds[0] : rowIds[rowIds.length - 1]) : null)
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
  const showLoadMore = rows.length > 0 && (canLoadMore || (typeof lensTotal === 'number' && lensTotal > rows.length))

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
    <section className={cx('ixl', `is-density-${density}`)} data-lens={lens} aria-label="Inbox triage">
      <header className="ixl-head">
        <div className="ixl-head__top">
          <div className="ixl-head__title">
            <h1>Inbox</h1>
            {summary ? <p className="ixl-head__summary">{summary}</p> : null}
          </div>
          {lens !== 'filtered' ? (
            <LCButton variant="quiet" size="sm" icon="filter" onClick={onOpenFilters} className="ixl-head__filters">
              Filters
            </LCButton>
          ) : null}
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
        {showLoadMore && lens !== 'scheduled' ? (
          <footer className="ixl-foot">
            <span className="ixl-foot__count">
              {lens === 'filtered'
                ? filteredCountLabel(filteredTotal, rows.length, canLoadMore)
                : `Showing ${rows.length.toLocaleString('en-US')}${typeof lensTotal === 'number' ? ` of ${lensTotal.toLocaleString('en-US')}` : ''}`}
            </span>
            <LCButton variant="quiet" size="sm" onClick={onLoadMore} loading={loading}>
              Load more
            </LCButton>
          </footer>
        ) : null}
      </div>
    </section>
  )
}

