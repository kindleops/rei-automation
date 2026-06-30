import type { ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import { resolveAssetTypeIcon } from '../../../shared/asset-type-icons'
import type { QueueItem } from '../../../domain/queue/queue.types'
import { STAGE_LABELS } from '../../../domain/queue/queue.types'
import {
  resolveSellerIdentity,
  resolveStatusPresentation,
  resolveTemplateLabel,
  resolveMessageSource,
  isNonRetryableRow,
  queueShowsMessagePreview,
  type QueueDensity,
} from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const fmtPhone = (p: string | null | undefined) => (p ? `···${p.slice(-4)}` : '—')

const STAGE_TONE: Record<string, string> = {
  S1: 'blue', S2: 'cyan', S3: 'violet', S4: 'amber', S5: 'green',
  manual_reply: 'muted', auto_reply: 'teal',
}

const STATUS_GLOW: Record<string, string> = {
  green: 'var(--occ-green)',
  blue: 'var(--occ-blue)',
  cyan: 'var(--occ-cyan)',
  amber: 'var(--occ-amber)',
  red: 'var(--occ-red)',
  muted: 'var(--occ-dim)',
}

interface OccMobileQueueCardProps {
  item: QueueItem
  isSelected: boolean
  isChecked: boolean
  density: QueueDensity
  onClick: () => void
  onCheck: (id: string) => void
}

function MetricChip({
  icon,
  children,
  tone,
  mono,
  title,
}: {
  icon?: IconName
  children: ReactNode
  tone?: string
  mono?: boolean
  title?: string
}) {
  return (
    <span className={cls('occ-mchip', tone && `is-${tone}`, mono && 'is-mono')} title={title}>
      {icon && <Icon name={icon} size={10} />}
      <span className="occ-mchip__val">{children}</span>
    </span>
  )
}

function MobileSelectToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: () => void
}) {
  return (
    <label className="occ-mqcard__select" onClick={e => e.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} />
      <span className="occ-mqcard__select-ui" aria-hidden="true">
        <Icon name="check" size={11} />
      </span>
    </label>
  )
}

