import { type FC } from 'react'

type StageTone = 'blue' | 'cyan' | 'green' | 'amber' | 'red' | 'muted'

interface PipelineStage {
  key: string
  label: string
  statuses: string[]
  tone: StageTone
  historical?: boolean
  isPreQueue?: boolean
}

// FIXED pipeline order per spec
const PIPELINE_STAGES: PipelineStage[] = [
  { key: 'approval',  label: 'Candidate',  statuses: ['approval'],                        tone: 'muted',  isPreQueue: true },
  { key: 'ready',     label: 'Ready',      statuses: ['ready'],                           tone: 'cyan'  },
  { key: 'scheduled', label: 'Scheduled',  statuses: ['scheduled'],                       tone: 'blue'  },
  { key: 'queued',    label: 'Queued',     statuses: ['queued','pending'],                tone: 'blue'  },
  { key: 'sending',   label: 'Sending',    statuses: ['sending','processing'],            tone: 'blue'  },
  { key: 'sent',      label: 'Sent',       statuses: ['sent'],                            tone: 'green', historical: true },
  { key: 'delivered', label: 'Delivered',  statuses: ['delivered'],                      tone: 'green', historical: true },
  { key: 'replied',   label: 'Replied',    statuses: ['replied_before_send'],            tone: 'green', historical: true },
  { key: 'failed',    label: 'Failed',     statuses: ['failed','retry','blocked'],        tone: 'red',   historical: true },
]

export { PIPELINE_STAGES }
export type { PipelineStage, StageTone }

interface QueuePipelineBarProps {
  stageCounts: Record<string, number>
  statusFilter: string
  timeWindow: '24h' | 'today' | '7d'
  totalItems: number
  isLoading: boolean
  lastCheckedAt?: string | null
  onStageClick: (key: string) => void
  onTimeWindowChange: (w: '24h' | 'today' | '7d') => void
}

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export const QueuePipelineBar: FC<QueuePipelineBarProps> = ({
  stageCounts,
  statusFilter,
  timeWindow,
  totalItems,
  isLoading,
  lastCheckedAt,
  onStageClick,
  onTimeWindowChange,
}) => {
  return (
    <div className="sqd-pipeline">
      <div className="sqd-pipeline__top">
        <div className="sqd-pipeline__inner">
          {PIPELINE_STAGES.map((stage, i) => {
            const count = stageCounts[stage.key] ?? 0
            const isActive = statusFilter === stage.key
            const isPreQueue = stage.isPreQueue
            return (
              <div key={stage.key} className="sqd-pipeline__step">
                {isPreQueue && (
                  <div className="sqd-pipeline__prequeue-label">source</div>
                )}
                <button
                  type="button"
                  className={[
                    'sqd-stage',
                    `is-${stage.tone}`,
                    isActive ? 'is-active' : '',
                    count === 0 ? 'is-zero' : '',
                    isPreQueue ? 'is-prequeue' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onStageClick(stage.key)}
                  title={`Filter by ${stage.label}${stage.isPreQueue ? ' (pre-queue source)' : ''}`}
                >
                  <span className="sqd-stage__count">{count.toLocaleString()}</span>
                  <span className="sqd-stage__label">{stage.label}</span>
                  {stage.historical && <span className="sqd-stage__win" title="Time-windowed" />}
                  {isPreQueue && <span className="sqd-stage__prequeue-tag">pre-queue</span>}
                </button>
                {isPreQueue && <span className="sqd-pipeline__arrow sqd-pipeline__arrow--prequeue">⟶</span>}
                {!isPreQueue && i < PIPELINE_STAGES.length - 1 && (
                  <span className="sqd-pipeline__arrow">›</span>
                )}
              </div>
            )
          })}
        </div>
        <div className="sqd-window-tabs">
          {(['today', '24h', '7d'] as const).map(w => (
            <button
              key={w}
              type="button"
              className={`sqd-window-tab${timeWindow === w ? ' is-active' : ''}`}
              onClick={() => onTimeWindowChange(w)}
            >
              {w === 'today' ? 'Today' : w === '24h' ? 'Last 24h' : 'Last 7d'}
            </button>
          ))}
        </div>
      </div>
      <div className="sqd-pipeline__footer">
        {isLoading
          ? <span className="sqd-pipeline__loading"><span className="sqd-spinner sqd-spinner--sm" />Loading queue data…</span>
          : <span>{totalItems.toLocaleString()} rows loaded</span>
        }
        {lastCheckedAt && (
          <span className="sqd-pipeline__checked">Last checked {relTime(lastCheckedAt)}</span>
        )}
      </div>
    </div>
  )
}
