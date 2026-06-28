import { memo, useCallback, useMemo, useState } from 'react'
import { VirtualizedInboxList } from './VirtualizedInboxList'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { formatInboxThreadTimestamp } from '../../../shared/formatters'
import { resolveThreadAddressLine, resolveThreadMarketBadge, resolveThreadPrimaryName } from '../inbox-ui-helpers'
import { buildConversationDecision, type ConversationDecision } from '../../../domain/inbox/inbox-decisioning'
import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { MobileThreadCard } from '../../mobile/MobileThreadCard'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export type ConversationTableSort =
  | 'last_activity_desc'
  | 'priority_desc'
  | 'seller_asc'
  | 'temperature_desc'
  | 'follow_up_asc'

interface InboxConversationTableProps {
  threads: InboxWorkflowThread[]
  selectedId: string | null
  sort: ConversationTableSort
  density: 'comfortable' | 'compact' | 'ultra_compact'
  layoutMode?: ViewLayoutMode
  statCounts: Array<{ label: string; value: number | string | null | undefined }>
  onSortChange: (sort: ConversationTableSort) => void
  onDensityChange: (density: 'comfortable' | 'compact' | 'ultra_compact') => void
  onSelect: (id: string) => void
}

type LocalStatusFilter = 'all' | 'unread' | 'hot' | 'suppressed'
type LocalReplyFilter = 'all' | 'needs_reply' | 'waiting' | 'follow_up_due'
type LocalContactFilter = 'all' | 'uncontacted' | 'contacted' | 'has_conversation' | 'has_queue' | 'has_message'

const sorters: Record<ConversationTableSort, (a: RowModel, b: RowModel) => number> = {
  last_activity_desc: (a, b) => b.lastActivityMs - a.lastActivityMs,
  priority_desc: (a, b) => b.decision.priority_score - a.decision.priority_score,
  seller_asc: (a, b) => a.seller.localeCompare(b.seller),
  temperature_desc: (a, b) => rankTemperature(b.decision.lead_temperature) - rankTemperature(a.decision.lead_temperature),
  follow_up_asc: (a, b) => (a.followUpMs || Number.MAX_SAFE_INTEGER) - (b.followUpMs || Number.MAX_SAFE_INTEGER),
}

type RowModel = {
  thread: InboxWorkflowThread
  decision: ConversationDecision
  seller: string
  address: string
  market: string
  lastIntent: string
  lastMessagePreview: string
  priorityLabel: string
  isHot: boolean
  isSuppressed: boolean
  isUnread: boolean
  lastActivityMs: number
  followUpMs: number | null
}

const rankTemperature = (value: ConversationDecision['lead_temperature']) => {
  if (value === 'READY_TO_CLOSE') return 5
  if (value === 'VERY_HOT') return 4
  if (value === 'HOT') return 3
  if (value === 'WARM') return 2
  return 1
}

const formatStat = (value: number | string | null | undefined) => value === null || value === undefined ? '—' : String(value)

const intentLabel = (decision: ConversationDecision) =>
  decision.intent_tags[0] || decision.seller_intent.replace(/_/g, ' ') || 'Unknown'

