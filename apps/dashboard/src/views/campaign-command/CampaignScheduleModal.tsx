import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { emitNotification } from '../../shared/NotificationToast'
import { campaignLifecycle } from './campaigns.adapter'
import type { CampaignSummary } from './campaigns.types'

interface CampaignScheduleModalProps {
  campaign: CampaignSummary
  mode: 'schedule' | 'reschedule'
  onClose: () => void
  onSuccess: () => void
}

const toLocalInput = (iso: string | null | undefined): string => {
  if (!iso) {
    const d = new Date(Date.now() + 3_600_000)
    const offset = d.getTimezoneOffset()
    return new Date(d.getTime() - offset * 60_000).toISOString().slice(0, 16)
  }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    const now = new Date(Date.now() + 3_600_000)
    const offset = now.getTimezoneOffset()
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 16)
  }
  const offset = d.getTimezoneOffset()
  return new Date(d.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

export const CampaignScheduleModal = ({
  campaign,
  mode,
  onClose,
  onSuccess,
}: CampaignScheduleModalProps) => {
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(campaign.next_send_at))
  const [timezoneMode, setTimezoneMode] = useState<'operator' | 'recipient_local'>('operator')
  const [busy, setBusy] = useState(false)

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const handleSubmit = async () => {
    if (!scheduledAt) {
      emitNotification({ title: 'Schedule time required', severity: 'warning' })
      return
    }
    const iso = new Date(scheduledAt).toISOString()
    if (Number.isNaN(new Date(iso).getTime())) {
      emitNotification({ title: 'Invalid schedule time', severity: 'warning' })
      return
    }
    try {
      setBusy(true)
      await campaignLifecycle(campaign.id, 'schedule', {
        scheduled_for: iso,
        first_scheduled_at: iso,
        timezone_mode: timezoneMode,
        operator_timezone: tz,
      })
      emitNotification({
        title: mode === 'reschedule' ? 'Campaign rescheduled' : 'Campaign scheduled',
        detail: `"${campaign.campaign_name}" first send ${new Date(iso).toLocaleString()}`,
        severity: 'success',
      })
      onSuccess()
      onClose()
    } catch (err) {
      emitNotification({
        title: 'Schedule failed',
        detail: err instanceof Error ? err.message : String(err),
        severity: 'critical',
      })
    } finally {
      setBusy(false)
    }
  }

  const modal = (
    <div className="cmp-modal-overlay" onClick={onClose}>
      <div className="cmp-schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-schedule-modal__header">
          <Icon name="calendar" size={16} />
          <div>
            <h3>{mode === 'reschedule' ? 'Reschedule Campaign' : 'Schedule Campaign'}</h3>
            <p>{campaign.campaign_name}</p>
          </div>
          <button type="button" className="cmp-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="cmp-schedule-modal__body">
          <label className="cmp-schedule-field">
            <span>First send (operator local time)</span>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </label>

          <label className="cmp-schedule-field">
            <span>Timezone semantics</span>
            <select
              value={timezoneMode}
              onChange={(e) => setTimezoneMode(e.target.value as 'operator' | 'recipient_local')}
            >
              <option value="operator">Absolute operator timezone ({tz})</option>
              <option value="recipient_local">Each recipient&apos;s local market time</option>
            </select>
          </label>

          <div className="cmp-schedule-hint">
            Pacing and daily cap from campaign configuration are preserved. Queue hydration occurs on activation.
          </div>
        </div>

        <div className="cmp-schedule-modal__footer">
          <button type="button" className="ccc-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="ccc-btn is-primary" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Saving…' : mode === 'reschedule' ? 'Reschedule' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}