export function OccMobileQueueCard({
  item,
  isSelected,
  isChecked,
  density,
  onClick,
  onCheck,
}: OccMobileQueueCardProps) {
  const identity = resolveSellerIdentity(item)
  const statusView = resolveStatusPresentation(item)
  const asset = resolveAssetTypeIcon(item.propertyType)
  const stageLabel = item.stageLabel ?? (item.stageCode ? STAGE_LABELS[item.stageCode] : '—')
  const stageTone = item.stageCode ? (STAGE_TONE[item.stageCode] ?? 'muted') : 'muted'
  const cityState = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const workflowLane = resolveMessageSource(item)
  const campaignLabel = item.campaignName ?? item.automationSource ?? item.useCase ?? '—'
  const templateLabel = resolveTemplateLabel(item)
  const currentFailure = statusView.hasCurrentException ? statusView.blocking : null
  const contactOk = item.smsEligible !== false && item.routingAllowed !== false
  const propertyLine = [item.propertyAddress, cityState].filter(Boolean).join(' · ') || 'No address on file'
  const messageSnippet = item.messageText?.replace(/\s+/g, ' ').trim()
  const accent = STATUS_GLOW[statusView.tone] ?? STATUS_GLOW.muted
  const footSignal = item.retryEligible && !isNonRetryableRow(item)
    ? 'Retry eligible'
    : item.smsEligible === false
      ? 'SMS blocked'
      : workflowLane

  if (density === 'command') {
    return (
      <article
        className={cls('occ-mqcard', 'occ-mqcard--command', isSelected && 'is-selected', isChecked && 'is-checked')}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        style={{ '--occ-mq-accent': accent } as React.CSSProperties}
      >
        <span className="occ-mqcard__accent" aria-hidden="true" />
        <div className="occ-mqcard__shell occ-mqcard__shell--command">
          <div className="occ-mqcard-cmd__top">
            <div className="occ-mqcard__avatar occ-mqcard__avatar--sm">
              <Icon name={asset.icon} size={11} />
            </div>
            <div className="occ-mqcard-cmd__lead">
              <strong className="occ-mqcard-cmd__name">{identity.primary}</strong>
              {identity.phoneEnding && <span className="occ-mchip is-mono is-dim">{identity.phoneEnding}</span>}
            </div>
            <span className={cls('occ-status-pill', 'occ-status-pill--mobile', `is-${statusView.tone}`)}>{statusView.primary}</span>
            <MobileSelectToggle checked={isChecked} label={`Select ${identity.primary}`} onChange={() => onCheck(item.id)} />
          </div>
          <p className="occ-mqcard-cmd__line" title={propertyLine}>{propertyLine}</p>
          <div className="occ-mqcard-cmd__rail">
            {item.stageCode
              ? <MetricChip tone={stageTone} title={stageLabel}>{item.stageCode}</MetricChip>
              : <MetricChip tone="muted">—</MetricChip>}
            <MetricChip icon="hash" title="Touch number">T{item.touchNumber}</MetricChip>
            <MetricChip icon="zap" title={campaignLabel}>{campaignLabel}</MetricChip>
            <MetricChip icon="file-text" title={templateLabel}>{templateLabel}</MetricChip>
            {messageSnippet && (
              <span className="occ-mqcard-cmd__msg" title={messageSnippet}>{messageSnippet}</span>
            )}
            <MetricChip icon="phone" mono title="Sender">{fmtPhone(item.fromPhoneNumber)}</MetricChip>
            <MetricChip icon="pin" title="Market">{item.market || '—'}</MetricChip>
            <MetricChip icon="clock" tone={item.overdue ? 'amber' : undefined} title="Scheduled">{relTime(item.scheduledForLocal)}</MetricChip>
            <MetricChip icon="activity" title="Last event">{relTime(item.lastEventAt ?? item.updatedAt)}</MetricChip>
            {currentFailure && <MetricChip tone="red" title={currentFailure}>{currentFailure}</MetricChip>}
          </div>
        </div>
      </article>
    )
  }

  const isCompact = density === 'compact'

  return (
    <article
      className={cls(
        'occ-mqcard',
        isCompact ? 'occ-mqcard--compact' : 'occ-mqcard--comfort',
        isSelected && 'is-selected',
        isChecked && 'is-checked',
        `is-density-${density}`,
      )}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      style={{ '--occ-mq-accent': accent } as React.CSSProperties}
    >
      <span className="occ-mqcard__accent" aria-hidden="true" />
      <div className={cls('occ-mqcard__shell', isCompact && 'occ-mqcard__shell--compact')}>
        <header className="occ-mqcard__hero">
          <div className="occ-mqcard__hero-main">
            <div className={cls('occ-mqcard__avatar', isCompact && 'occ-mqcard__avatar--sm')}>
              <Icon name={asset.icon} size={isCompact ? 11 : 13} />
              <span className={cls('occ-mqcard__signal', contactOk ? 'is-ok' : 'is-warn')} title={contactOk ? 'SMS eligible' : 'Contact blocked'} />
            </div>
            <div className="occ-mqcard__identity-block">
              <div className="occ-mqcard__name-row">
                <strong className="occ-mqcard__seller">{identity.primary}</strong>
                {identity.phoneEnding && <span className="occ-mqcard__phone">{identity.phoneEnding}</span>}
              </div>
              {!isCompact && identity.secondary && (
                <span className="occ-mqcard__secondary">{identity.secondary}</span>
              )}
            </div>
          </div>
          <div className="occ-mqcard__hero-actions">
            <span className={cls('occ-status-pill', 'occ-status-pill--mobile', `is-${statusView.tone}`)}>{statusView.primary}</span>
            <MobileSelectToggle checked={isChecked} label={`Select ${identity.primary}`} onChange={() => onCheck(item.id)} />
          </div>
        </header>

        <div className="occ-mqcard__property">
          <span className="occ-mqcard__property-icon" aria-hidden="true">
            <Icon name="pin" size={12} />
          </span>
          <div className="occ-mqcard__property-copy">
            <strong title={item.propertyAddress ?? undefined}>{item.propertyAddress || 'No address on file'}</strong>
            {(cityState || (isCompact && identity.secondary)) && (
              <span>
                {isCompact && identity.secondary ? identity.secondary : cityState}
                {isCompact && identity.secondary && cityState ? ` · ${cityState}` : ''}
              </span>
            )}
          </div>
        </div>

        <div className={cls('occ-mqcard__metrics', isCompact && 'occ-mqcard__metrics--scroll')}>
          <MetricChip tone={stageTone} title={stageLabel}>
            {item.stageCode ?? '—'}{!isCompact && stageLabel !== '—' ? ` · ${stageLabel}` : ''}
          </MetricChip>
          <MetricChip icon="hash" title="Touch">T{item.touchNumber}</MetricChip>
          <MetricChip icon="zap" title={campaignLabel}>{campaignLabel}</MetricChip>
          <MetricChip icon="pin" title="Market">{item.market || '—'}</MetricChip>
          <MetricChip icon="file-text" title={templateLabel}>{templateLabel}</MetricChip>
          <MetricChip icon="phone" mono title="From">{fmtPhone(item.fromPhoneNumber)}</MetricChip>
          <MetricChip icon="clock" tone={item.overdue ? 'amber' : undefined} title="Scheduled">{relTime(item.scheduledForLocal)}</MetricChip>
          <MetricChip icon="activity" title="Last touch">{relTime(item.lastEventAt ?? item.updatedAt)}</MetricChip>
          {!isCompact && (
            <>
              <MetricChip icon="layers" title="Workflow">{workflowLane}</MetricChip>
              {currentFailure
                ? <MetricChip tone="red" title={currentFailure}>{currentFailure}</MetricChip>
                : <MetricChip tone="muted" title="Failure state">Clear</MetricChip>}
            </>
          )}
        </div>

        {queueShowsMessagePreview(density) && item.messageText && (
          <blockquote className="occ-mqcard__quote">
            <span className="occ-mqcard__quote-mark" aria-hidden="true">“</span>
            <p>{item.messageText}</p>
          </blockquote>
        )}

        <footer className="occ-mqcard__foot">
          <span className="occ-mqcard__foot-signal">{footSignal}</span>
          <span className="occ-mqcard__foot-cta">
            Open
            <Icon name="chevron-right" size={14} />
          </span>
        </footer>
      </div>
    </article>
  )
}