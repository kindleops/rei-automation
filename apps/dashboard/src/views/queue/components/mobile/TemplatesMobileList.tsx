import { Icon } from '../../../../shared/icons'
import type { TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import { formatOptimizationState, formatRateDisplay } from '../../../../domain/templates/template-operator-labels'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const OPT_TONE: Record<string, string> = {
  'Performing well': 'green',
  'Gathering data': 'cyan',
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
  if (loading && rows.length === 0) return <div className="qm-empty">Loading templates…</div>
  if (rows.length === 0) return <div className="qm-empty">No templates match current filters.</div>

  return (
    <div className={cls('qm-tpl__list', loading && 'is-loading')}>
      {rows.map((row) => {
        const id = row.identity.template_id
        const name = row.identity.canonical_display_name || row.identity.template_name
        const stage = row.identity.stage_code ?? '—'
        const touch = row.identity.touch_number != null ? `Touch ${row.identity.touch_number}` : null
        const language = LANGUAGE_LABEL[row.identity.language] ?? row.identity.language
        const optState = formatOptimizationState(String((row.autopilot as Record<string, unknown> | null)?.rotation_state ?? ''))
        const optTone = OPT_TONE[optState] ?? 'muted'
        const preview = row.identity.canonical_body?.replace(/\s+/g, ' ').trim()
        const sends = Number((row.metrics.current as Record<string, unknown>).sends ?? 0)
        const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>
        const delivery = formatRateDisplay(rates.delivery?.current, sends)
        const reply = formatRateDisplay(rates.reply?.current, sends)

        return (
          <article
            key={id}
            className={cls('qm-tplrow', selectedId === id && 'is-open')}
            role="button"
            tabIndex={0}
            aria-pressed={selectedId === id}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } }}
          >
            <span className="qm-tplrow__accent" aria-hidden="true" />
            <div className="qm-tplrow__body">
              <div className="qm-tplrow__lead">
                <strong className="qm-tplrow__name">{name}</strong>
                <span className={cls('qm-tplrow__state', `is-${optTone}`)}>{optState}</span>
              </div>
              <p className="qm-tplrow__ident">
                {[stage, touch, language].filter(Boolean).join(' · ')}
              </p>
              {preview && <p className="qm-tplrow__preview">{preview}</p>}
              <p className="qm-tplrow__perf">
                {sends === 0 ? (
                  <span className="is-quiet">0 sends</span>
                ) : (
                  <>
                    <span>{sends.toLocaleString()} send{sends === 1 ? '' : 's'}</span>
                    {delivery.primary !== '—' && (<><em>·</em><span className="is-green">{delivery.primary} delivered</span></>)}
                    {reply.primary !== '—' && (<><em>·</em><span className="is-cyan">{reply.primary} reply</span></>)}
                  </>
                )}
              </p>
            </div>
            <Icon name="chevron-right" size={14} />
          </article>
        )
      })}
    </div>
  )
}
