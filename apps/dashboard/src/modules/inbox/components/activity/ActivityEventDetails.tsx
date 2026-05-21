import { useMemo, useState } from 'react'
import type { ActivityEvent } from '../../inbox-ui-helpers'

interface ActivityEventDetailsProps {
  event: ActivityEvent
}

const detailRow = (label: string, value: unknown) => {
  const text = String(value ?? '').trim()
  if (!text) return null
  return (
    <div key={label} className="nx-activity-detail-row">
      <span>{label}</span>
      <b>{text}</b>
    </div>
  )
}

export const ActivityEventDetails = ({ event }: ActivityEventDetailsProps) => {
  const [copied, setCopied] = useState(false)

  const jsonPreview = useMemo(() => {
    if (!event.metadata) return ''
    return JSON.stringify(event.metadata, null, 2)
  }, [event.metadata])

  const copyPayload = useMemo(() => JSON.stringify(event, null, 2), [event])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyPayload)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="nx-activity-details">
      <div className="nx-activity-detail-grid">
        {detailRow('Raw event', event.eventType)}
        {detailRow('Status', event.status)}
        {detailRow('Confidence', event.confidence)}
        {detailRow('Message ID', event.relatedIds?.messageId)}
        {detailRow('Queue row ID', event.relatedIds?.queueRowId)}
        {detailRow('Template ID', event.relatedIds?.templateId)}
        {detailRow('Property ID', event.relatedIds?.propertyId)}
        {detailRow('Master owner ID', event.relatedIds?.masterOwnerId)}
        {detailRow('Prospect ID', event.relatedIds?.prospectId)}
        {detailRow('Offer ID', event.relatedIds?.offerId)}
        {detailRow('Contract ID', event.relatedIds?.contractId)}
        {detailRow('Buyer match ID', event.relatedIds?.buyerMatchId)}
      </div>

      {jsonPreview && (
        <pre className="nx-activity-json" aria-label="Metadata preview">
          {jsonPreview}
        </pre>
      )}

      <div className="nx-activity-detail-actions">
        <button 
          type="button" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onCopy()
          }}
        >
          {copied ? 'Copied' : 'Copy event data'}
        </button>
      </div>
    </div>
  )
}
