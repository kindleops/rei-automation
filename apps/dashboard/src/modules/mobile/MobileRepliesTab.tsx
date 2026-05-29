import { useState, useEffect, useCallback } from 'react'
import { getSupabaseClient } from '../../lib/supabaseClient'
import { getInboxThreads } from '../../lib/data/inboxData'
import type { InboxThread } from '../inbox/inbox.adapter'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'

type Bucket = 'new' | 'priority' | 'needs_review' | 'follow_up' | 'hot_leads'

const BUCKETS: { id: Bucket; label: string }[] = [
  { id: 'new', label: 'New Replies' },
  { id: 'priority', label: 'Priority' },
  { id: 'needs_review', label: 'Needs Review' },
  { id: 'follow_up', label: 'Follow Up' },
  { id: 'hot_leads', label: 'Hot Leads' },
]

const classifyThread = (t: InboxThread): Bucket[] => {
  const buckets: Bucket[] = []
  const temp = t.sentiment || ''
  const status = t.workflowStatus || t.threadWorkflowStatus || ''
  const stage = t.workflowStage || t.threadWorkflowStage || ''
  const inbound = t.latestDirection === 'inbound' || t.directionUsed === 'inbound'

  if (inbound || (t.unreadCount != null && t.unreadCount > 0)) buckets.push('new')
  if (temp === 'hot') { buckets.push('hot_leads'); buckets.push('priority') }
  if (status === 'needs_review') buckets.push('needs_review')
  if (stage === 'negotiation' || stage === 'offer_reveal') buckets.push('priority')
  if (status === 'waiting' || t.needsResponse) buckets.push('follow_up')

  return buckets.length > 0 ? buckets : ['new']
}

export const MobileRepliesTab = () => {
  const [threads, setThreads] = useState<InboxThread[]>([])
  const [loading, setLoading] = useState(true)
  const [activeBucket, setActiveBucket] = useState<Bucket>('new')

  const load = useCallback(async () => {
    try {
      const result = await getInboxThreads({}, { maxRows: 100 })
      setThreads(result.threads)
    } catch (err) {
      console.error('[MobileReplies] load failed', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const supabase = getSupabaseClient()
    const ch = supabase
      .channel('mobile-replies-live')
      .on('postgres_changes', { event: '*', table: 'message_events', schema: 'public' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const bucketCounts = BUCKETS.reduce((acc, b) => {
    acc[b.id] = threads.filter(t => classifyThread(t).includes(b.id)).length
    return acc
  }, {} as Record<Bucket, number>)

  const visible = threads.filter(t => classifyThread(t).includes(activeBucket))

  const tempColorClass = (temp: string) => {
    if (temp === 'hot') return 'is-hot'
    if (temp === 'warm') return 'is-warm'
    return 'is-cold'
  }

  return (
    <div className="nx-m-replies">
      <div className="nx-m-bucket-tabs">
        {BUCKETS.map(b => (
          <button
            key={b.id}
            type="button"
            className={`nx-m-bucket-tab ${activeBucket === b.id ? 'is-active' : ''}`}
            onClick={() => setActiveBucket(b.id)}
          >
            {b.label}
            <span className="nx-m-bucket-count">{bucketCounts[b.id] || 0}</span>
          </button>
        ))}
      </div>

      {loading && (
        <div className="nx-m-loading">
          <div className="nx-m-spinner" />
          <span>Loading replies...</span>
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div className="nx-m-empty">
          <Icon name="check" style={{ width: 40, height: 40 }} />
          <div>No {BUCKETS.find(b => b.id === activeBucket)?.label.toLowerCase()} right now</div>
        </div>
      )}

      {visible.map(thread => {
        const temp = thread.sentiment || ''
        const stage = (thread.workflowStage || thread.threadWorkflowStage || '').replace(/_/g, ' ')
        const isHot = temp === 'hot'
        const name = thread.sellerName || thread.ownerName || thread.ownerDisplayName || thread.phoneNumber || '—'
        const preview = thread.latestMessageBody || thread.preview || '—'
        const time = thread.latestMessageAt || thread.lastMessageIso || ''

        return (
          <div
            key={thread.threadKey || thread.id}
            className={`nx-m-reply-card ${isHot ? 'is-hot-lead' : ''}`}
          >
            <div className="nx-m-reply-header">
              <div>
                <div className="nx-m-reply-who">{name}</div>
                {thread.propertyAddress && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                    {thread.propertyAddress}
                  </div>
                )}
              </div>
              <div className="nx-m-reply-time">{formatRelativeTime(time)}</div>
            </div>
            <div className="nx-m-reply-body">{preview}</div>
            <div className="nx-m-reply-footer">
              {temp && temp !== 'neutral' && (
                <span className={`nx-m-tag ${tempColorClass(temp)}`}>{temp}</span>
              )}
              {stage && <span className="nx-m-tag is-stage">{stage}</span>}
              {isHot && <span className="nx-m-tag is-hot">Hot Lead</span>}
              {thread.needsResponse && <span className="nx-m-tag is-warning">Needs Response</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
