import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { emitNotification } from '../../shared/NotificationToast'
import { campaignLifecycle } from './campaigns.adapter'
import type { CampaignSummary } from './campaigns.types'
import { friendlyTimezone } from './campaign-launch-plan'

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
    if (new Date(iso).getTime() < Date.now() - 60_000) {
      emitNotification({ title: 'Schedule must be in the future', severity: 'warning' })
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
    <div className="ccm-glass-overlay" onClick={busy ? undefined : onClose}>
      <div className="ccm-glass-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ccm-glass-modal__header">
          <div className="ccm-glass-modal__icon">
            <Icon name="calendar" size={18} />
          </div>
          <div>
            <h3>{mode === 'reschedule' ? 'Reschedule campaign' : 'Schedule campaign'}</h3>
            <p>{campaign.campaign_name}</p>
          </div>
          <button type="button" className="ccm-glass-modal__close" onClick={onClose} disabled={busy} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="ccm-schedule-body">
          <label className="ccm-schedule-field">
            <span>First message</span>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </label>

          <label className="ccm-schedule-field">
            <span>Send by</span>
            <select
              value={timezoneMode}
              onChange={(e) => setTimezoneMode(e.target.value as 'operator' | 'recipient_local')}
            >
              {/* The old labels ("Absolute operator timezone (America/Chicago)")
                  were clipped mid-word in the select on a phone. */}
              <option value="operator">Your time ({friendlyTimezone(tz)})</option>
              <option value="recipient_local">Each seller&apos;s local time</option>
            </select>
          </label>

          <div className="ccm-schedule-summary">
            <div className="ccm-schedule-summary-item">
              <span>Sellers ready</span>
              <strong>{campaign.ready_targets.toLocaleString()}</strong>
            </div>
            <div className="ccm-schedule-summary-item">
              <span>Pace</span>
              <strong>One every {campaign.send_interval_seconds}s</strong>
            </div>
            {campaign.send_window_start ? (
              <div className="ccm-schedule-summary-item">
                <span>Texting hours</span>
                <strong>{campaign.send_window_start} – {campaign.send_window_end ?? '—'}</strong>
              </div>
            ) : (
              <div className="ccm-schedule-summary-item">
                <span>Daily cap</span>
                <strong>As set</strong>
              </div>
            )}
            <div className="ccm-schedule-summary-item">
              <span>Messages prepared</span>
              <strong>When it starts</strong>
            </div>
          </div>

          {campaign.ready_targets === 0 && (
            <div className="ccm-schedule-hint" style={{ borderColor: 'var(--warning)', color: 'var(--text-0)' }}>
              Nobody is ready to message yet — build the audience before scheduling.
            </div>
          )}

          <div className="ccm-schedule-hint">
            It sends at this campaign’s pace and daily cap, and only inside texting hours.
          </div>
        </div>

        <div className="ccm-glass-modal__footer">
          <button type="button" className="ccc-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="ccc-btn is-primary" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Saving…' : mode === 'reschedule' ? 'Confirm reschedule' : 'Confirm schedule'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}