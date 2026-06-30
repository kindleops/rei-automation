import { Icon } from '../../../../shared/icons'
import { resolveAssetTypeIcon } from '../../../../shared/asset-type-icons'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import type { FailureCauseStat } from '../../failure-taxonomy-stats'
import { FAILURE_CATEGORY_TONE } from '../../failure-taxonomy-stats'
import { resolveSellerIdentity, resolveTemplateLabel } from '../../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '—' : s.length > max ? s.slice(0, max) + '…' : s

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

interface FailureDossierPanelProps {
  stat: FailureCauseStat
  previewRows: QueueItem[]
  onViewRows: (cause: string) => void
  onClose?: () => void
  compact?: boolean
}

export function FailureDossierPanel({
  stat,
  previewRows,
  onViewRows,
  onClose,
  compact = false,
}: FailureDossierPanelProps) {
  const tone = FAILURE_CATEGORY_TONE[stat.category] ?? 'amber'

  return (
    <aside className={cls('occ-fail-dossier', compact && 'occ-fail-dossier--compact')}>
      <header className="occ-fail-dossier__head">
        <div className="occ-fail-dossier__title-wrap">
          <span className={cls('occ-fail-dossier__dot', `is-${tone}`)} aria-hidden="true" />
          <div>
            <strong className="occ-fail-dossier__title">{stat.label}</strong>
            <span className="occ-fail-dossier__cause">{stat.cause.replace(/_/g, ' ')}</span>
          </div>
        </div>
        <div className="occ-fail-dossier__head-actions">
          <span className={cls('occ-fail-dossier__count', `is-${tone}`)}>{stat.count}</span>
          {onClose && (
            <button type="button" className="occ-fail-dossier__close" onClick={onClose} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="occ-fail-dossier__badges">
        <span className={cls('occ-fail-dossier__badge', `is-${tone}`)}>{stat.category}</span>
        <span className={cls('occ-fail-dossier__badge', stat.retryable ? 'is-green' : 'is-red')}>
          {stat.retryable ? 'Retryable' : 'Non-retryable'}
        </span>
        {stat.suppression && <span className="occ-fail-dossier__badge is-red">Suppress required</span>}
        <span className="occ-fail-dossier__badge is-muted">{stat.pctOfTotal}% of failures</span>
      </div>

      <p className="occ-fail-dossier__action">{stat.action}</p>

      <div className="occ-fail-dossier__metrics">
        <div className="occ-fail-dossier__metric">
          <span>Failed</span><strong>{stat.failedCount}</strong>
        </div>
        <div className="occ-fail-dossier__metric">
          <span>Blocked</span><strong>{stat.blockedCount}</strong>
        </div>
        <div className="occ-fail-dossier__metric">
          <span>Markets</span><strong>{stat.markets.length}</strong>
        </div>
        <div className="occ-fail-dossier__metric">
          <span>Senders</span><strong>{stat.senders.length}</strong>
        </div>
        <div className="occ-fail-dossier__metric">
          <span>Templates</span><strong>{stat.templates.length}</strong>
        </div>
        <div className="occ-fail-dossier__metric">
          <span>Last seen</span><strong>{relTime(stat.lastSeen)}</strong>
        </div>
      </div>

      {stat.markets.length > 0 && (
        <div className="occ-fail-dossier__section">
          <span className="occ-fail-dossier__section-title">Affected markets</span>
          <div className="occ-fail-dossier__chips">
            {stat.markets.slice(0, 8).map((m) => <span key={m} className="occ-chip">{truncate(m, 18)}</span>)}
            {stat.markets.length > 8 && <span className="occ-chip is-muted">+{stat.markets.length - 8}</span>}
          </div>
        </div>
      )}

      {stat.senders.length > 0 && (
        <div className="occ-fail-dossier__section">
          <span className="occ-fail-dossier__section-title">Senders</span>
          <div className="occ-fail-dossier__chips">
            {stat.senders.slice(0, 6).map((p) => <span key={p} className="occ-chip occ-mono">…{p.slice(-4)}</span>)}
            {stat.senders.length > 6 && <span className="occ-chip is-muted">+{stat.senders.length - 6}</span>}
          </div>
        </div>
      )}

      <div className="occ-fail-dossier__preview">
        <span className="occ-fail-dossier__preview-title">Affected rows (sample)</span>
        {previewRows.length === 0 && <p className="occ-fail-dossier__empty">No preview rows on this page.</p>}
        {previewRows.map((row) => {
          const id = resolveSellerIdentity(row)
          const asset = resolveAssetTypeIcon(row.propertyType)
          return (
            <div key={row.id} className="occ-fail-preview-row">
              <span className="occ-asset-icon" title={asset.label}><Icon name={asset.icon} size={9} /></span>
              <strong>{truncate(id.primary, 20)}</strong>
              {id.phoneEnding && <span className="occ-contact-badge">{id.phoneEnding}</span>}
              <span>{truncate(row.propertyAddress, 18)}</span>
              <span>{truncate(row.market, 14)}</span>
              <span>{resolveTemplateLabel(row)}</span>
            </div>
          )
        })}
      </div>

      <button type="button" className="occ-action-btn is-primary occ-fail-dossier__cta" onClick={() => onViewRows(stat.cause)}>
        Open {stat.count} rows in Queue
      </button>
    </aside>
  )
}