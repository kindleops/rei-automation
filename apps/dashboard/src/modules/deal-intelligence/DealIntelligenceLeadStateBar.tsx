import { Icon, type IconName } from '../../shared/icons'
import {
  LIFECYCLE_STAGE_META,
  LEAD_TEMPERATURE_META,
  OPERATIONAL_STATUS_META,
} from '../../domain/lead-state/universal-lead-state-registry'
import {
  resolveLeadTemperatureForWrite,
  resolveLifecycleStageForWrite,
  resolveOperationalStatusForWrite,
} from '../../domain/lead-state/canonical-control-vocabularies'
import { focusCanonicalThreadControl } from '../inbox/canonical-thread-control-focus'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export interface DealIntelligenceLeadStateData {
  threadKey: string
  lifecycle_stage?: string | null
  operational_status?: string | null
  lead_temperature?: string | null
  is_starred?: boolean | null
  is_pinned?: boolean | null
  is_archived?: boolean | null
  is_read?: boolean | null
  snoozed_until?: string | null
  manual_stage_lock?: boolean | null
  manual_temperature_lock?: boolean | null
  automation_state?: string | null
  automation_status?: string | null
}

function readStage(data: DealIntelligenceLeadStateData) {
  const resolved = resolveLifecycleStageForWrite(data.lifecycle_stage)
  return resolved.ok
    ? { label: `${LIFECYCLE_STAGE_META[resolved.value].shortLabel} ${LIFECYCLE_STAGE_META[resolved.value].label}`, color: LIFECYCLE_STAGE_META[resolved.value].color }
    : { label: `Unsupported: ${data.lifecycle_stage || 'empty'}`, color: '#ff9f43' }
}

function readStatus(data: DealIntelligenceLeadStateData) {
  const resolved = resolveOperationalStatusForWrite(data.operational_status)
  return resolved.ok
    ? { label: OPERATIONAL_STATUS_META[resolved.value].label, color: OPERATIONAL_STATUS_META[resolved.value].color }
    : { label: `Unsupported: ${data.operational_status || 'empty'}`, color: '#ff9f43' }
}

function readTemperature(value: string | null | undefined) {
  const resolved = resolveLeadTemperatureForWrite(value)
  return resolved.ok
    ? { value: resolved.value, label: LEAD_TEMPERATURE_META[resolved.value].label, color: LEAD_TEMPERATURE_META[resolved.value].color }
    : { value: 'unsupported', label: `Unsupported: ${value || 'empty'}`, color: '#ff9f43' }
}

function MirrorButton({
  label,
  value,
  color,
  icon,
  onClick,
  disabled,
}: {
  label: string
  value: string
  color: string
  icon?: IconName
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="nx-di25-glass-btn is-card is-read-only-mirror"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
      onClick={onClick}
      disabled={disabled}
      title={`Read-only mirror. Edit ${label.toLowerCase()} in the conversation state bar.`}
      aria-label={`${label}: ${value}. Focus canonical conversation control.`}
    >
      <span className="nx-di25-glass-btn__accent" style={{ background: color }} aria-hidden="true" />
      <span className="nx-di25-glass-btn__card-body">
        <span className="nx-di25-glass-btn__card-head">
          <em>{label}</em>
          <Icon name={icon || 'arrow-up-right'} />
        </span>
        <span className="nx-di25-glass-btn__card-value">
          <span className="nx-conv-glass-btn__dot" style={{ background: color }} />
          <strong>{value}</strong>
        </span>
      </span>
    </button>
  )
}

export interface DealIntelligenceCommandRowProps {
  data: DealIntelligenceLeadStateData
  onPatched?: () => void
  disabled?: boolean
}

/**
 * Deal Intelligence is intentionally a read-only mirror. The conversation ThreadStateBar
 * is the sole Deal Desk operator writer for lifecycle and operational state.
 */
