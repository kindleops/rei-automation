/**
 * Three states, never two.
 *
 * Email Command previously held `EmailOverview | null` and `EmailRecord[]`,
 * which forced "still loading", "loaded and genuinely empty" and "the request
 * failed" into the same value — so a failure rendered as an empty dashboard.
 * §30 requires those to be distinguishable, and §44 lists "error shown as
 * empty" as a launch blocker.
 */
import type { EmailLoad } from './emailAdapter'

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; error: string }

export const LOADING = { status: 'loading' } as const

export function fromLoad<T>(result: EmailLoad<T>): LoadState<T> {
  return result.ok ? { status: 'ready', data: result.data } : { status: 'failed', error: result.error }
}

/** The value when ready, otherwise the caller's fallback. Never invents data. */
export function valueOr<T>(state: LoadState<T>, fallback: T): T {
  return state.status === 'ready' ? state.data : fallback
}

export function isFailed<T>(state: LoadState<T>): state is { status: 'failed'; error: string } {
  return state.status === 'failed'
}

/**
 * One sentence describing what the operator is looking at. Deliberately
 * distinguishes "no connected email account" and "provider unavailable" from
 * "there are no emails", which §30 lists separately.
 */
export function describeEmptyReason(input: {
  failed?: string | null
  providerConnected?: boolean | null
  providerMissing?: string[] | null
  hasSubstrate?: boolean
  noun?: string
}): string {
  const noun = input.noun ?? 'emails'
  if (input.failed) return `Couldn't load ${noun}: ${input.failed}`
  if (input.providerConnected === false) {
    const missing = (input.providerMissing ?? []).filter(Boolean)
    return missing.length
      ? `No connected email account — ${missing.join(' and ')} not configured, so no mail can be sent or received yet.`
      : 'No connected email account yet.'
  }
  if (input.hasSubstrate === false) return `No ${noun} have been sent or received yet.`
  return `No ${noun} match this view.`
}

/**
 * May the composer's Send control be enabled?
 *
 * §33 — a control that cannot succeed must not look like one. Brevo is
 * unconfigured in production (`connected: false`, `send_enabled: false`), and
 * the composer already says so in a banner, but the Send button was gated only
 * on the FORM. An operator could fill in a real seller address, press send,
 * wait out a round trip and get a red toast saying sending was disabled —
 * something the surface knew before the click.
 *
 * Provider capability is checked first and independently of form validity, so
 * "you cannot send at all" is never confused with "this draft isn't ready".
 */
export function canSendEmail(input: {
  providerConnected?: boolean | null
  providerSendEnabled?: boolean | null
  apiKeyValid?: boolean | null
  formReady: boolean
}): boolean {
  if (input.providerConnected !== true) return false
  if (input.apiKeyValid === false) return false
  if (input.providerSendEnabled !== true) return false
  return input.formReady === true
}
