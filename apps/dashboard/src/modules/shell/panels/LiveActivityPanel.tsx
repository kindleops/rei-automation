import { pushRoutePath } from '../../../app/router'
import { GLOBAL_COMMAND_ACTION_EVENT } from '../../../domain/command-center/command.types'
import { InboxActivityPanel } from '../../inbox/components/InboxActivityPanel'
import type { ShellPanelProps } from '../shell-panels'

/**
 * Shell slot adapter — `live-activity`, `surface: 'self'`.
 *
 * Lane A owns the rail trigger and the open/close state; this file only bridges
 * to the panel that already exists. The body is Lane F's to replace: switch the
 * slot to `surface: 'drawer'` in `shell-panels.ts` and return body content only.
 *
 * One behavioural change from the inbox-only version: the feed is no longer
 * silently scoped to the selected thread. Its own header reads "System heartbeat
 * across queue, inbox, AI, map, offers, buyers, and automation", which a
 * thread-scoped feed contradicted (§0.1, no untruthful labels). Thread-scoped
 * activity belongs beside the conversation, not in a global rail.
 */
export const LiveActivityPanel = ({ open, onClose, routePath }: ShellPanelProps) => {
  if (!open) return null

  return (
    <InboxActivityPanel
      onClose={onClose}
      onViewThread={(threadKey) => {
        const needsNavigation = routePath !== '/inbox'
        if (needsNavigation) pushRoutePath('/inbox')
        window.setTimeout(
          () => {
            window.dispatchEvent(
              new CustomEvent(GLOBAL_COMMAND_ACTION_EVENT, {
                detail: { kind: 'focus_thread_key', threadKey },
              }),
            )
          },
          needsNavigation ? 160 : 0,
        )
        onClose()
      }}
    />
  )
}

export default LiveActivityPanel
