import { useMemo, useState, memo } from 'react'
import type { InboxWorkflowThread, InboxStatusTab, InboxThreadsQuery, SellerStage } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import { formatRelativeTime } from '../../../shared/formatters'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface ThreadListProps {
  threads: InboxWorkflowThread[]
  selectedId: string | null
  onSelect: (id: string) => void
  workflowTab: InboxStatusTab
  setWorkflowTab: (tab: InboxStatusTab) => void
  workflowFilters?: InboxThreadsQuery
  setWorkflowFilters?: (f: InboxThreadsQuery) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  loadingError?: string | null
  onUpdateStage?: (id: string, stage: SellerStage) => void
  onArchive?: (thread: InboxWorkflowThread) => void
  onMarkRead?: (thread: InboxWorkflowThread) => void
}

const ThreadRow = memo(({ thread, isSelected, onSelect }: { thread: InboxWorkflowThread, isSelected: boolean, onSelect: (id: string) => void }) => (
  <div 
    className={cls('nx-thread-row', isSelected && 'is-selected')}
    onClick={() => onSelect(thread.id)}
  >
    <div className="nx-thread-row__avatar">
      {thread.ownerName[0]}
    </div>
    <div className="nx-thread-row__content">
      <div className="nx-thread-row__header">
        <span className="nx-thread-row__name">{thread.ownerName}</span>
        <span className="nx-thread-row__time">{formatRelativeTime(thread.lastInboundAt || thread.lastMessageAt)}</span>
      </div>
      <div className="nx-thread-row__subject">{thread.subject}</div>
      <div className="nx-thread-row__preview">{thread.preview}</div>
      <div className="nx-thread-row__meta">
        <span className={cls('nx-stage-pill', `is-${thread.inboxStatus}`)}>{thread.inboxStatus.replace(/_/g, ' ')}</span>
        {thread.unreadCount > 0 && <span className="nx-unread-dot" />}
      </div>
    </div>
  </div>
))

export const ThreadList = memo(({
  threads,
  selectedId,
  onSelect,
  workflowTab,
  setWorkflowTab,
  searchQuery,
  setSearchQuery,
  loadingError,
}: ThreadListProps) => {
  const [filterOpen, setFilterOpen] = useState(false)

  const filtered = useMemo(() => {
    return threads.filter(t => {
      let matchTab = false
      if (workflowTab === 'all') matchTab = true
      else if (workflowTab === 'priority') matchTab = Boolean(t.priority === 'urgent' || t.priority === 'high' || t.inboxStatus === 'new_reply' || t.isHotLead)
      else if (workflowTab === 'needs_response') matchTab = t.inboxStatus === 'new_reply' || t.inboxStatus === 'needs_review' || t.unreadCount > 0 || (t.unread as unknown as boolean)
      else if (workflowTab === 'sent') matchTab = t.inboxStatus === 'waiting' || t.latestDirection === 'outbound' || t.lastDirection === 'outbound'
      else matchTab = (t.inboxStatus as any) === workflowTab

      const matchSearch = !searchQuery || 
        t.ownerName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.subject?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.preview?.toLowerCase().includes(searchQuery.toLowerCase())
      
      return matchTab && matchSearch
    })
  }, [threads, workflowTab, searchQuery])

  return (
    <aside className="nx-thread-rail">
      <div className="nx-rail-header">
        <div className="nx-rail-title-row">
          <h1>Inbox</h1>
          <div className="nx-header-actions">
            <button 
              type="button" 
              className="nx-icon-button" 
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setFilterOpen(!filterOpen)
              }}
            >
              <Icon name="filter" style={{width: 16}} />
            </button>
          </div>
        </div>
        
        <div className="nx-search-container">
          <Icon name="search" className="nx-search-icon" />
          <input 
            type="text" 
            placeholder="Search threads..." 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="nx-quick-stages">
          {(['all', 'priority', 'needs_response', 'sent'] as InboxStatusTab[]).map(tab => (
            <button 
              key={tab}
              type="button"
              className={cls('nx-stage-filter', workflowTab === tab && 'is-active')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setWorkflowTab(tab)
              }}
            >
              {tab.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="nx-rail-list">
        {filtered.length === 0 ? (
          <div className="nx-rail-empty">
            <p>{loadingError && filtered.length === 0 ? 'Inbox could not load. Retry.' : 'No threads match your filters.'}</p>
          </div>
        ) : (
          <div className="nx-thread-list-items">
            {filtered.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                isSelected={selectedId === thread.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
})
