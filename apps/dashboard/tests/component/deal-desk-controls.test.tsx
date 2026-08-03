/**
 * N.2 — Deal Desk control wiring, exercised through the real components.
 *
 * These are integration tests, not unit tests: they mount the actual
 * `DealDeskControlsProvider` + `ThreadStateBar` + `DealIntelligenceCommandRow` and drive
 * them through real DOM events. Everything below the components is real too — the
 * canonical vocabularies, the mutation state machine, the automation persistence contract,
 * the payload builder and the response interpreter.
 *
 * ONE seam is stubbed: `patchLeadStateFromView`, the HTTP boundary. That lets a test
 * decide what the server answered (including *when*, for the rapid-write cases) while
 * still asserting on the exact request body the contract produced.
 *
 * Run with:
 *   npx tsx --test --experimental-test-module-mocks tests/component/deal-desk-controls.test.tsx
 */

import './dom-harness.ts'
import assert from 'node:assert/strict'
import test, { after, beforeEach, mock } from 'node:test'
import React from 'react'

// ── transport stub ───────────────────────────────────────────────────────────

interface PatchCall {
  sourceView: string
  threadKey: string
  patch: Record<string, unknown>
  meta: Record<string, unknown>
}

const calls: PatchCall[] = []
type Responder = (call: PatchCall) => Promise<unknown>

let respond: Responder = async () => ({ ok: true, data: { ok: true, row: {} } })

const persistModuleUrl = new URL(
  '../../src/domain/lead-state/persistUniversalLeadState.ts',
  import.meta.url,
).href

mock.module(persistModuleUrl, {
  namedExports: {
    patchLeadStateFromView: async (
      sourceView: string,
      threadKey: string,
      patch: Record<string, unknown>,
      meta: Record<string, unknown> = {},
    ) => {
      const call = { sourceView, threadKey, patch, meta }
      calls.push(call)
      return respond(call)
    },
    persistUniversalLeadState: async () => {
      throw new Error('persistUniversalLeadState must not be called by a canonical control')
    },
    archiveConversation: async () => ({ ok: true }),
    archiveLead: async () => ({ ok: true }),
    restoreLead: async () => ({ ok: true }),
    starThread: async () => ({ ok: true }),
    unstarThread: async () => ({ ok: true }),
    pinThread: async () => ({ ok: true }),
    unpinThread: async () => ({ ok: true }),
    snoozeThread: async () => ({ ok: true }),
    unsnoozeThread: async () => ({ ok: true }),
  },
})

const { render, screen, fireEvent, cleanup, act, within } = await import('@testing-library/react')
const { DealDeskControlsProvider } = await import('../../src/modules/inbox/DealDeskControlsProvider.tsx')
const { ThreadStateBar } = await import('../../src/modules/inbox/components/ThreadStateBar.tsx')
const { DealIntelligenceCommandRow } = await import(
  '../../src/modules/deal-intelligence/DealIntelligenceLeadStateBar.tsx'
)

// ── helpers ──────────────────────────────────────────────────────────────────

const okRow = (row: Record<string, unknown>) => ({ ok: true, data: { ok: true, row } })
const serverFailure = (code: string) => ({ ok: false, errorCode: code, errorMessage: 'raw diagnostic — must not be rendered' })
/** HTTP 200 with every field dropped by a guard — success-shaped, wrote nothing. */
const blocked = (reason: string) => ({ ok: true, data: { ok: true, blocked: true, reason } })

const baseThread = (overrides: Record<string, unknown> = {}) => ({
  id: 'row-1',
  threadKey: '+19015551234',
  canonical_e164: '+19015551234',
  lifecycle_stage: 'offer_interest',
  operational_status: 'new_reply',
  lead_temperature: 'cold',
  automation_state: 'running',
  is_read: false,
  ...overrides,
})

const mount = (thread: Record<string, unknown>, extra?: React.ReactNode) =>
  render(
    <DealDeskControlsProvider thread={thread}>
      <ThreadStateBar thread={thread as never} />
      {extra}
    </DealDeskControlsProvider>,
  )