export function DealIntelligenceCommandRow({ data, disabled = false }: DealIntelligenceCommandRowProps) {
  const stage = readStage(data)
  const status = readStatus(data)
  return (
    <div className="nx-di25-pipeline-console" data-state-mirror="deal-intelligence">
      {data.manual_stage_lock ? (
        <div className="nx-di25-pipeline-console__lock" role="status">
          <Icon name="key" />
          <span>Manual stage lock active</span>
        </div>
      ) : null}
      <div className="nx-di25-lead-command" aria-label="Lead lifecycle read-only mirrors">
        <MirrorButton
          label="Stage"
          value={stage.label}
          color={stage.color}
          disabled={disabled}
          onClick={() => focusCanonicalThreadControl('lifecycle_stage')}
        />
        <span className="nx-di25-lead-command__bridge" aria-hidden="true"><Icon name="chevron-right" /></span>
        <MirrorButton
          label="Status"
          value={status.label}
          color={status.color}
          disabled={disabled}
          onClick={() => focusCanonicalThreadControl('operational_status')}
        />
      </div>
    </div>
  )
}

const HEADER_ICONS: Array<{ key: 'star' | 'pin' | 'archive' | 'read' | 'lock'; icon: IconName; title: string }> = [
  { key: 'star', icon: 'star', title: 'Star state mirror' },
  { key: 'pin', icon: 'pin', title: 'Pin state mirror' },
  { key: 'archive', icon: 'archive', title: 'Archive state mirror' },
  { key: 'read', icon: 'mail', title: 'Focus read control' },
  { key: 'lock', icon: 'key', title: 'Focus stage lock' },
]

export interface DealIntelligenceHeaderActionsProps {
  data: DealIntelligenceLeadStateData
  onPatched?: () => void
  disabled?: boolean
}

/** Header chips are mirrors only; they never own optimistic state or a mutation route. */
export function DealIntelligenceHeaderActions({ data, disabled = false }: DealIntelligenceHeaderActionsProps) {
  const activeMap: Record<string, boolean> = {
    star: Boolean(data.is_starred),
    pin: Boolean(data.is_pinned),
    archive: Boolean(data.is_archived),
    read: data.is_read === false,
    lock: Boolean(data.manual_stage_lock),
  }
  const focus = (key: typeof HEADER_ICONS[number]['key']) => {
    if (key === 'read') focusCanonicalThreadControl('is_read')
    else if (key === 'lock') focusCanonicalThreadControl('manual_stage_lock')
    else focusCanonicalThreadControl()
  }
  return (
    <div className="nx-di25-header-actions" data-state-mirror="deal-intelligence-header">
      {HEADER_ICONS.map(({ key, icon, title }) => (
        <button
          key={key}
          type="button"
          className={cls('nx-di25-header-action', activeMap[key] && 'is-active')}
          title={`${title} — edit in the conversation state bar`}
          aria-label={title}
          disabled={disabled}
          onClick={() => focus(key)}
        >
          <Icon name={icon} />
        </button>
      ))}
    </div>
  )
}

export interface DealIntelligenceTemperatureBadgeProps {
  threadKey: string
  temperature?: string | null
  manualTemperatureLock?: boolean | null
  onPatched?: () => void
  disabled?: boolean
}

/** Temperature remains visible here, but the only writer lives in ThreadStateBar. */
export function DealIntelligenceTemperatureBadge({
  temperature,
  manualTemperatureLock = false,
  disabled = false,
}: DealIntelligenceTemperatureBadgeProps) {
  const resolved = readTemperature(temperature)
  return (
    <div className="nx-di25-temp-badge-wrap" data-state-mirror="deal-intelligence-temperature">
      <button
        type="button"
        className={cls('nx-di25-temp-badge', `is-${resolved.value}`)}
        style={{
          color: resolved.color,
          borderColor: `color-mix(in srgb, ${resolved.color} 38%, transparent)`,
          background: `color-mix(in srgb, ${resolved.color} 14%, transparent)`,
        }}
        aria-label={`Lead temperature: ${resolved.label}. Focus canonical conversation control.`}
        title="Read-only mirror. Edit temperature in the conversation state bar."
        disabled={disabled}
        onClick={() => focusCanonicalThreadControl('lead_temperature')}
      >
        {manualTemperatureLock ? <Icon name="key" className="nx-di25-temp-badge__lock" /> : null}
        <span>{resolved.label}</span>
      </button>
    </div>
  )
}
