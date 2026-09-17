import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import {
  disablePush,
  enablePush,
  readPushStatus,
  type PushStatus,
} from '../../domain/notifications/push-subscription'

/**
 * THE PUSH ENABLE CONTROL.
 *
 * §5 is specific about the permission UX: do not throw the system prompt at the
 * operator with no context. So this renders an in-product row explaining what push
 * delivers, and `Notification.requestPermission()` is reached only through its
 * button. Mounting this component prompts nothing.
 *
 * The other half of §5 — "never fake a successful push state" — is why every branch
 * below shows a different thing. An unconfigured deployment, a blocked permission
 * and an iPhone that has not installed the PWA are three different facts and the
 * operator is told which one they are looking at.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export interface MobileNotificationPermissionProps {
  /**
   * `banner` — inside the notification centre. Collapses to nothing once push is
   *            live, because a permanent "notifications are on" strip above the
   *            feed is exactly the clutter §19 warns about.
   * `setting` — inside Settings. Always rendered, including the off switch, so the
   *            operator has somewhere to REVOKE a device rather than only enable one.
   */
  variant?: 'banner' | 'setting'
}

export const MobileNotificationPermission = ({ variant = 'banner' }: MobileNotificationPermissionProps) => {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let live = true
    void readPushStatus().then((next) => { if (live) setStatus(next) })
    return () => { live = false }
  }, [])

  const handleEnable = useCallback(async () => {
    setBusy(true)
    const next = await enablePush()
    setStatus(next)
    setBusy(false)
  }, [])

  const handleDisable = useCallback(async () => {
    setBusy(true)
    const next = await disablePush()
    setStatus(next)
    setBusy(false)
  }, [])

  if (!status) return null

  if (status.state === 'granted' && variant === 'banner') return null

  // `unsupported` is dismissible because there is no action the operator can take
  // and the message is not worth permanent screen space on every visit.
  if (status.state === 'unsupported' && variant === 'banner' && dismissed) return null

  const actionable = status.state === 'prompt'

  return (
    <div className={cls('nx-mnc__push', `is-${status.state}`)} role="note">
      <span className="nx-mnc__push-icon" aria-hidden>
        <Icon name={status.state === 'denied' ? 'alert' : 'bell'} size={15} strokeWidth={1.7} />
      </span>
      <div className="nx-mnc__push-copy">
        <strong>
          {status.state === 'granted' ? 'Push notifications are on'
            : status.state === 'prompt' ? 'Turn on push notifications'
              : status.state === 'denied' ? 'Notifications are blocked'
                : status.state === 'needs_install' ? 'Install to receive push'
                  : status.state === 'unconfigured' ? 'Push is not set up on this deployment'
                    : 'Push is unavailable on this browser'}
        </strong>
        <small>
          {status.detail
            ?? 'Critical and warning signals reach this device even when LeadCommand is closed.'}
        </small>
      </div>
      {status.state === 'granted' ? (
        <button type="button" className="nx-mnc__push-btn" disabled={busy} onClick={() => void handleDisable()}>
          {busy ? 'Turning off…' : 'Turn off'}
        </button>
      ) : actionable ? (
        <button type="button" className="nx-mnc__push-btn" disabled={busy} onClick={() => void handleEnable()}>
          {busy ? 'Enabling…' : 'Enable'}
        </button>
      ) : status.state === 'unsupported' && variant === 'banner' ? (
        <button type="button" className="nx-mnc__push-dismiss" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <Icon name="close" size={13} />
        </button>
      ) : null}
    </div>
  )
}
