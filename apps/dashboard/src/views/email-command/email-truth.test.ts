import { describe, expect, it } from 'vitest'
import {
  LOADING,
  describeEmptyReason,
  fromLoad,
  isFailed,
  valueOr,
  type LoadState, canSendEmail } from './email-load-state'
import {
  NO_SUBJECT,
  describeSubject,
  describeSubjectEmpty,
  hasSubject,
  resolveEmailSubject,
  sameSubject,
} from './email-subject'

/**
 * EMAIL-COMMAND-MOBILE-LOCK-1 §43.
 *
 * Every test here pins a defect that was actually found in production on
 * 2026-09-16, not a hypothetical.
 */

describe('an error is never rendered as an empty result', () => {
  /**
   * THE DEFECT. The adapter held MOCK_OVERVIEW — nine zeros with
   * brevo_status 'disconnected' — and returned it whenever a request failed.
   * The API separately answered HTTP 200 with its own nine zeros. So an
   * operator saw "0 emails, 0 eligible, 0 suppressed" over a 165,655-row
   * corpus, and nothing on screen distinguished that from a working empty
   * system. §44 lists "error shown as empty" as a launch blocker.
   */
  it('a failed load is a third state, not an empty one', () => {
    const failed = fromLoad({ ok: false, error: 'boom' })
    const empty = fromLoad({ ok: true, data: { records: [], count: 0 } })
    expect(failed.status).toBe('failed')
    expect(empty.status).toBe('ready')
    expect(new Set([LOADING.status, failed.status, empty.status]).size,
      'loading / failed / ready must be three distinct states').toBe(3)
  })

  it('never substitutes a fabricated value for a failure', () => {
    const failed: LoadState<number> = fromLoad({ ok: false, error: 'boom' })
    expect(isFailed(failed)).toBe(true)
    // valueOr yields the CALLER's fallback and the caller must render the
    // failure — it does not invent a zero that looks like data.
    expect(valueOr(failed, -1)).toBe(-1)
  })

  it('distinguishes no-account from no-messages from failed', () => {
    const failed = describeEmptyReason({ failed: 'timeout' })
    const noAccount = describeEmptyReason({ providerConnected: false, providerMissing: ['BREVO_API_KEY'] })
    const noMessages = describeEmptyReason({ providerConnected: true, hasSubstrate: false })
    expect(failed).toMatch(/couldn't load/i)
    expect(noAccount).toMatch(/no connected email account/i)
    expect(noAccount).toMatch(/BREVO_API_KEY/)
    expect(noMessages).toMatch(/sent or received/i)
    expect(new Set([failed, noAccount, noMessages]).size).toBe(3)
  })

  /** §31 — an unconfigured provider must never read as connected. */
  it('names what is missing rather than saying "not connected"', () => {
    const text = describeEmptyReason({
      providerConnected: false,
      providerMissing: ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'],
    })
    expect(text).toContain('BREVO_API_KEY')
    expect(text).toContain('BREVO_SENDER_EMAIL')
    expect(text).not.toMatch(/\bconnected\b(?!.*not)/i)
  })
})

describe('the email subject is exact, and A never leaks into B', () => {
  it('reads an explicit property_id from the URL', () => {
    const s = resolveEmailSubject('?property_id=237787391')
    expect(s.propertyId).toBe('237787391')
    expect(s.source).toBe('url')
    expect(hasSubject(s)).toBe(true)
  })

  it('treats a blank or malformed query as no subject', () => {
    for (const q of ['', '?', '?property_id=', '?property_id=%20%20', '?%%%']) {
      const s = resolveEmailSubject(q)
      expect(hasSubject(s), `"${q}" must not produce a subject`).toBe(false)
    }
  })

  /**
   * §6 — the specific failure to avoid: showing subject A because it has data
   * while B is selected. Two subjects are only the same when BOTH identifiers
   * agree, so a switch always re-queries.
   */
  it('two different properties are never treated as the same subject', () => {
    const a = resolveEmailSubject('?property_id=237787391')
    const b = resolveEmailSubject('?property_id=24563665')
    expect(sameSubject(a, b)).toBe(false)
    expect(sameSubject(a, a)).toBe(true)
  })

  it('does not equate "no subject" with any real subject', () => {
    const a = resolveEmailSubject('?property_id=237787391')
    expect(sameSubject(a, NO_SUBJECT)).toBe(false)
    expect(hasSubject(NO_SUBJECT)).toBe(false)
  })

  /**
   * A scoped view with nothing in it reports a fact about THAT subject. It
   * must not read as a system-wide "no records", which would invite falling
   * back to the whole corpus.
   */
  it('an empty scoped view blames the subject, not the system', () => {
    const scoped = describeSubjectEmpty(resolveEmailSubject('?property_id=237787391'))
    const unscoped = describeSubjectEmpty(NO_SUBJECT)
    expect(scoped).toMatch(/no email addresses are linked to/i)
    expect(scoped).toContain('237787391')
    expect(unscoped).not.toContain('237787391')
    expect(scoped).not.toBe(unscoped)
  })

  it('describes an unscoped view as the whole corpus', () => {
    expect(describeSubject(NO_SUBJECT)).toBe('All email records')
  })

  it('prefers a human address over an id when one is known', () => {
    const s = resolveEmailSubject('?property_id=237787391')
    expect(describeSubject(s, '600 Raintree Dr, Jonesboro, Ga 30238'))
      .toBe('600 Raintree Dr, Jonesboro, Ga 30238')
  })
})

/**
 * §33 — the composer must not offer a send it cannot perform.
 *
 * THE DEFECT (2026-09-20). Brevo is unconfigured in production —
 * `connected: false`, `send_enabled: false`, missing BREVO_API_KEY and
 * BREVO_SENDER_EMAIL — and the composer already rendered a banner saying so.
 * But `canSend` considered only the form, so "Send Email" stayed enabled. An
 * operator could type a real seller address, press send, wait out a round
 * trip, and receive a red toast stating sending was disabled: a fact the
 * surface held before the click.
 */
describe('the composer only offers a send that can happen', () => {
  const ready = { providerConnected: true, providerSendEnabled: true, apiKeyValid: true, formReady: true }

  it('allows the send when the provider is connected and the form is ready', () => {
    expect(canSendEmail(ready)).toBe(true)
  })

  it('refuses while Brevo is unconfigured, however complete the form is', () => {
    // The exact production shape today.
    expect(canSendEmail({ ...ready, providerConnected: false, providerSendEnabled: false })).toBe(false)
  })

  it('refuses when connected but sending is switched off', () => {
    // EMAIL_SEND_ENABLED=false with a valid key — connected is not permission.
    expect(canSendEmail({ ...ready, providerSendEnabled: false })).toBe(false)
  })

  it('refuses on an invalid api key even if the provider claims connected', () => {
    expect(canSendEmail({ ...ready, apiKeyValid: false })).toBe(false)
  })

  it('treats unknown provider state as not sendable, never as permission', () => {
    expect(canSendEmail({ formReady: true })).toBe(false)
    expect(canSendEmail({ ...ready, providerConnected: null, providerSendEnabled: null })).toBe(false)
  })

  it('separates "cannot send at all" from "this draft is not ready"', () => {
    // Provider fine, form incomplete — still false, but for the other reason.
    expect(canSendEmail({ ...ready, formReady: false })).toBe(false)
    expect(canSendEmail(ready)).toBe(true)
  })
})
