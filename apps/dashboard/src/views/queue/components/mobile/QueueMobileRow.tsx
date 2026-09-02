import { Icon } from '../../../../shared/icons'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import { resolveSellerIdentity, resolveStatusPresentation } from '../../queue-ui-helpers'
import { resolveTouchStageDisplay } from '../../../../domain/queue/queue-status-truth'
import { resolveQueueRowSignal, resolveQueueStateMap } from '../../queue-mobile-semantics'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60000)
  if (Math.abs(min) < 1) return 'now'
  if (Math.abs(min) < 60) return `${Math.abs(min)}m`
  const h = Math.round(min / 60)
  if (Math.abs(h) < 24) return `${Math.abs(h)}h`
  return `${Math.abs(Math.round(h / 24))}d`
}

interface QueueMobileRowProps {
  item: QueueItem
  isOpen: boolean
  isChecked: boolean
  selectionMode: boolean
  onOpen: () => void
  onToggleCheck: (id: string) => void
}

/**
 * One dominant state per row. Secondary campaign / template / sender / market
 * detail lives in the command sheet, not here.
 */
export function QueueMobileRow({
  item,
  isOpen,
  isChecked,
  selectionMode,
  onOpen,
  onToggleCheck,
}: QueueMobileRowProps) {
  const identity = resolveSellerIdentity(item)
  const state = resolveQueueStateMap(item)
  const statusView = resolveStatusPresentation(item)
  const signal = resolveQueueRowSignal(item, state)
  const stage = resolveTouchStageDisplay(item)

  const place = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const propertyLine = [item.propertyAddress, place].filter(Boolean).join(' · ') || 'No address on file'
  const context = [
    stage.stageCode ?? null,
    stage.stageLabel && stage.stageLabel !== 'Unknown / Needs reconciliation' ? stage.stageLabel : null,
    relTime(item.lastEventAt ?? item.sentAt ?? item.scheduledForLocal ?? item.updatedAt),
  ].filter(Boolean).join(' · ')

  const activate = () => {
    if (selectionMode) onToggleCheck(item.id)
    else onOpen()
  }

  return (
    <article
      className={cls('qm-row', `is-${statusView.tone}`, isOpen && 'is-open', isChecked && 'is-checked')}
      role="button"
      tabIndex={0}
      aria-pressed={selectionMode ? isChecked : isOpen}
      onClick={activate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } }}
    >
      <span className="qm-row__accent" aria-hidden="true" />
      {selectionMode && (
        <span className={cls('qm-row__check', isChecked && 'is-checked')} aria-hidden="true">
          <Icon name="check" size={12} />
        </span>
      )}
      <div className="qm-row__body">
        <div className="qm-row__lead">
          <strong className="qm-row__name">{identity.primary}</strong>
          {identity.phoneEnding && <span className="qm-row__phone">{identity.phoneEnding}</span>}
        </div>
        <p className="qm-row__place" title={propertyLine}>{propertyLine}</p>
        <div className="qm-row__state">
          <span className={cls('qm-row__status', `is-${statusView.tone}`)}>{statusView.primary}</span>
          <span className={cls('qm-row__signal', `is-${signal.tone}`)}>{signal.text}</span>
        </div>
        {context && <p className="qm-row__context">{context}</p>}
      </div>
      {!selectionMode && (
        <span className="qm-row__chev" aria-hidden="true">
          <Icon name="chevron-right" size={15} />
        </span>
      )}
    </article>
  )
}
