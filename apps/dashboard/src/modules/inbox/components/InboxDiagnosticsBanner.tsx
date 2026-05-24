import React from 'react'

export interface InboxDiagnosticsBannerProps {
  debugInfo?: Record<string, any>
}

export function InboxDiagnosticsBanner({ debugInfo }: InboxDiagnosticsBannerProps) {
  if (!debugInfo || Object.keys(debugInfo).length === 0) return null

  return (
    <div style={{
      background: '#1a1a2e',
      color: '#00ffcc',
      padding: '12px 16px',
      fontSize: '12px',
      fontFamily: 'monospace',
      borderBottom: '1px solid #333',
      display: 'flex',
      flexWrap: 'wrap',
      gap: '16px',
      alignItems: 'center',
      zIndex: 100,
      position: 'relative'
    }}>
      <div style={{ fontWeight: 'bold', color: '#fff' }}>[DIAGNOSTICS]</div>
      <div>Raw Inbound: {debugInfo.raw_inbound_events ?? 0}</div>
      <div>Raw Outbound: {debugInfo.raw_outbound_events ?? 0}</div>
      <div>Normalized Inbound: {debugInfo.normalized_inbound_events ?? 0}</div>
      <div>Normalized Outbound: {debugInfo.normalized_outbound_events ?? 0}</div>
      <div>Threads w/ Latest Inbound: {debugInfo.threads_with_latest_inbound ?? 0}</div>
      <div>Threads w/ Latest Outbound: {debugInfo.threads_with_latest_outbound ?? 0}</div>
      {/* These next three might not be in debugInfo directly if calculated on frontend, but we can display if they are */}
      {debugInfo.new_replies_count !== undefined && <div>New Replies: {debugInfo.new_replies_count}</div>}
      {debugInfo.priority_count !== undefined && <div>Priority: {debugInfo.priority_count}</div>}
      {debugInfo.needs_review_count !== undefined && <div>Needs Review: {debugInfo.needs_review_count}</div>}
      {debugInfo.top_5_exclusion_reasons && <div style={{ width: '100%' }}>Top 5 Exclusions: {debugInfo.top_5_exclusion_reasons}</div>}
    </div>
  )
}
