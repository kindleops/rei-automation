import { Icon } from '../../../shared/icons'
import type { AcquisitionRecordType } from '../acquisition.types'
import { chipTypeClass, statusClass } from '../helpers'

export const ScoreBar = ({ value, tone = 'neutral' }: { value: number; tone?: 'good' | 'warn' | 'critical' | 'neutral' }) => (
  <div className={`acq-scorebar ${tone}`} aria-label={`Score ${Math.round(value)} percent`}>
    <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    <strong>{Math.round(value)}</strong>
  </div>
)

export const StatusPill = ({ value }: { value: string }) => (
  <span className={`acq-pill ${statusClass(value)}`}>{value}</span>
)

export const EmptyState = ({ title, detail }: { title: string; detail: string }) => (
  <div className="acq-empty-state">
    <Icon name="archive" />
    <h3>{title}</h3>
    <p>{detail}</p>
  </div>
)

export const RelationshipChip = ({
  label,
  type,
  id,
  onOpen,
}: {
  label: string
  type: AcquisitionRecordType
  id: string
  onOpen: (type: AcquisitionRecordType, id: string) => void
}) => (
  <button
    type="button"
    className={`acq-chip ${chipTypeClass(type)}`}
    onClick={() => onOpen(type, id)}
    title={`Open ${type}`}
  >
    <span className="acq-chip__dot" />
    <span className="acq-chip__type">{type.replace('_', ' ')}</span>
    <span className="acq-chip__label">{label}</span>
  </button>
)
