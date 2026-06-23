import { type FC } from 'react'

type FailureSeverity = 'red' | 'amber' | 'muted'

interface FailureCategory {
  key: string
  label: string
  severity: FailureSeverity
  desc: string
  // Maps to failureGroup or failureReason values from QueueItem
  matchGroups?: string[]
  matchReasons?: string[]
}

const FAILURE_CATEGORIES: FailureCategory[] = [
  { key: 'textgrid_content_filter', label: 'TextGrid Content Filter', severity: 'red',   desc: 'Message rejected by TextGrid content policy filter.', matchGroups: ['Carrier'], matchReasons: ['textgrid_error'] },
  { key: 'blacklist_pair_21610',    label: '21610 Blacklist Pair',    severity: 'red',   desc: 'Number pair blocked due to 21610 regulatory blacklist.', matchGroups: ['Compliance'], matchReasons: ['dnc_conflict'] },
  { key: 'recipient_opted_out',     label: 'Recipient Opted Out',     severity: 'red',   desc: 'Recipient replied STOP or is on opt-out suppression list.', matchGroups: ['Compliance'], matchReasons: ['dnc_conflict'] },
  { key: 'invalid_number',          label: 'Invalid Number',          severity: 'amber', desc: 'Phone number is invalid, unroutable, or not in service.', matchGroups: ['Carrier'], matchReasons: ['invalid_phone'] },
  { key: 'suppression_blocked',     label: 'Suppression Blocked',     severity: 'amber', desc: 'Number is on internal suppression list.', matchGroups: ['Compliance'], matchReasons: ['dnc_conflict'] },
  { key: 'no_valid_sender',         label: 'No Valid Sender',         severity: 'red',   desc: 'No TextGrid number available to route this market.', matchGroups: ['Routing'], matchReasons: ['carrier_error'] },
  { key: 'missing_template',        label: 'Missing Template',        severity: 'amber', desc: 'Template not attached to queue row.', matchGroups: ['Template'], matchReasons: ['template_missing'] },
  { key: 'blank_message_body',      label: 'Blank Message Body',      severity: 'amber', desc: 'Message body is empty or could not be rendered.', matchGroups: ['Payload'], matchReasons: ['sync_error'] },
  { key: 'webhook_missing',         label: 'Webhook Missing',         severity: 'amber', desc: 'TextGrid webhook callback not received for this message.', matchGroups: ['Webhook'], matchReasons: ['textgrid_error'] },
  { key: 'message_event_missing',   label: 'Message Event Missing',   severity: 'amber', desc: 'message_event record not created after send.', matchGroups: ['Webhook'], matchReasons: ['sync_error'] },
  { key: 'carrier_failure',         label: 'Carrier Failure',         severity: 'red',   desc: 'Downstream carrier delivery failure.', matchGroups: ['Carrier'], matchReasons: ['carrier_error'] },
  { key: 'unknown',                 label: 'Unknown',                 severity: 'muted', desc: 'Uncategorized or unclassified failure.', matchGroups: ['Unknown'], matchReasons: ['unknown'] },
]

export { FAILURE_CATEGORIES }

interface QueueFailureTaxonomyProps {
  // Raw failure counts from queue items — key = failureGroup string
  groupCounts: Record<string, number>
  activeFilter: string | null
  onFilterChange: (key: string | null) => void
}

const dotStyle = (severity: FailureSeverity) => {
  if (severity === 'red')   return { background: 'rgba(248,113,113,0.8)' }
  if (severity === 'amber') return { background: 'rgba(251,191,36,0.8)' }
  return { background: 'rgba(108,133,178,0.38)' }
}

export const QueueFailureTaxonomy: FC<QueueFailureTaxonomyProps> = ({
  groupCounts,
  activeFilter,
  onFilterChange,
}) => {
  // Map group counts to our 12-category taxonomy
  // TODO: wire granular per-reason counts from message_events.failure_bucket
  const categoryCounts: Record<string, number> = {}
  for (const cat of FAILURE_CATEGORIES) {
    let count = 0
    if (cat.matchGroups) {
      for (const g of cat.matchGroups) {
        count += groupCounts[g] ?? 0
      }
    }
    // Distribute Unknown remainder to 'unknown' category
    if (cat.key === 'unknown') count = Math.max(count, groupCounts['Unknown'] ?? 0)
    categoryCounts[cat.key] = count
  }

  const maxCount = Math.max(1, ...Object.values(categoryCounts))
  const totalFailed = Object.values(groupCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="sqd-panel">
      <div className="sqd-panel__head">
        <span className="sqd-panel__eyebrow">Failure Taxonomy</span>
        {totalFailed > 0 && <span className="sqd-panel__count">{totalFailed} total</span>}
        {activeFilter && (
          <button type="button" className="sqd-clear-chip" onClick={() => onFilterChange(null)}>
            {activeFilter} ×
          </button>
        )}
      </div>

      {totalFailed === 0 ? (
        <div className="sqd-empty">
          <span className="sqd-empty__icon">✓</span>
          <span>No failures in current window</span>
        </div>
      ) : (
        <div className="sqd-failure-list">
          {FAILURE_CATEGORIES.map(cat => {
            const count = categoryCounts[cat.key] ?? 0
            const isActive = activeFilter === cat.key
            const barWidth = Math.max(count > 0 ? 4 : 0, (count / maxCount) * 100)
            return (
              <button
                key={cat.key}
                type="button"
                className={`sqd-failure-row is-${cat.severity}${isActive ? ' is-active' : ''}${count === 0 ? ' is-zero' : ''}`}
                onClick={() => onFilterChange(isActive ? null : cat.key)}
                disabled={count === 0}
              >
                <div className="sqd-failure-row__left">
                  <span className="sqd-failure-row__dot" style={dotStyle(cat.severity)} />
                  <span className="sqd-failure-row__name">{cat.label}</span>
                </div>
                <div className="sqd-failure-row__bar-wrap">
                  <div
                    className={`sqd-failure-row__bar is-${cat.severity}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <span className="sqd-failure-row__count">{count}</span>
                <p className="sqd-failure-row__desc">{cat.desc}</p>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
