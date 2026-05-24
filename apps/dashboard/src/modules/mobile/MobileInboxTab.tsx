import { useState, useEffect, useCallback, useRef } from 'react'
import { getSupabaseClient } from '../../lib/supabaseClient'
import {
  getInboxThreads,
  getThreadMessagesForThread,
  sendInboxMessageNow,
  type ThreadMessage,
} from '../../lib/data/inboxData'
import {
  updateThreadStage,
  updateThreadStatus,
  type InboxStatus,
  type SellerStage,
} from '../../lib/data/inboxWorkflowData'
import type { InboxThread } from '../inbox/inbox.adapter'
import { emitNotification } from '../../shared/NotificationToast'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'

const STAGES: { value: SellerStage; label: string }[] = [
  { value: 'ownership_check', label: 'Ownership Check' },
  { value: 'interest_probe', label: 'Interest Probe' },
  { value: 'seller_response', label: 'Seller Response' },
  { value: 'price_discovery', label: 'Price Discovery' },
  { value: 'condition_details', label: 'Condition Details' },
  { value: 'offer_reveal', label: 'Offer Reveal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'contract_path', label: 'Contract Path' },
  { value: 'dead_suppressed', label: 'Dead / Suppressed' },
]

const STATUSES: { value: InboxStatus; label: string }[] = [
  { value: 'new_reply', label: 'New Reply' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'ai_draft_ready', label: 'AI Draft Ready' },
  { value: 'queued', label: 'Queued' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'suppressed', label: 'Suppressed' },
  { value: 'closed', label: 'Closed' },
]

const TEMPS = ['hot', 'warm', 'neutral', 'cold']

interface MobileInboxTabProps {
  onNewReplyCount?: (count: number) => void
}

const getThreadDisplayName = (t: InboxThread) =>
  t.sellerName || t.ownerName || t.ownerDisplayName || t.phoneNumber || t.sellerPhone || '—'

const getThreadPhone = (t: InboxThread) =>
  t.sellerPhone || t.canonicalE164 || t.phoneNumber || ''

const getLastMessagePreview = (t: InboxThread) =>
  t.latestMessageBody || t.preview || t.subject || ''

const getLastMessageTime = (t: InboxThread) =>
  t.latestMessageAt || t.lastMessageIso || ''

const getTemperature = (t: InboxThread) =>
  t.sentiment || ''

const getStage = (t: InboxThread) =>
  t.workflowStage || t.threadWorkflowStage || ''

const getWorkflowStatus = (t: InboxThread) =>
  t.workflowStatus || t.threadWorkflowStatus || ''

const isUnread = (t: InboxThread) =>
  t.unread || t.status === 'unread' || (t.unreadCount != null && t.unreadCount > 0)

const isInbound = (t: InboxThread) =>
  t.latestDirection === 'inbound' || t.directionUsed === 'inbound'

export const MobileInboxTab = ({ onNewReplyCount }: MobileInboxTabProps) => {
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [loading, setLoading] = useState(true)
  const [errorInfo, setErrorInfo] = useState<string | null>(null)
  const [selectedThread, setSelectedThread] = useState<InboxThread | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [translateMode, setTranslateMode] = useState(false)
  const [stageFilter, setStageFilter] = useState('all')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadThreads = useCallback(async () => {
    try {
      setErrorInfo(null)
      const result = await getInboxThreads({}, { maxRows: 50 })
      const list = result.threads
      setThreads(list)
      const newCount = list.filter(isInbound).length
      onNewReplyCount?.(newCount)
      if (list.length === 0) {
        setErrorInfo('Loaded 0 threads. (bypassed to message_events)')
      }
    } catch (err) {
      console.error('[MobileInbox] load failed', err)
      setErrorInfo(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [onNewReplyCount])

  const loadMessages = useCallback(async (thread: InboxThread) => {
    setMessagesLoading(true)
    setMessages([])
    try {
      const msgs = await getThreadMessagesForThread(thread)
      setMessages(msgs)
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      console.error('[MobileInbox] messages load failed', err)
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadThreads()
    const supabase = getSupabaseClient()
    const ch = supabase
      .channel('mobile-inbox-live')
      .on('postgres_changes', { event: '*', table: 'message_events', schema: 'public' }, () => {
        loadThreads()
        if (selectedThread) loadMessages(selectedThread)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadThreads, loadMessages, selectedThread])

  const openThread = (thread: InboxThread) => {
    setSelectedThread(thread)
    loadMessages(thread)
  }

  const handleSend = async () => {
    if (!draft.trim() || !selectedThread || sending) return
    const body = draft.trim()
    setSending(true)
    setDraft('')

    try {
      const textToSend = translateMode ? `[TRANSLATED] ${body}` : body
      const res = await sendInboxMessageNow(selectedThread, textToSend)
      if (res.ok) {
        emitNotification({ title: 'Sent', detail: 'Message dispatched', severity: 'success', sound: 'notification' })
        await loadMessages(selectedThread)
      } else {
        emitNotification({ title: 'Send Failed', detail: res.errorMessage || 'Unknown error', severity: 'critical' })
        setDraft(body)
      }
    } catch (e) {
      emitNotification({ title: 'Error', detail: e instanceof Error ? e.message : 'Send failed', severity: 'critical' })
      setDraft(body)
    } finally {
      setSending(false)
    }
  }

  const handleStageChange = async (stage: SellerStage) => {
    if (!selectedThread) return
    try {
      await updateThreadStage(selectedThread, stage)
      emitNotification({ title: 'Stage Updated', detail: stage.replace(/_/g, ' '), severity: 'success', sound: 'notification' })
    } catch (e) {
      emitNotification({ title: 'Update Failed', detail: e instanceof Error ? e.message : 'Error', severity: 'critical' })
    }
  }

  const handleStatusChange = async (status: InboxStatus) => {
    if (!selectedThread) return
    try {
      await updateThreadStatus(selectedThread, status)
      emitNotification({ title: 'Status Updated', detail: status.replace(/_/g, ' '), severity: 'success', sound: 'notification' })
    } catch (e) {
      emitNotification({ title: 'Update Failed', detail: e instanceof Error ? e.message : 'Error', severity: 'critical' })
    }
  }

  const tempColorClass = (t: string) => {
    if (t === 'hot') return 'is-hot'
    if (t === 'warm') return 'is-warm'
    if (t === 'cold') return 'is-cold'
    return ''
  }

  const filtered = stageFilter === 'all'
    ? threads
    : threads.filter(t => getStage(t) === stageFilter)

  // ── Conversation view ──────────────────────────────────────────────────────
  if (selectedThread) {
    const currentStage = getStage(selectedThread)
    const currentStatus = getWorkflowStatus(selectedThread)
    const currentTemp = getTemperature(selectedThread)

    return (
      <div className="nx-m-conversation">
        <div className="nx-m-conv-header">
          <div className="nx-m-conv-back" onClick={() => setSelectedThread(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span className="nx-m-conv-back-label">Inbox</span>
          </div>
          <div className="nx-m-conv-title">{getThreadDisplayName(selectedThread)}</div>
          <div className="nx-m-conv-subtitle">
            {selectedThread.propertyAddress || getThreadPhone(selectedThread)}
          </div>
          <div className="nx-m-conv-controls">
            <select
              className="nx-m-select"
              defaultValue={currentStage}
              onChange={e => handleStageChange(e.target.value as SellerStage)}
            >
              <option value="" disabled>Stage</option>
              {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select
              className="nx-m-select"
              defaultValue={currentStatus}
              onChange={e => handleStatusChange(e.target.value as InboxStatus)}
            >
              <option value="" disabled>Status</option>
              {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select
              className="nx-m-select"
              defaultValue={currentTemp}
              style={{ flex: '0 0 84px' }}
            >
              {TEMPS.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
        </div>

        <div className="nx-m-messages">
          {messagesLoading && (
            <div className="nx-m-loading"><div className="nx-m-spinner" /></div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`nx-m-msg is-${msg.direction}`}>
              {msg.body}
              <div className="nx-m-msg-meta">{formatRelativeTime(msg.createdAt || msg.timelineAt)}</div>
            </div>
          ))}
          {messages.length === 0 && !messagesLoading && (
            <div className="nx-m-empty">No messages in this thread</div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="nx-m-composer">
          <div className="nx-m-composer-actions">
            <button
              className={`nx-m-toggle ${translateMode ? 'is-on' : ''}`}
              onClick={() => setTranslateMode(t => !t)}
            >
              <Icon name="globe" style={{ width: 13, height: 13 }} />
              Translate {translateMode ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="nx-m-composer-row">
            <textarea
              className="nx-m-composer-input"
              placeholder="Type a message..."
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
            />
            <button
              className="nx-m-send-btn"
              onClick={handleSend}
              disabled={!draft.trim() || sending}
            >
              {sending ? (
                <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'nx-m-spin 0.8s linear infinite' }} />
              ) : (
                <Icon name="send" style={{ width: 16, height: 16 }} />
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Thread list ─────────────────────────────────────────────────────────────
  return (
    <div className="nx-m-inbox">
      {errorInfo && (
        <div style={{
          background: '#fff3cd',
          border: '1px solid #f5c6cb',
          color: '#856404',
          padding: '8px 16px',
          fontSize: '12px',
          fontFamily: 'monospace',
          zIndex: 9999,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          margin: '8px'
        }}>
          <div style={{ fontWeight: 'bold' }}>⚠️ PRODUCTION INBOX DIAGNOSTICS</div>
          <div><b>Endpoint Called:</b> message_events (bypass)</div>
          <div><b>Error:</b> {errorInfo}</div>
          <div><b>Status:</b> {errorInfo.includes('bypassed') ? '200 OK' : 'Failed'}</div>
        </div>
      )}

      <div className="nx-m-bucket-tabs">
        <button
          className={`nx-m-bucket-tab ${stageFilter === 'all' ? 'is-active' : ''}`}
          onClick={() => setStageFilter('all')}
        >
          All <span className="nx-m-bucket-count">{threads.length}</span>
        </button>
        {['seller_response', 'negotiation', 'offer_reveal', 'price_discovery'].map(stage => (
          <button
            key={stage}
            className={`nx-m-bucket-tab ${stageFilter === stage ? 'is-active' : ''}`}
            onClick={() => setStageFilter(stage)}
          >
            {stage.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="nx-m-loading">
          <div className="nx-m-spinner" />
          <span>Loading inbox...</span>
        </div>
      ) : (
        <div className="nx-m-threads">
          {filtered.length === 0 && <div className="nx-m-empty">No conversations</div>}
          {filtered.map(thread => {
            const unread = isUnread(thread)
            const temp = getTemperature(thread)
            const stage = getStage(thread)
            const initials = getThreadDisplayName(thread).slice(0, 2).toUpperCase()

            return (
              <div
                key={thread.threadKey || thread.id}
                className={`nx-m-thread-item ${unread ? 'is-unread' : ''}`}
                onClick={() => openThread(thread)}
              >
                {unread && <div className="nx-m-thread-unread-dot" />}
                <div className="nx-m-thread-avatar">{initials}</div>
                <div className="nx-m-thread-body">
                  <div className="nx-m-thread-header">
                    <span className="nx-m-thread-name">{getThreadDisplayName(thread)}</span>
                    <span className="nx-m-thread-time">{formatRelativeTime(getLastMessageTime(thread))}</span>
                  </div>
                  <div className="nx-m-thread-preview">{getLastMessagePreview(thread)}</div>
                  <div className="nx-m-thread-tags">
                    {temp && temp !== 'neutral' && (
                      <span className={`nx-m-tag ${tempColorClass(temp)}`}>{temp}</span>
                    )}
                    {stage && (
                      <span className="nx-m-tag is-stage">{stage.replace(/_/g, ' ')}</span>
                    )}
                    {isInbound(thread) && <span className="nx-m-tag is-new">Reply</span>}
                    {thread.needsResponse && <span className="nx-m-tag is-warning">Needs Response</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
