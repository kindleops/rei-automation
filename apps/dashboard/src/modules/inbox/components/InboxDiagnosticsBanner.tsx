export interface InboxDiagnosticsBannerProps {
  counts?: Record<string, any>
  diagnostics?: Record<string, any>
}

export function InboxDiagnosticsBanner({ counts, diagnostics }: InboxDiagnosticsBannerProps) {
  const isDebug = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEBUG === "true"
  if (!isDebug || (!counts && !diagnostics)) return null

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
      <div style={{ fontWeight: 'bold', color: '#fff' }}>[BACKEND CONTRACT DIAGNOSTICS]</div>
      <div>All Messages: {counts?.all_messages ?? 0}</div>
      <div>New Replies: {counts?.new_replies ?? 0}</div>
      <div>Priority: {counts?.priority ?? 0}</div>
      <div>Needs Review: {counts?.needs_review ?? 0}</div>
      <div>Follow Up: {counts?.follow_up ?? 0}</div>
      <div>Cold: {counts?.cold ?? 0}</div>
      <div>Suppressed: {counts?.suppressed ?? 0}</div>
      <div>Raw Events Scanned: {diagnostics?.raw_events_scanned ?? 0}</div>
      <div>Threads Built: {diagnostics?.threads_built ?? 0}</div>
      <div>Inbound Events: {diagnostics?.inbound_events ?? 0}</div>
      <div>Outbound Events: {diagnostics?.outbound_events ?? 0}</div>
      <div>Rows Scanned: {diagnostics?.count_rows_scanned ?? 0}</div>
      {diagnostics?.exclusion_reasons && (
        <div style={{ width: '100%', color: '#ffb86c' }}>
          Exclusions: {typeof diagnostics.exclusion_reasons === 'object' ? JSON.stringify(diagnostics.exclusion_reasons) : diagnostics.exclusion_reasons}
        </div>
      )}
    </div>
  )
}
