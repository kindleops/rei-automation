import { Icon } from '../../../../shared/icons'
import type { IconName } from '../../../../shared/icons'
import type { QueueSection } from '../../queue-ui-helpers'
import type { QueueAttentionSummary } from '../../queue-mobile-semantics'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** Each stat maps directly to a server-filterable status bucket. */
export type QueueMobileStat = 'queued' | 'sending' | 'failed' | 'scheduled' | 'blocked' | 'approval'

const fmt = (n: number) => (n > 9999 ? `${Math.round(n / 1000)}k` : n.toLocaleString())

interface SectionDef {
  key: QueueSection
  label: string
  icon: string
  badge: number
}

interface QueueMobileHeaderProps {
  section: QueueSection
  sections: SectionDef[]
  title: string
  /** Secondary identity line, e.g. "17,320 rows · 7d". */
  meta: string
  /** Health tiles belong to the queue itself; other sections own their counts. */
  showHealth: boolean
  summary: QueueAttentionSummary
  activeStat: QueueMobileStat | null
  loading?: boolean
  onSection: (section: QueueSection) => void
  onStat: (stat: QueueMobileStat) => void
  onRefresh: () => void
}

/**
 * Mobile queue chrome: identity → attention-first health → module rail.
 * Deliberately shallow so the first queue row lands inside ~250px of
 * queue-specific content.
 */
export function QueueMobileHeader({
  section,
  sections,
  title,
  meta,
  showHealth,
  summary,
  activeStat,
  loading,
  onSection,
  onStat,
  onRefresh,
}: QueueMobileHeaderProps) {
  const stats: Array<{ key: QueueMobileStat; label: string; value: number; tone: string }> = [
    { key: 'queued', label: 'Queued', value: summary.queued, tone: 'blue' },
    { key: 'sending', label: 'Sending', value: summary.sending, tone: 'cyan' },
    { key: 'failed', label: 'Failed', value: summary.failed, tone: 'red' },
  ]

  // Remaining actionable buckets, shown only when they hold work. Kept out of
  // the tile row so the three dominant states keep their weight.
  const secondaryAll: Array<{ key: QueueMobileStat; label: string; value: number; tone: string }> = [
    { key: 'scheduled', label: 'scheduled', value: summary.scheduled, tone: 'blue' },
    { key: 'blocked', label: 'blocked', value: summary.blocked, tone: 'amber' },
    { key: 'approval', label: 'need approval', value: summary.approval, tone: 'amber' },
  ]
  const secondary = secondaryAll.filter((s) => s.value > 0)

  return (
    <header className="qm-head">
      <div className="qm-head__top">
        <div className="qm-head__identity">
          <h1 className="qm-head__title">{title}</h1>
          <span className="qm-head__meta">
            {meta}
            {loading && <span className="qm-head__sync">syncing</span>}
          </span>
        </div>
        <button
          type="button"
          className={cls('qm-iconbtn', loading && 'is-busy')}
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh queue"
        >
          <Icon name="refresh-cw" size={14} />
        </button>
      </div>

      {showHealth && (
      <div className="qm-health" role="group" aria-label="Queue health">
        {stats.map((s) => (
          <button
            key={s.key}
            type="button"
            className={cls('qm-stat', `is-${s.tone}`, s.value > 0 && 'has-value', activeStat === s.key && 'is-active')}
            onClick={() => onStat(s.key)}
            aria-pressed={activeStat === s.key}
          >
            <strong className="qm-stat__value">{fmt(s.value)}</strong>
            <span className="qm-stat__label">{s.label}</span>
          </button>
        ))}
        <span className="qm-health__quiet" title="Historical dispatch totals for this range">
          <span>{fmt(summary.delivered)} delivered</span>
          <span>{fmt(summary.sent)} sent</span>
        </span>
      </div>
      )}

      {showHealth && secondary.length > 0 && (
        <div className="qm-health__more">
          {secondary.map((s) => (
            <button
              key={s.key}
              type="button"
              className={cls('qm-health__more-btn', `is-${s.tone}`, activeStat === s.key && 'is-active')}
              onClick={() => onStat(s.key)}
              aria-pressed={activeStat === s.key}
            >
              <strong>{fmt(s.value)}</strong> {s.label}
            </button>
          ))}
        </div>
      )}

      <nav className="qm-rail" role="tablist" aria-label="Queue command views">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={section === s.key}
            className={cls('qm-rail__tab', section === s.key && 'is-active')}
            onClick={() => onSection(s.key)}
          >
            <Icon name={s.icon as IconName} size={12} />
            <span>{s.label}</span>
            {s.badge > 0 && (
              <span className={cls('qm-rail__badge', s.key === 'failures' && 'is-red')}>
                {s.badge > 99 ? '99+' : s.badge}
              </span>
            )}
          </button>
        ))}
      </nav>
    </header>
  )
}