/** Open a control's dropdown and click one option by its visible label. */
const choose = async (testId: string, optionLabel: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
  const listbox = document.body.querySelector('.nx-conv-dropdown-portal')
  assert.ok(listbox, `no dropdown opened for ${testId}`)
  const option = within(listbox as HTMLElement).getByRole('option', { name: optionLabel })
  await act(async () => {
    fireEvent.click(option)
  })
}

/** Which options a control offers. */
const optionsOf = async (testId: string): Promise<string[]> => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
  const listbox = document.body.querySelector('.nx-conv-dropdown-portal')
  assert.ok(listbox)
  return within(listbox as HTMLElement).getAllByRole('option').map((el) => el.textContent?.replace('✓', '').trim() ?? '')
}

const control = (testId: string) => screen.getByTestId(testId)
const valueOf = (testId: string) => control(testId).getAttribute('data-value')
const isPending = (testId: string) => control(testId).getAttribute('data-pending') === 'true'
const errorOf = (testId: string) => screen.queryByTestId(`${testId}-error`)?.textContent ?? null

/** A deferred promise, so a test can hold a response open and control ordering. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  calls.length = 0
  respond = async () => okRow({})
  cleanup()
})

after(() => cleanup())

// ── stage ────────────────────────────────────────────────────────────────────

test('stage: a successful change persists the canonical value and adopts the server row', async () => {
  respond = async () => okRow({ lifecycle_stage: 'asking_price' })
  mount(baseThread())

  await choose('control-lifecycle-stage', /Asking Price/i)
  // The confirm modal gates the write; nothing has been sent yet.
  assert.equal(calls.length, 0)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change stage only/i }))
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].patch, { lifecycle_stage: 'asking_price' })
  assert.equal(calls[0].threadKey, '+19015551234')
  assert.equal(valueOf('control-lifecycle-stage'), 'asking_price')
  assert.equal(errorOf('control-lifecycle-stage'), null)
})

test('stage: a server refusal rolls the control back and shows a localised reason', async () => {
  respond = async () => serverFailure('manual_stage_lock_blocked_stage_write')
  mount(baseThread())

  await choose('control-lifecycle-stage', /Asking Price/i)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change stage only/i }))
  })

  assert.equal(valueOf('control-lifecycle-stage'), 'offer_interest', 'rolled back to the authoritative value')
  const message = errorOf('control-lifecycle-stage')
  assert.match(message ?? '', /manual stage lock/i)
  // The transport's own diagnostic embeds the request URL — and the thread key in that
  // URL is the seller's phone number. It must never reach the operator.
  assert.doesNotMatch(message ?? '', /raw diagnostic|http|\+1901/i)
})

test('stage: a 200-with-blocked response is a failure, not a success', async () => {
  respond = async () => blocked('manual_stage_lock_blocked_stage_write')
  mount(baseThread())

  await choose('control-lifecycle-stage', /Asking Price/i)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change stage only/i }))
  })

  assert.equal(valueOf('control-lifecycle-stage'), 'offer_interest')
  assert.match(errorOf('control-lifecycle-stage') ?? '', /manual stage lock/i)
})

test('stage: mf_suppressed is displayed verbatim and never becomes S1 Ownership Check', async () => {
  mount(baseThread({ lifecycle_stage: 'mf_suppressed' }))

  const rendered = control('control-lifecycle-stage')
  assert.equal(rendered.getAttribute('data-value'), 'mf_suppressed')
  assert.match(rendered.textContent ?? '', /Unsupported: mf_suppressed/)
  assert.doesNotMatch(rendered.textContent ?? '', /Ownership/i)
})

test('stage: the authoritative response wins over the requested value', async () => {
  // The server coerced the write (a guard, a concurrent change). The control must show
  // what was persisted, not what was asked for.
  respond = async () => okRow({ lifecycle_stage: 'ownership_confirmation' })
  mount(baseThread())

  await choose('control-lifecycle-stage', /Formal Contract/i)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change stage only/i }))
  })

  assert.equal(valueOf('control-lifecycle-stage'), 'ownership_confirmation')
})

test('stage: a row that omits the field is not a confirmation', async () => {
  respond = async () => okRow({ operational_status: 'new_reply' })
  mount(baseThread())

  await choose('control-lifecycle-stage', /Asking Price/i)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change stage only/i }))
  })

  assert.equal(valueOf('control-lifecycle-stage'), 'offer_interest')
  assert.match(errorOf('control-lifecycle-stage') ?? '', /did not confirm/i)
})

test('stage: the manual stage lock is surfaced from the row, not inferred from automation', async () => {
  mount(baseThread({ manual_stage_lock: true, automation_state: 'running' }))
  assert.ok(screen.queryByTestId('manual-stage-lock'), 'lock indicator shown when the row says so')

  cleanup()
  mount(baseThread({ manual_stage_lock: false, automation_state: 'manual' }))
  assert.equal(
    screen.queryByTestId('manual-stage-lock'),
    null,
    'manual automation alone does not imply a stage lock',
  )
})

// ── operational status ───────────────────────────────────────────────────────

test('status: a successful change writes only the status field', async () => {
  respond = async () => okRow({ operational_status: 'waiting_on_seller' })
  mount(baseThread())

  await choose('control-operational-status', /Waiting/i)

  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0].patch), ['operational_status'],
    'a status change must not carry stage, bucket, suppression or automation')
  assert.equal(valueOf('control-operational-status'), 'waiting_on_seller')
})

test('status: a failure rolls back to the authoritative value', async () => {
  respond = async () => serverFailure('server_error')
  mount(baseThread())

  await choose('control-operational-status', /Waiting/i)

  assert.equal(valueOf('control-operational-status'), 'new_reply')
  // The dismiss affordance contributes a "×" to textContent, hence a match not an equal.
  assert.match(errorOf('control-operational-status') ?? '', /^The change could not be saved\./)
  assert.doesNotMatch(errorOf('control-operational-status') ?? '', /raw diagnostic/)
})

test('status: suppression and delivery values are not offered as statuses', async () => {
  mount(baseThread())
  const labels = await optionsOf('control-operational-status')
  const joined = labels.join('|').toLowerCase()
  assert.doesNotMatch(joined, /suppress/)
  assert.doesNotMatch(joined, /delivered|undelivered|bounced/)
  assert.doesNotMatch(joined, /dead|closed/)
})

test('status: a stored suppression value is shown as unsupported, not as a status', async () => {
  mount(baseThread({ operational_status: 'suppressed' }))
  const rendered = control('control-operational-status')
  assert.equal(rendered.getAttribute('data-value'), 'suppressed')
  assert.match(rendered.textContent ?? '', /Unsupported: suppressed/)
})

// ── lead temperature ─────────────────────────────────────────────────────────

test('temperature: a successful change reconciles from the server row', async () => {
  respond = async () => okRow({ lead_temperature: 'hot' })
  mount(baseThread())

  await choose('control-lead-temperature', /Hot/i)

  assert.deepEqual(calls[0].patch, { lead_temperature: 'hot' })
  assert.equal(valueOf('control-lead-temperature'), 'hot')
})

test('temperature: a failure rolls back', async () => {
  respond = async () => serverFailure('server_error')
  mount(baseThread())

  await choose('control-lead-temperature', /Warm/i)

  assert.equal(valueOf('control-lead-temperature'), 'cold')
})

test('temperature: cold → warm → hot in flight — the last choice wins and older responses are refused', async () => {
  const gates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()]
  let index = 0
  respond = () => gates[index++]!.promise

  mount(baseThread({ lead_temperature: 'unscored' }))

  await choose('control-lead-temperature', /Cold/i)
  await choose('control-lead-temperature', /Warm/i)
  await choose('control-lead-temperature', /Hot/i)

  assert.equal(calls.length, 3)
  assert.equal(valueOf('control-lead-temperature'), 'hot', 'the operator sees their latest choice while in flight')

  // Answer out of order: the newest first, then the two stale ones.
  await act(async () => { gates[2]!.resolve(okRow({ lead_temperature: 'hot' })) })
  await flush()
  assert.equal(valueOf('control-lead-temperature'), 'hot')

  await act(async () => { gates[0]!.resolve(okRow({ lead_temperature: 'cold' })) })
  await act(async () => { gates[1]!.resolve(okRow({ lead_temperature: 'warm' })) })
  await flush()

  assert.equal(valueOf('control-lead-temperature'), 'hot', 'a stale response cannot overwrite the newest choice')
  assert.equal(errorOf('control-lead-temperature'), null, 'a superseded response is silent, not an error')
})

test('temperature: a stale FAILURE cannot roll back a newer successful write', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let index = 0
  respond = () => (index++ === 0 ? first.promise : second.promise)

  mount(baseThread({ lead_temperature: 'unscored' }))
  await choose('control-lead-temperature', /Cold/i)
  await choose('control-lead-temperature', /Hot/i)

  await act(async () => { second.resolve(okRow({ lead_temperature: 'hot' })) })
  await flush()
  await act(async () => { first.resolve(serverFailure('server_error')) })
  await flush()

  assert.equal(valueOf('control-lead-temperature'), 'hot')
  assert.equal(errorOf('control-lead-temperature'), null)
})

// ── automation mode ──────────────────────────────────────────────────────────

test('automation: `running` reads back as Autopilot On through the autopilot_mode alias', async () => {
  mount(baseThread({ automation_state: 'running' }))
  assert.equal(valueOf('control-automation-mode'), 'active')
  assert.match(control('control-automation-mode').textContent ?? '', /Autopilot On/i)
})

test('automation: an empty automation_state reads as active, matching the backend default', async () => {
  mount(baseThread({ automation_state: '' }))
  assert.equal(valueOf('control-automation-mode'), 'active')
})

test('automation: pausing writes automation_state, never automation_status', async () => {
  respond = async () => okRow({ automation_state: 'paused' })
  mount(baseThread())

  await choose('control-automation-mode', /Paused/i)

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].patch, { automation_state: 'paused' })
  assert.ok(!('automation_status' in calls[0].patch), 'automation_status is the queue dimension')
  assert.ok(!('autopilot_mode' in calls[0].patch), 'autopilot_mode is a view alias, not a column')
  assert.equal(valueOf('control-automation-mode'), 'paused')
})

test('automation: resuming serialises `active` to the persisted value `running`', async () => {
  respond = async () => okRow({ automation_state: 'running' })
  mount(baseThread({ automation_state: 'paused' }))

  await choose('control-automation-mode', /Autopilot On/i)

  assert.deepEqual(calls[0].patch, { automation_state: 'running' })
  assert.equal(valueOf('control-automation-mode'), 'active')
})

test('automation: human control writes `manual` and sets the manual stage lock', async () => {
  respond = async () => okRow({ automation_state: 'manual', manual_stage_lock: true })
  mount(baseThread())

  await choose('control-automation-mode', /Manual Only/i)

  assert.deepEqual(calls[0].patch, { automation_state: 'manual', manual_stage_lock: true })
  assert.equal(calls[0].meta.manual_stage_lock, true)
  assert.equal(valueOf('control-automation-mode'), 'human_controlled')
})

test('automation: system-only modes are not offered to an operator', async () => {
  mount(baseThread())
  const labels = await optionsOf('control-automation-mode')
  assert.deepEqual(labels, ['Autopilot On', 'Paused', 'Manual Only'])
  const joined = labels.join('|').toLowerCase()
  assert.doesNotMatch(joined, /review required/)
  assert.doesNotMatch(joined, /disabled/)
  assert.doesNotMatch(joined, /completed/)
})

test('automation: resuming a suppressed record is refused locally with no request emitted', async () => {
  mount(baseThread({ automation_state: 'paused', is_suppressed: true }))

  await choose('control-automation-mode', /Autopilot On/i)

  assert.equal(calls.length, 0, 'no doomed request')
  assert.equal(valueOf('control-automation-mode'), 'paused', 'the prior mode is restored')
  assert.match(errorOf('control-automation-mode') ?? '', /suppressed/i)
})

test('automation: resuming an opted-out record is refused', async () => {
  mount(baseThread({ automation_state: 'paused', contactability_status: 'opted_out' }))
  await choose('control-automation-mode', /Autopilot On/i)
  assert.equal(calls.length, 0)
  assert.match(errorOf('control-automation-mode') ?? '', /suppressed/i)
})

test('automation: resuming a terminal (closed) record is refused', async () => {
  mount(baseThread({ automation_state: 'paused', lifecycle_stage: 'closed' }))

  await choose('control-automation-mode', /Autopilot On/i)

  assert.equal(calls.length, 0)
  assert.equal(valueOf('control-automation-mode'), 'paused')
  assert.match(errorOf('control-automation-mode') ?? '', /closed/i)
})

test('automation: resuming a terminally-dispositioned record is refused', async () => {
  mount(baseThread({ automation_state: 'paused', disposition: 'not_interested' }))
  await choose('control-automation-mode', /Autopilot On/i)
  assert.equal(calls.length, 0)
  assert.match(errorOf('control-automation-mode') ?? '', /terminal disposition/i)
})

test('automation: PAUSING a suppressed record is still allowed — the guard only blocks resume', async () => {
  respond = async () => okRow({ automation_state: 'paused' })
  mount(baseThread({ automation_state: 'running', is_suppressed: true }))

  await choose('control-automation-mode', /Paused/i)

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].patch, { automation_state: 'paused' })
})

test('automation: a failed mode change restores the prior mode', async () => {
  respond = async () => serverFailure('server_error')
  mount(baseThread({ automation_state: 'running' }))

  await choose('control-automation-mode', /Paused/i)

  assert.equal(valueOf('control-automation-mode'), 'active')
})

test('automation: queue status is displayed separately and is never written', async () => {
  respond = async () => okRow({ automation_state: 'paused' })
  mount(baseThread({ automation_status: 'manual_review' }))

  assert.equal(screen.getByTestId('queue-status').textContent, 'manual review')
  await choose('control-automation-mode', /Paused/i)
  assert.ok(!('automation_status' in calls[0].patch))
})

test('automation: a row whose automation_state is unrecognised is shown verbatim', async () => {
  mount(baseThread({ automation_state: 'quantum' }))
  const rendered = control('control-automation-mode')
  assert.equal(rendered.getAttribute('data-value'), 'quantum')
  assert.match(rendered.textContent ?? '', /Unsupported: quantum/)
})

// ── read / unread ────────────────────────────────────────────────────────────

const readToggle = () => screen.getByTestId('control-read-state')

test('read: marking read persists and reconciles from the server row', async () => {
  respond = async () => okRow({ is_read: true })
  mount(baseThread({ is_read: false }))

  assert.equal(readToggle().getAttribute('data-value'), 'unread')
  await act(async () => { fireEvent.click(readToggle()) })

  assert.deepEqual(calls[0].patch, { is_read: true })
  assert.equal(readToggle().getAttribute('data-value'), 'read')
})

test('read: marking unread persists', async () => {
  respond = async () => okRow({ is_read: false })
  mount(baseThread({ is_read: true }))

  await act(async () => { fireEvent.click(readToggle()) })

  assert.deepEqual(calls[0].patch, { is_read: false })
  assert.equal(readToggle().getAttribute('data-value'), 'unread')
})

test('read: a failure restores the previous state', async () => {
  respond = async () => serverFailure('server_error')
  mount(baseThread({ is_read: false }))

  await act(async () => { fireEvent.click(readToggle()) })

  assert.equal(readToggle().getAttribute('data-value'), 'unread')
  assert.ok(screen.queryByTestId('control-read-state-error'))
})

test('read: a row that omits is_read is not a confirmation', async () => {
  respond = async () => okRow({ lifecycle_stage: 'offer_interest' })
  mount(baseThread({ is_read: false }))

  await act(async () => { fireEvent.click(readToggle()) })

  assert.equal(readToggle().getAttribute('data-value'), 'unread')
  assert.match(screen.getByTestId('control-read-state-error').textContent ?? '', /did not confirm/i)
})

// ── unsupported thread ───────────────────────────────────────────────────────

test('unsupported thread: no request is emitted and the localised message is shown', async () => {
  // A UUID row identity with no dialable phone — the server guard is /^\+1\d{10}$/, so any
  // write would be rejected. It is refused locally instead (DD-003).
  mount({
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    threadKey: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    lifecycle_stage: 'offer_interest',
    operational_status: 'new_reply',
    lead_temperature: 'cold',
    automation_state: 'running',
    is_read: false,
  })

  assert.ok(screen.queryByTestId('thread-state-unsupported'), 'the unsupported banner is shown')
  const toggle = readToggle()
  assert.equal(toggle.hasAttribute('disabled'), true)

  await act(async () => { fireEvent.click(toggle) })
  assert.equal(calls.length, 0, 'no invalid request emitted')
  assert.equal(toggle.getAttribute('data-value'), 'unread', 'not silently marked read')
})

test('unsupported thread: telemetry carries a masked phone and no seller data', async () => {
  const events: Array<{ event: string; field: string; reason: string; thread: string }> = []
  render(
    <DealDeskControlsProvider
      thread={baseThread({ canonical_e164: null, threadKey: 'row-only', id: 'row-only' })}
      onTelemetry={(e) => events.push(e)}
    >
      <ThreadStateBar thread={baseThread({ canonical_e164: null, threadKey: 'row-only', id: 'row-only' }) as never} />
    </DealDeskControlsProvider>,
  )

  await act(async () => { fireEvent.click(readToggle()) })

  // The refusal happens before `persist`, so no telemetry is emitted from the writer;
  // what matters is that nothing was sent and nothing leaked.
  assert.equal(calls.length, 0)
  for (const event of events) {
    assert.doesNotMatch(event.thread, /\+1\d{10}/, 'a full phone number must never reach telemetry')
  }
})

// ── reconciliation ───────────────────────────────────────────────────────────

test('polling: a background refresh cannot overwrite a pending operator write', async () => {
  const gate = deferred<unknown>()
  respond = () => gate.promise

  const thread = baseThread({ lead_temperature: 'cold' })
  const view = render(
    <DealDeskControlsProvider thread={thread}>
      <ThreadStateBar thread={thread as never} />
    </DealDeskControlsProvider>,
  )

  await choose('control-lead-temperature', /Hot/i)
  assert.equal(isPending('control-lead-temperature'), true)

  // A poll lands mid-flight carrying the OLD value.
  const polled = baseThread({ lead_temperature: 'cold' })
  await act(async () => {
    view.rerender(
      <DealDeskControlsProvider thread={polled}>
        <ThreadStateBar thread={polled as never} />
      </DealDeskControlsProvider>,
    )
  })
  assert.equal(valueOf('control-lead-temperature'), 'hot', 'the pending operator value survives the poll')

  await act(async () => { gate.resolve(okRow({ lead_temperature: 'hot' })) })
  await flush()
  assert.equal(valueOf('control-lead-temperature'), 'hot')
})

test('realtime: an external change is adopted once nothing is pending', async () => {
  const thread = baseThread({ lead_temperature: 'cold' })
  const view = render(
    <DealDeskControlsProvider thread={thread}>
      <ThreadStateBar thread={thread as never} />
    </DealDeskControlsProvider>,
  )
  assert.equal(valueOf('control-lead-temperature'), 'cold')

  const patched = baseThread({ lead_temperature: 'warm' })
  await act(async () => {
    view.rerender(
      <DealDeskControlsProvider thread={patched}>
        <ThreadStateBar thread={patched as never} />
      </DealDeskControlsProvider>,
    )
  })
  assert.equal(valueOf('control-lead-temperature'), 'warm')
})

test('thread switch: a response for the previous conversation cannot commit against the new one', async () => {
  const gate = deferred<unknown>()
  respond = () => gate.promise

  const first = baseThread({ lead_temperature: 'cold' })
  const view = render(
    <DealDeskControlsProvider thread={first}>
      <ThreadStateBar thread={first as never} />
    </DealDeskControlsProvider>,
  )

  await choose('control-lead-temperature', /Hot/i)
  assert.equal(calls[0].threadKey, '+19015551234', 'the write named the thread it started on')

  const second = baseThread({
    id: 'row-2',
    threadKey: '+19015559999',
    canonical_e164: '+19015559999',
    lead_temperature: 'unscored',
  })
  await act(async () => {
    view.rerender(
      <DealDeskControlsProvider thread={second}>
        <ThreadStateBar thread={second as never} />
      </DealDeskControlsProvider>,
    )
  })
  assert.equal(valueOf('control-lead-temperature'), 'unscored', 'the new thread shows its own value')

  await act(async () => { gate.resolve(okRow({ lead_temperature: 'hot' })) })
  await flush()

  assert.equal(
    valueOf('control-lead-temperature'),
    'unscored',
    'the previous conversation\'s response must not land on this one',
  )
  assert.equal(calls.length, 1, 'and no second request was made')
})

test('a failure after a success rolls back to the CONFIRMED value, not the stale row', async () => {
  // The thread row still says `cold` (the caller has not refetched). After a confirmed
  // write to `hot`, a later failed write must restore `hot` — the value the server
  // actually holds — not the pre-success row value.
  respond = async () => okRow({ lead_temperature: 'hot' })
  mount(baseThread({ lead_temperature: 'cold' }))
  await choose('control-lead-temperature', /Hot/i)
  assert.equal(valueOf('control-lead-temperature'), 'hot')

  respond = async () => serverFailure('server_error')
  await choose('control-lead-temperature', /Warm/i)

  assert.equal(valueOf('control-lead-temperature'), 'hot', 'a rollback undoes the failed write, not the successful one')
  assert.match(errorOf('control-lead-temperature') ?? '', /could not be saved/i)
})

test('the rollback target retires once the authoritative row catches up', async () => {
  respond = async () => okRow({ lead_temperature: 'hot' })
  const thread = baseThread({ lead_temperature: 'cold' })
  const view = render(
    <DealDeskControlsProvider thread={thread}>
      <ThreadStateBar thread={thread as never} />
    </DealDeskControlsProvider>,
  )
  await choose('control-lead-temperature', /Hot/i)
  respond = async () => serverFailure('server_error')
  await choose('control-lead-temperature', /Warm/i)
  assert.equal(valueOf('control-lead-temperature'), 'hot')

  // The caller refetches and the row now agrees — the rollback target retires.
  const caughtUp = baseThread({ lead_temperature: 'hot' })
  await act(async () => {
    view.rerender(
      <DealDeskControlsProvider thread={caughtUp}>
        <ThreadStateBar thread={caughtUp as never} />
      </DealDeskControlsProvider>,
    )
  })
  assert.equal(valueOf('control-lead-temperature'), 'hot')

  // A later external change must now show through rather than be masked by it.
  const external = baseThread({ lead_temperature: 'unscored' })
  await act(async () => {
    view.rerender(
      <DealDeskControlsProvider thread={external}>
        <ThreadStateBar thread={external as never} />
      </DealDeskControlsProvider>,
    )
  })
  assert.equal(valueOf('control-lead-temperature'), 'unscored',
    'a retired rollback target cannot mask a later server-side change')
})

// ── dropdown interaction ─────────────────────────────────────────────────────

test('an option survives a real mousedown → mouseup → click sequence', async () => {
  // Regression: the outside-click handler listened on `mousedown` and closed the menu for
  // any target outside the trigger button. The menu is a PORTAL into document.body, so an
  // option is outside the button — mousedown unmounted the option before its click could
  // fire, and every dropdown value was unselectable with a real mouse. `fireEvent.click`
  // alone dispatches no mousedown, which is why only the browser run caught it first.
  respond = async () => okRow({ lead_temperature: 'hot' })
  mount(baseThread({ lead_temperature: 'cold' }))

  await act(async () => { fireEvent.click(screen.getByTestId('control-lead-temperature')) })
  const listbox = document.body.querySelector('.nx-conv-dropdown-portal')
  assert.ok(listbox, 'menu opened')
  const option = within(listbox as HTMLElement).getByRole('option', { name: /Hot/i })

  await act(async () => {
    fireEvent.mouseDown(option)
  })
  assert.ok(
    document.body.querySelector('.nx-conv-dropdown-portal'),
    'mousedown on an option must not unmount the menu',
  )
  await act(async () => {
    fireEvent.mouseUp(option)
    fireEvent.click(option)
  })

  assert.equal(calls.length, 1, 'the option click reached the handler')
  assert.equal(valueOf('control-lead-temperature'), 'hot')
})

test('a mousedown outside both the trigger and the menu still closes it', async () => {
  mount(baseThread())
  await act(async () => { fireEvent.click(screen.getByTestId('control-lead-temperature')) })
  assert.ok(document.body.querySelector('.nx-conv-dropdown-portal'))

  await act(async () => { fireEvent.mouseDown(document.body) })
  assert.equal(document.body.querySelector('.nx-conv-dropdown-portal'), null)
  assert.equal(calls.length, 0)
})

// ── shared ownership ─────────────────────────────────────────────────────────

test('Deal Intelligence shares the canonical owner and holds no independent mutation path', async () => {
  respond = async () => okRow({ operational_status: 'waiting_on_seller' })
  const thread = baseThread()

  render(
    <DealDeskControlsProvider thread={thread}>
      <ThreadStateBar thread={thread as never} />
      <DealIntelligenceCommandRow data={{ threadKey: '+19015551234' }} />
    </DealDeskControlsProvider>,
  )

  // Change the status from the state bar; Deal Intelligence must follow without a second
  // request, because it renders the same handle rather than its own optimistic copy.
  await choose('control-operational-status', /Waiting/i)

  assert.equal(calls.length, 1, 'exactly one request for one operator action')
  const diStatus = document.querySelector('.nx-di25-ctrl--status .nx-di25-glass-btn__card-value strong')
  assert.match(diStatus?.textContent ?? '', /Waiting/i)
})

test('Deal Intelligence renders nothing when the provider names a different conversation', async () => {
  const thread = baseThread()
  render(
    <DealDeskControlsProvider thread={thread}>
      <DealIntelligenceCommandRow data={{ threadKey: '+19015550000' }} />
    </DealDeskControlsProvider>,
  )
  assert.equal(document.querySelector('.nx-di25-lead-command'), null)
  assert.equal(calls.length, 0)
})

test('Deal Intelligence writing a stage uses the same single canonical request', async () => {
  respond = async () => okRow({ lifecycle_stage: 'asking_price' })
  const thread = baseThread()
  render(
    <DealDeskControlsProvider thread={thread}>
      <DealIntelligenceCommandRow data={{ threadKey: '+19015551234' }} />
    </DealDeskControlsProvider>,
  )

  const stageBtn = document.querySelector('.nx-di25-ctrl--stage .nx-di25-glass-btn') as HTMLElement
  await act(async () => { fireEvent.click(stageBtn) })
  const listbox = document.body.querySelector('.nx-conv-dropdown-portal') as HTMLElement
  await act(async () => {
    fireEvent.click(within(listbox).getByRole('option', { name: /Asking Price/i }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change stage only/i }))
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].sourceView, 'deal_desk', 'one source view, not a per-panel one')
  assert.deepEqual(calls[0].patch, { lifecycle_stage: 'asking_price' })
})
