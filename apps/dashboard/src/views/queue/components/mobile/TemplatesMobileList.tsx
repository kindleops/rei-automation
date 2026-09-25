import { Icon } from '../../../../shared/icons'
import type { TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import { formatOptimizationState, formatRateDisplay } from '../../../../domain/templates/template-operator-labels'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const OPT_TONE: Record<string, string> = {
  'Performing well': 'green',
  'Gathering data': 'blue',
  Testing: 'cyan',
  'Needs review': 'amber',
  Paused: 'amber',
  Retired: 'muted',
}

const LANGUAGE_LABEL: Record<string, string> = { en: 'English', es: 'Spanish' }

interface TemplatesMobileListProps {
  rows: TemplateIntelligenceRow[]
  loading?: boolean
  selectedId: string | null
  onSelect: (templateId: string) => void
}

/**
 * Template rows lead with the human name and the message. Internal template
 * IDs live in the dossier, not the list.
 */
export function TemplatesMobileList({ rows, loading, selectedId, onSelect }: TemplatesMobileListProps) {
  if (loading && rows.length === 0) {
    return (
      <div className="qx-list qx-tpl-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="qx-card is-skeleton" aria-hidden="true">
            <span className="qx-skel" style={{ width: '52%' }} />
            <span className="qx-skel" style={{ width: '30%' }} />
            <span className="qx-skel is-tall" style={{ width: '94%' }} />
          </div>
        ))}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="qx-empty">
        <Icon name="file-text" size={18} />
        <strong>No templates</strong>
        <span>Nothing matches the current filters.</span>
      </div>
    )
  }

  return (
    <div className={cls('qx-list', 'qx-tpl-list', loading && 'is-loading')}>
      {rows.map((row) => {
        const id = row.identity.template_id
        const name = row.identity.canonical_display_name || row.identity.template_name
        const stage = row.identity.stage_code ?? null
        const touch = row.identity.touch_number != null ? `Touch ${row.identity.touch_number}` : null
        const language = LANGUAGE_LABEL[row.identity.language] ?? row.identity.language
        const optState = formatOptimizationState(String((row.autopilot as Record<string, unknown> | null)?.rotation_state ?? ''))
        const optTone = OPT_TONE[optState] ?? 'muted'
        const preview = row.identity.canonical_body?.replace(/\s+/g, ' ').trim()
        const sends = Number((row.metrics.current as Record<string, unknown>).sends ?? 0)
        const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>
        const delivery = formatRateDisplay(rates.delivery?.current, sends)
        const reply = formatRateDisplay(rates.reply?.current, sends)
        const deliveryPct = typeof rates.delivery?.current?.value === 'number' ? Math.round(rates.delivery.current.value * (rates.delivery.current.value <= 1 ? 100 : 1)) : null

        return (
          <article
            key={id}
            className={cls('qx-card', `tone-${optTone}`, selectedId === id && 'is-open')}
            data-section-row
            role="button"
            tabIndex={0}
            aria-pressed={selectedId === id}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } }}
          >
            <div className="qx-card__top">
              <strong className="qx-card__name">{name}</strong>
              <span className={cls('qx-pill', `tone-${optTone}`)}>{optState}</span>
            </div>
            {(() => {
              // Only what the name doesn't already say.
              const lowerName = String(name ?? '').toLowerCase()
              const extra = [stage, touch, language].filter((p): p is string => Boolean(p) && !lowerName.includes(String(p).toLowerCase()))
              return extra.length ? <p className="qx-card__addr">{extra.join(' · ')}</p> : null
            })()}
            {preview && <p className="qx-card__msg"><span>{preview}</span></p>}
            <div className="qx-trio">
              <span><strong>{sends.toLocaleString()}</strong><em>sends</em></span>
              <span className="tone-green-soft"><strong>{delivery.primary}</strong><em>delivered</em></span>
              <span><strong>{reply.primary}</strong><em>reply</em></span>
            </div>
            {deliveryPct != null && sends > 0 && (
              <span className="qx-meter tone-green" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, deliveryPct))}%` }} /></span>
            )}
          </article>
        )
      })}
    </div>
  )
}
