import { describe, expect, it, vi } from 'vitest'
import { sendComposerMessage, queueComposerTemplate, scheduleComposerMessage } from './composer-send'
import { paneSendArgs, type PaneSendTarget } from './multi/pane-send'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { SendNowResult, ThreadContext } from '../../lib/data/inboxData'

const thread = (key: string, ourNumber: string) => ({ id: `t-${key}`, threadKey: key, canonicalE164: key, ourNumber, isSuppressed: false }) as unknown as InboxWorkflowThread
const ctx = (seller: string) => ({ seller: { id: seller } }) as unknown as ThreadContext
const ok = (over: Partial<SendNowResult> = {}) => ({ ok: true, queueId: 'q1', messageEventId: null, providerMessageSid: 'SM1', deliveryStatus: 'sent', errorMessage: null, insertPayloadKeys: [], suppressionBlocked: false, sendRouteUsed: 'provider_immediate', queueProcessorEligible: false, ...over }) as SendNowResult

describe('one composer send path for every Inbox pane', () => {
  const panes: Record<number, PaneSendTarget> = {
    1: { thread: thread('+16125550101', '+16125559001'), threadContext: ctx('seller-1') },
    2: { thread: thread('+16125550202', '+16125559002'), threadContext: ctx('seller-2') },
    3: { thread: thread('+16125550303', '+16125559003'), threadContext: ctx('seller-3') },
  }

  it("a reply from pane 3 goes to pane 3's thread with pane 3's identity; panes 1 and 2 are untouched", async () => {
    const send = vi.fn(async () => ok())
    const toast = vi.fn()
    await sendComposerMessage({ ...paneSendArgs(panes[3], 'Still interested?', null, 'cs-3'), deps: { send, toast } })
    expect(send).toHaveBeenCalledOnce()
    const [sentThread, text, options] = send.mock.calls[0] as unknown as [InboxWorkflowThread, string, { threadContext: ThreadContext; clientSendId: string }]
    expect(sentThread).toBe(panes[3].thread)
    expect(sentThread.threadKey).toBe('+16125550303')
    expect((sentThread as unknown as { ourNumber: string }).ourNumber).toBe('+16125559003')
    expect(options.threadContext).toBe(panes[3].threadContext)
    expect(options.clientSendId).toBe('cs-3')
    expect(text).toBe('Still interested?')
    for (const call of send.mock.calls as unknown as Array<[InboxWorkflowThread]>) {
      expect([panes[1].thread, panes[2].thread]).not.toContain(call[0])
    }
  })

  it('the operator-override decision is the same single confirm, then a second send to the SAME thread', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(ok({ ok: false, operatorOverrideAllowed: true, backendReason: 'recent_delivery_failures', errorMessage: 'blocked' }))
      .mockResolvedValueOnce(ok())
    const confirm = vi.fn(async () => true)
    const toast = vi.fn()
    const result = await sendComposerMessage({ ...paneSendArgs(panes[2], 'hi', null, 'cs-2'), deps: { send, confirm, toast } })
    expect(result.ok).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(2)
    expect((send.mock.calls[1] as unknown[])[0]).toBe(panes[2].thread)
    expect(((send.mock.calls[1] as unknown[])[2] as { operatorOverride: boolean }).operatorOverride).toBe(true)
  })

  it('declining the override never re-sends; an unknown outcome is "not confirmed", not failed', async () => {
    const send = vi.fn(async () => ok({ ok: false, operatorOverrideAllowed: true, errorMessage: 'blocked' }))
    const toast = vi.fn()
    await sendComposerMessage({ ...paneSendArgs(panes[1], 'x', null, 'c'), deps: { send, confirm: vi.fn(async () => false), toast } })
    expect(send).toHaveBeenCalledOnce()
    const unknown = vi.fn(async () => ok({ ok: false, outcomeUnknown: true, errorMessage: null }))
    await sendComposerMessage({ ...paneSendArgs(panes[1], 'x', null, 'c'), deps: { send: unknown, toast } })
    expect(toast.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Send Not Confirmed', severity: 'warning' })
  })

  it('queue and schedule carry the pane thread and its context', async () => {
    const queue = vi.fn(async () => ({ ok: true, queueId: 'q9' }))
    const schedule = vi.fn(async () => ({ ok: true }))
    const toast = vi.fn()
    expect(await queueComposerTemplate({ thread: panes[3].thread, text: 'tpl', template: null, threadContext: panes[3].threadContext, deps: { queue: queue as never, toast } })).toBe(true)
    expect((queue.mock.calls[0] as unknown[])[0]).toBe(panes[3].thread)
    expect(await scheduleComposerMessage({ thread: panes[2].thread, text: 'later', template: null, threadContext: panes[2].threadContext, at: '2026-10-05T15:00:00Z', label: 'Tomorrow 10:00', deps: { schedule: schedule as never, toast } })).toBe(true)
    expect((schedule.mock.calls[0] as unknown[]).slice(0, 3)).toEqual([panes[2].thread, 'later', '2026-10-05T15:00:00Z'])
  })
})
