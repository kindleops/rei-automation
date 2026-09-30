/**
 * A LOST SEND-NOW RESPONSE IS CONFIRMED, NOT REPORTED AS A FAILURE. Run:
 *   npx tsx --test src/domain/inbox/send-outcome-confirmation.test.ts
 *
 * Replays the 2026-09-30 14:51Z incident shape: the phone's fetch died with
 * WebKit's "Load failed" while the API went on to send and deliver the SMS.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIRM_WINDOW_MS,
  confirmSendOutcome,
  isIndeterminateSendFailure,
  verdictFromConfirmation,
  type SendStatusSnapshot,
} from './send-outcome-confirmation'

const CLIENT_SEND_ID = '15bab2b9-3fe0-462a-aa77-0a2a8bf10c3e'
const THREAD = '+16125550123'

/** The exact BackendResult callBackend produced on the phone that afternoon. */
const INCIDENT_RESULT = {
  ok: false,
  status: 502,
  error: 'BACKEND_NETWORK_ERROR',
  message: 'Network error calling /api/cockpit/inbox/send-now: Load failed',
}

function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    elapsed: () => t,
  }
}

function scripted(responses: Array<SendStatusSnapshot | Error | null>) {
  const calls: Array<[string, string]> = []
  let index = 0
  return {
    calls,
    fetchStatus: async (clientSendId: string, threadKey: string) => {
      calls.push([clientSendId, threadKey])
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (next instanceof Error) throw next
      return next
    },
  }
}

test('the incident shape is indeterminate; API refusals are not', () => {
  assert.equal(isIndeterminateSendFailure(INCIDENT_RESULT), true)
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 504, error: 'BACKEND_TIMEOUT' }), true)
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 524, error: 'BACKEND_HTML_ERROR', upstream: { html_preview: '<html>' } }), true)
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 502, error: 'Bad Gateway' }), true)

  // The API answered: its verdict stands.
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 423, error: 'compliance_blocked', upstream: { ok: false, reason: 'compliance_blocked' } }), false)
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 503, error: 'operator_action_not_durable', upstream: { ok: false, reason: 'operator_action_not_durable' } }), false)
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 500, error: 'send_now_failed', upstream: { ok: false, error: 'send_now_failed' } }), false)
  assert.equal(isIndeterminateSendFailure({ ok: false, status: 400, error: 'invalid_payload', upstream: { ok: false } }), false)
  assert.equal(isIndeterminateSendFailure({ ok: true, status: 200 }), false)
  assert.equal(isIndeterminateSendFailure(null), false)
})

test('incident replay: in flight, then sent -> reported as sent, not failed', async () => {
  const clock = fakeClock()
  const status = scripted([
    { ok: true, state: 'in_flight', terminal: false, queue_row_id: 'fc39b22b', queue_status: 'processing' },
    { ok: true, state: 'sent', terminal: true, queue_row_id: 'fc39b22b', queue_status: 'sent', provider_message_id: 'SMO7' },
  ])
  const outcome = await confirmSendOutcome({
    clientSendId: CLIENT_SEND_ID,
    threadKey: THREAD,
    fetchStatus: status.fetchStatus,
    now: clock.now,
    sleep: clock.sleep,
  })

  assert.equal(outcome.state, 'sent')
  assert.equal(outcome.confirmed, true)
  assert.equal(outcome.attempts, 2)
  assert.deepEqual(status.calls[0], [CLIENT_SEND_ID, THREAD])

  const verdict = verdictFromConfirmation(outcome)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.outcomeUnknown, false)
  assert.equal(verdict.deliveryStatus, 'sent')
  assert.equal(verdict.queueId, 'fc39b22b')
  assert.equal(verdict.providerMessageSid, 'SMO7')
})

test('unreachable and not-yet-written are retried until an answer arrives', async () => {
  const clock = fakeClock()
  const status = scripted([
    new Error('Load failed'),
    { ok: false },
    { ok: true, state: 'not_found', terminal: false },
    { ok: true, state: 'delivered', terminal: true, queue_row_id: 'q1', provider_message_id: 'SM1' },
  ])
  const outcome = await confirmSendOutcome({
    clientSendId: CLIENT_SEND_ID,
    threadKey: THREAD,
    fetchStatus: status.fetchStatus,
    now: clock.now,
    sleep: clock.sleep,
  })
  assert.equal(outcome.state, 'delivered')
  assert.equal(outcome.confirmed, true)
  assert.equal(outcome.attempts, 4)
})

test('a server-confirmed failure is reported as a failure (retry is legitimate)', async () => {
  const clock = fakeClock()
  const status = scripted([{ ok: true, state: 'failed', terminal: true, queue_row_id: 'q2', queue_status: 'failed', failed_reason: 'invalid_phone_number' }])
  const outcome = await confirmSendOutcome({ clientSendId: CLIENT_SEND_ID, threadKey: THREAD, fetchStatus: status.fetchStatus, now: clock.now, sleep: clock.sleep })
  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.attempts, 1)
  const verdict = verdictFromConfirmation(outcome)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.outcomeUnknown, false)
  assert.equal(verdict.deliveryStatus, 'failed')
  assert.match(verdict.message ?? '', /invalid phone number/)
})

test('never terminal inside the window -> "not confirmed", bounded, never "failed"', async () => {
  for (const [script, expected] of [
    [[{ ok: true, state: 'in_flight', terminal: false } as SendStatusSnapshot], 'in_flight'],
    [[{ ok: true, state: 'not_found', terminal: false } as SendStatusSnapshot], 'not_found'],
    [[new Error('Load failed')], 'unreachable'],
    [[{ ok: true, state: 'in_flight', terminal: false } as SendStatusSnapshot, new Error('offline')], 'in_flight'],
  ] as const) {
    const clock = fakeClock()
    const status = scripted([...script])
    const outcome = await confirmSendOutcome({
      clientSendId: CLIENT_SEND_ID,
      threadKey: THREAD,
      fetchStatus: status.fetchStatus,
      now: clock.now,
      sleep: clock.sleep,
    })
    assert.equal(outcome.state, expected)
    assert.equal(outcome.confirmed, false)
    assert.ok(clock.elapsed() <= DEFAULT_CONFIRM_WINDOW_MS, `stays inside the window (${clock.elapsed()}ms)`)
    assert.ok(outcome.attempts >= 5 && outcome.attempts <= 12, `bounded polling (${outcome.attempts})`)

    const verdict = verdictFromConfirmation(outcome)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.outcomeUnknown, true)
    assert.equal(verdict.deliveryStatus, 'unconfirmed', 'an unknown outcome is never painted as failed')
    assert.doesNotMatch(verdict.message ?? '', /failed/i)
  }
})
