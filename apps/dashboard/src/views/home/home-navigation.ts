import { pushRoutePath } from '../../app/router'
import { setPropertyLocator } from '../../domain/locator/property-locator'
import { GLOBAL_COMMAND_OPEN_EVENT } from '../../domain/command-center/command.types'
import { requestNotificationsSurface } from '../../modules/mobile/shell-surface-bridge'
import type { FocusTarget, HomeThread } from './home-signals'

/**
 * Every jump off Home goes through here, so each one lands focused where the
 * destination can be focused, and plainly where it cannot.
 */

export const goTo = (path: string) => pushRoutePath(path)

/**
 * Opens one seller's conversation. The Inbox selects a thread from the property
 * locator on mount; a `?thread=` query string is not read by anything, so the
 * locator is the only deep link that actually lands on the thread.
 */
export const openThread = (thread: HomeThread) => {
  setPropertyLocator({
    threadKey: thread.threadKey,
    propertyId: thread.propertyId,
    prospectId: thread.prospectId,
    masterOwnerId: thread.masterOwnerId,
    address: thread.address,
  })
  pushRoutePath('/inbox')
}

export const openTarget = (target: FocusTarget) => {
  if (target.kind === 'thread') openThread(target.thread)
  else goTo(target.path)
}

export const openSearch = () => {
  window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_OPEN_EVENT, { detail: {} }))
}

export const openNotifications = () => requestNotificationsSurface()
