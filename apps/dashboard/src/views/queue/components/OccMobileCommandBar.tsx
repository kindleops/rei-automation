import { Icon } from '../../../shared/icons'
import { QUEUE_DENSITY_ORDER, type QueueDensity } from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type DatePreset = 'today' | '24h' | '7d' | '14d' | '30d' | '60d' | '90d' | 'all' | 'custom'

const DATE_PRESETS: DatePreset[] = ['today', '24h', '7d', '14d', '30d', '60d', '90d', 'all']

const DATE_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  '24h': '24h',
  '7d': '7d',
  '14d': '14d',
  '30d': '30d',
  '60d': '60d',
  '90d': '90d',
  all: 'All',
  custom: 'Custom',
}

const DENSITY_HINT: Record<QueueDensity, string> = {
  comfortable: 'Full detail',
  compact: 'Fast scan',
  command: 'Telemetry',
}

interface FilterTab {
  key: string
  label: string
  count: number
  tone?: string
}

interface OccMobileCommandBarProps {
  datePreset: DatePreset
  dateBasisLabel: string
  onDatePreset: (preset: DatePreset) => void
  onOpenCustomDates?: () => void
  filterTabs: FilterTab[]
  statusFilter: string
  onStatusFilter: (key: string) => void
  density: QueueDensity
  onDensity: (d: QueueDensity) => void
  showDensity?: boolean
  showStatusTabs?: boolean
}

function DensityBars({ level }: { level: QueueDensity }) {
  const heights = level === 'comfortable' ? [6, 9, 12] : level === 'compact' ? [5, 8, 5] : [4, 4, 4]
  return (
    <span className="occ-mdensity-bars" aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className="occ-mdensity-bars__bar" style={{ height: h }} />
      ))}
    </span>
  )
}

export function OccMobileCommandBar({
  datePreset,
  dateBasisLabel,
  onDatePreset,
  onOpenCustomDates,
  filterTabs,
  statusFilter,
  onStatusFilter,
  density,
  onDensity,
  showDensity = true,
  showStatusTabs = true,
}: OccMobileCommandBarProps) {
  return (
    <div className="occ-mobile-command-bar occ-glass-rail">
      <div className="occ-mobile-command-bar__hero">
        <div>
          <span className="occ-mobile-command-bar__eyebrow">Operations queue</span>
          <span className="occ-mobile-command-bar__basis">{dateBasisLabel} basis</span>
        </div>
        {showDensity && (
          <div className="occ-mdensity" role="group" aria-label="Card density">
            {QUEUE_DENSITY_ORDER.map(d => (
              <button
                key={d}
                type="button"
                className={cls('occ-mdensity__btn', density === d && 'is-active')}
                onClick={() => onDensity(d)}
                title={DENSITY_HINT[d]}
                aria-pressed={density === d}
              >
                <DensityBars level={d} />
                <span className="occ-mdensity__lbl">
                  {d === 'comfortable' ? 'Comfort' : d === 'compact' ? 'Compact' : 'Command'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="occ-mobile-command-bar__section">
        <span className="occ-mobile-command-bar__label">
          <Icon name="calendar" size={11} />
          Time range
        </span>
        <div className="occ-mobile-command-bar__scroll occ-mobile-pill-rail">
          {DATE_PRESETS.map(p => (
            <button
              key={p}
              type="button"
              className={cls('occ-mpill', 'occ-mpill--date', datePreset === p && 'is-active')}
              onClick={() => onDatePreset(p)}
            >
              {DATE_LABELS[p]}
            </button>
          ))}
          <button
            type="button"
            className={cls('occ-mpill', 'occ-mpill--date', datePreset === 'custom' && 'is-active')}
            onClick={onOpenCustomDates}
          >
            <Icon name="filter" size={11} />
            Custom
          </button>
        </div>
      </div>

      {showStatusTabs && (
        <div className="occ-mobile-command-bar__section">
          <span className="occ-mobile-command-bar__label">
            <Icon name="filter" size={11} />
            Pipeline status
          </span>
          <div className="occ-mobile-command-bar__scroll occ-mobile-pill-rail">
            {filterTabs.map(t => (
              <button
                key={t.key}
                type="button"
                className={cls(
                  'occ-mpill',
                  'occ-mpill--status',
                  t.tone && t.count > 0 && `has-${t.tone}`,
                  statusFilter === t.key && 'is-active',
                )}
                onClick={() => onStatusFilter(t.key)}
              >
                <span>{t.label}</span>
                {t.count > 0 && <span className="occ-mpill__count">{t.count > 999 ? '999+' : t.count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}