export const InboxConversationTable = memo(({
  threads,
  selectedId,
  sort,
  density,
  layoutMode = 'full',
  statCounts,
  onSortChange,
  onDensityChange,
  onSelect,
}: InboxConversationTableProps) => {
  const { isMobile } = useBreakpoint()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<LocalStatusFilter>('all')
  const [replyFilter, setReplyFilter] = useState<LocalReplyFilter>('all')
  const [marketFilter, setMarketFilter] = useState<string>('all')
  const [contactFilter, setContactFilter] = useState<LocalContactFilter>('all')

  const rows = useMemo(() => {
    return threads
      .map((thread) => {
        const decision = buildConversationDecision(thread)
        const seller = resolveThreadPrimaryName(thread)
        const address = resolveThreadAddressLine(thread)
        const market = resolveThreadMarketBadge(thread)
        const lastIntent = String((thread as any).uiIntent || (thread as any).detected_intent || decision.intent_tags[0] || decision.seller_intent || 'unknown')
          .replace(/_/g, ' ')
        const lastMessagePreview = String(thread.lastMessageBody || thread.preview || 'No recent message').trim()
        const priorityLabel = String(thread.priority || '').trim() || (
          decision.priority_score >= 85
            ? 'Urgent'
            : decision.priority_score >= 65
            ? 'High'
            : decision.priority_score >= 40
            ? 'Normal'
            : 'Low'
        )
        const isHot = ['HOT', 'VERY_HOT', 'READY_TO_CLOSE'].includes(decision.lead_temperature) || ['urgent', 'high'].includes(String(thread.priority || '').toLowerCase())
        const isSuppressed = decision.suppression_status === 'suppressed' || Boolean(thread.isSuppressed)
        const isUnread = decision.unread || Boolean((thread as any).unread) || Number((thread as any).unreadCount || 0) > 0
        const lastActivityMs = new Date(thread.lastMessageAt || thread.lastMessageIso || 0).getTime()
        const followUpMs = decision.next_follow_up_at ? new Date(decision.next_follow_up_at).getTime() : null
        return {
          thread,
          decision,
          seller,
          address,
          market,
          lastIntent,
          lastMessagePreview,
          priorityLabel,
          isHot,
          isSuppressed,
          isUnread,
          lastActivityMs,
          followUpMs,
        }
      })
      .filter((row) => {
        const search = query.trim().toLowerCase()
        if (search) {
          const haystack = [row.seller, row.address, row.market, row.lastIntent, row.lastMessagePreview, row.thread.phoneNumber || row.thread.canonicalE164 || '']
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(search)) return false
        }
        if (statusFilter === 'unread' && !row.isUnread) return false
        if (statusFilter === 'hot' && !row.isHot) return false
        if (statusFilter === 'suppressed' && !row.isSuppressed) return false
        if (replyFilter === 'needs_reply' && !row.isUnread) return false
        if (replyFilter === 'waiting' && row.thread.inboxStatus !== 'waiting') return false
        if (replyFilter === 'follow_up_due' && !row.decision.next_follow_up_at) return false
        if (marketFilter !== 'all' && row.market !== marketFilter) return false
        
        if (contactFilter === 'uncontacted' && !(row.thread as any).is_uncontacted) return false
        if (contactFilter === 'contacted' && (row.thread as any).is_uncontacted) return false
        if (contactFilter === 'has_conversation' && !(row.thread as any).has_conversation) return false
        if (contactFilter === 'has_queue' && !(row.thread as any).has_queue) return false
        if (contactFilter === 'has_message' && !(row.thread as any).has_message_event) return false
        
        return true
      })
      .sort(sorters[sort])
  }, [marketFilter, query, replyFilter, sort, statusFilter, threads, contactFilter])

  const markets = useMemo(
    () => Array.from(new Set(threads.map((thread) => resolveThreadMarketBadge(thread) || 'Market Unknown'))).sort(),
    [threads],
  )

  const hasLocalFilters = query.trim().length > 0 || statusFilter !== 'all' || replyFilter !== 'all' || marketFilter !== 'all'
  const shouldVirtualize = rows.length >= 12
  const virtualRowHeight = density === 'ultra_compact' ? 44 : density === 'compact' ? 52 : 64

  const renderCompactCard = useCallback((row: RowModel) => {
    const ts = formatInboxThreadTimestamp(row.thread.lastMessageAt || row.thread.lastMessageIso)
    return (
      <button
        type="button"
        className={cls('nx-thread-card', selectedId === row.thread.id && 'is-selected')}
        onClick={() => onSelect(row.thread.id)}
      >
        <div className="nx-thread-card__row">
          <div>
            <strong className="nx-thread-card__title">{row.seller || 'Unknown seller'}</strong>
            <span className="nx-thread-card__subtitle">{row.address || 'No address available'}</span>
          </div>
          <time className="nx-thread-card__time">{ts.fullLabel}</time>
        </div>
        {renderStatusBadges(row)}
        {layoutMode === 'medium' && (
          <div className="nx-thread-card__meta-grid">
            <span><label>Market</label><strong>{row.market || '—'}</strong></span>
            <span><label>Intent</label><strong>{row.lastIntent || '—'}</strong></span>
            <span><label>Next Action</label><strong>{row.decision.next_action || '—'}</strong></span>
            <span><label>Automation</label><strong>{row.decision.automation_status}</strong></span>
          </div>
        )}
        <p className="nx-thread-card__preview">{row.lastMessagePreview}</p>
      </button>
    )
  }, [layoutMode, onSelect, selectedId])

  const renderStatusBadges = (row: RowModel) => (
    <div className="nx-thread-card__badges">
      <span className="nx-table-pill is-stage">{row.decision.conversation_stage.replace(/_/g, ' ')}</span>
      <span className="nx-table-pill is-auto">{row.thread.inboxStatus.replace(/_/g, ' ')}</span>
      <span className="nx-table-pill is-temp">{row.priorityLabel}</span>
      {row.isHot && <span className="nx-table-pill is-hot">Hot</span>}
      {(row.thread as any).is_uncontacted && <span className="nx-table-pill is-cold">Uncontacted</span>}
      {row.isSuppressed && <span className="nx-table-pill is-suppressed">Suppressed</span>}
      {row.isUnread && <span className="nx-table-pill is-unread">Unread</span>}
    </div>
  )

  const controlRow = (
    <div className="nx-inbox-list-toolbar">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="nx-inbox-list-toolbar__search"
        placeholder="Search seller, phone, address, message, market…"
      />
      <select value={contactFilter} onChange={(event) => setContactFilter(event.target.value as LocalContactFilter)}>
        <option value="all">Contact Level</option>
        <option value="uncontacted">Uncontacted Only</option>
        <option value="contacted">Contacted Only</option>
        <option value="has_conversation">Has Conversation</option>
        <option value="has_queue">In Queue</option>
        <option value="has_message">Has Events</option>
      </select>
      <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as LocalStatusFilter)}>
        <option value="all">All Status</option>
        <option value="unread">Unread</option>
        <option value="hot">Hot</option>
        <option value="suppressed">Suppressed</option>
      </select>
      <select value={replyFilter} onChange={(event) => setReplyFilter(event.target.value as LocalReplyFilter)}>
        <option value="all">All Reply States</option>
        <option value="needs_reply">Needs Reply</option>
        <option value="waiting">Awaiting Response</option>
        <option value="follow_up_due">Follow-Up Due</option>
      </select>
      <select value={marketFilter} onChange={(event) => setMarketFilter(event.target.value)}>
        <option value="all">All Markets</option>
        {markets.map((market) => (
          <option key={market} value={market}>{market}</option>
        ))}
      </select>
      <select value={sort} onChange={(event) => onSortChange(event.target.value as ConversationTableSort)}>
        <option value="last_activity_desc">Latest Activity</option>
        <option value="priority_desc">Priority</option>
        <option value="seller_asc">Seller</option>
        <option value="temperature_desc">Temperature</option>
        <option value="follow_up_asc">Follow-Up</option>
      </select>
      {hasLocalFilters ? (
        <button type="button" className="nx-inbox-list-toolbar__clear" onClick={() => {
          setQuery('')
          setStatusFilter('all')
          setReplyFilter('all')
          setMarketFilter('all')
          setContactFilter('all')
        }}>
          Clear
        </button>
      ) : null}
    </div>
  )

  if (layoutMode === 'compact' || layoutMode === 'medium') {
    return (
      <section className={cls('nx-inbox-table-view', `is-${density}`, `is-layout-${layoutMode}`)}>
        <header className="nx-inbox-table-view__header">
          <div>
            <span className="nx-section-label">LIST VIEW</span>
            <h2>Operational Conversations</h2>
          </div>
          <div className="nx-inbox-table-view__controls" />
        </header>

        {controlRow}

        <div className="nx-inbox-stat-strip" aria-label="List view stats">
          {statCounts.map((item) => (
            <div key={item.label} className="nx-inbox-stat-strip__item">
              <span>{item.label}</span>
              <strong>{formatStat(item.value)}</strong>
            </div>
          ))}
        </div>

        <div className={cls('nx-thread-card-list', layoutMode === 'medium' && 'is-medium', shouldVirtualize && 'is-virtualized')}>
          {shouldVirtualize ? (
            <VirtualizedInboxList
              items={rows}
              rowHeight={layoutMode === 'medium' ? virtualRowHeight + 28 : virtualRowHeight}
              className="nx-inbox-table-virtual-list"
              renderRow={(row) => renderCompactCard(row)}
            />
          ) : rows.map((row) => (
            <div key={row.thread.id}>{renderCompactCard(row)}</div>
          ))}
        </div>
      </section>
    )
  }

  if (layoutMode === 'expanded') {
    return (
      <section className={cls('nx-inbox-table-view', `is-${density}`, 'is-layout-expanded')}>
        <header className="nx-inbox-table-view__header">
          <div>
            <span className="nx-section-label">LIST VIEW</span>
            <h2>Operational Conversations</h2>
          </div>
          <div className="nx-inbox-table-view__controls" />
        </header>
        {controlRow}
        <div className="nx-inbox-stat-strip" aria-label="List view stats">
          {statCounts.map((item) => (
            <div key={item.label} className="nx-inbox-stat-strip__item">
              <span>{item.label}</span>
              <strong>{formatStat(item.value)}</strong>
            </div>
          ))}
        </div>
        <div className="nx-inbox-table-wrap">
          <table className="nx-inbox-table">
            <thead>
              <tr>
                <th>Seller</th>
                <th>Property</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Priority</th>
                <th>Intent</th>
                <th>Automation</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { thread, decision, seller, address, lastIntent, priorityLabel, isHot, isSuppressed, isUnread } = row
                const ts = formatInboxThreadTimestamp(thread.lastMessageAt || thread.lastMessageIso)
                return (
                  <tr
                    key={thread.id}
                    className={cls(selectedId === thread.id && 'is-selected')}
                    onClick={() => onSelect(thread.id)}
                  >
                    <td>
                      <div className="nx-inbox-table__primary">{seller}</div>
                      <div className="nx-inbox-table__secondary">{thread.phoneNumber || thread.canonicalE164 || '—'}</div>
                    </td>
                    <td>
                      <div className="nx-inbox-table__primary">{address || '—'}</div>
                    </td>
                    <td><span className="nx-table-pill is-auto">{thread.inboxStatus.replace(/_/g, ' ')}</span></td>
                    <td><span className="nx-table-pill is-stage">{decision.conversation_stage.replace(/_/g, ' ')}</span></td>
                    <td>
                      <span className="nx-table-pill is-temp">{priorityLabel}</span>
                      {isHot && <span className="nx-table-pill is-hot"> Hot</span>}
                    </td>
                    <td><span className="nx-table-pill is-intent">{lastIntent || intentLabel(decision)}</span></td>
                    <td><span className="nx-table-pill is-auto">{decision.automation_status}</span></td>
                    <td>
                      {ts.fullLabel}
                      {isUnread && <> <span className="nx-table-pill is-unread">Unread</span></>}
                      {isSuppressed && <> <span className="nx-table-pill is-suppressed">Supp</span></>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    )
  }

  return (
    <section className={cls('nx-inbox-table-view', `is-${density}`, `is-layout-${layoutMode}`)}>
      <header className="nx-inbox-table-view__header">
        <div>
          <span className="nx-section-label">LIST VIEW</span>
          <h2>Operational Conversations</h2>
        </div>
        <div className="nx-inbox-table-view__controls">
          <div className="nx-inbox-density-switch" role="tablist" aria-label="Table density">
            {([
              ['comfortable', 'Comfortable'],
              ['compact', 'Compact'],
              ['ultra_compact', 'Ultra Compact'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className={cls('nx-inbox-density-switch__btn', density === value && 'is-active')} onClick={() => onDensityChange(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {controlRow}

      <div className="nx-inbox-stat-strip" aria-label="List view stats">
        {statCounts.map((item) => (
          <div key={item.label} className="nx-inbox-stat-strip__item">
            <span>{item.label}</span>
            <strong>{formatStat(item.value)}</strong>
          </div>
        ))}
      </div>

      {isMobile ? (
        <div className="nx-mobile-card-list">
          {rows.map((row) => (
            <MobileThreadCard
              key={row.thread.id}
              thread={row.thread}
              decision={row.decision}
              selected={selectedId === row.thread.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      <div className="nx-inbox-table-wrap">
        <table className="nx-inbox-table">
          <thead>
            <tr>
              <th>Seller</th>
              <th>Property</th>
              <th>Market</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Priority</th>
              <th>Intent</th>
              <th>Next Action</th>
              <th>Automation</th>
              <th>Message</th>
              <th>Last</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { thread, decision, seller, address, market, lastIntent, lastMessagePreview, priorityLabel, isHot, isSuppressed, isUnread } = row
              const ts = formatInboxThreadTimestamp(thread.lastMessageAt || thread.lastMessageIso)
              return (
                <tr
                  key={thread.id}
                  className={cls(selectedId === thread.id && 'is-selected')}
                  onClick={() => onSelect(thread.id)}
                >
                  <td>
                    <div className="nx-inbox-table__primary">{seller}</div>
                    <div className="nx-inbox-table__secondary">{thread.phoneNumber || thread.canonicalE164 || '—'}</div>
                  </td>
                  <td>
                    <div className="nx-inbox-table__primary">{address || '—'}</div>
                    <div className="nx-inbox-table__secondary">{(thread as any).propertyType || (thread as any).property_type || '—'}</div>
                  </td>
                  <td>{market || '—'}</td>
                  <td><span className="nx-table-pill is-auto">{thread.inboxStatus.replace(/_/g, ' ')}</span></td>
                  <td><span className="nx-table-pill is-stage">{decision.conversation_stage.replace(/_/g, ' ')}</span></td>
                  <td><span className="nx-table-pill is-temp">{priorityLabel}</span></td>
                  <td><span className="nx-table-pill is-intent">{lastIntent || intentLabel(decision)}</span></td>
                  <td className="is-preview">{decision.next_action}</td>
                  <td><span className="nx-table-pill is-auto">{decision.automation_status}</span></td>
                  <td className="is-preview">{lastMessagePreview}</td>
                  <td>{ts.fullLabel}</td>
                  <td>
                    <div className="nx-thread-card__badges is-inline">
                      {isHot && <span className="nx-table-pill is-hot">Hot</span>}
                      {isSuppressed && <span className="nx-table-pill is-suppressed">Suppressed</span>}
                      {isUnread && <span className="nx-table-pill is-unread">Unread</span>}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
})

InboxConversationTable.displayName = 'InboxConversationTable'
