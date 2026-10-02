import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAskQueue, lcConfirm, lcPrompt, registerAskHost, settleAsk } from './ask-bus'
import { lcToast, subscribeToasts, TOAST_TONE } from './toast-bus'

describe('lcToast — immediate local confirmation', () => {
  it('delivers the legacy emitNotification shape with defaults', () => {
    const seen: unknown[] = []
    const off = subscribeToasts((t) => seen.push(t))
    lcToast({ title: 'Message Sent', severity: 'success' })
    lcToast({ title: 'Send Failed', severity: 'critical' })
    off()
    lcToast({ title: 'after unsubscribe', severity: 'info' })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ title: 'Message Sent', autoDismiss: true, dismissMs: 6000, read: false })
    // critical stays until dismissed
    expect(seen[1]).toMatchObject({ title: 'Send Failed', autoDismiss: false })
  })

  it('maps severity to LC tones; red only for failure', () => {
    expect(TOAST_TONE).toEqual({ info: 'exec', success: 'ok', warning: 'attn', critical: 'crit' })
  })
})

describe('lcConfirm / lcPrompt — never auto-confirm', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('falls back to the browser dialog with the exact text when no host is mounted', async () => {
    const confirm = vi.fn(() => false)
    const prompt = vi.fn(() => 'Renamed')
    vi.stubGlobal('window', { confirm, prompt })
    await expect(lcConfirm({ title: 'Delete?', effects: [], confirmLabel: 'Delete', nativeText: 'Delete draft "A"? This cannot be undone.' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith('Delete draft "A"? This cannot be undone.')
    await expect(lcPrompt({ title: 'Rename', label: 'Name', initialValue: 'A', nativeText: 'Rename campaign' })).resolves.toBe('Renamed')
    expect(prompt).toHaveBeenCalledWith('Rename campaign', 'A')
  })

  it('queues requests while a host is mounted and resolves only on an explicit answer', async () => {
    const unregister = registerAskHost()
    const confirm = vi.fn()
    vi.stubGlobal('window', { confirm })
    const a = lcConfirm({ title: 'Go live?', effects: [], confirmLabel: 'Go live', nativeText: 'x' })
    const b = lcPrompt({ title: 'Rename', label: 'Name', nativeText: 'y' })
    expect(confirm).not.toHaveBeenCalled()
    const [first, second] = getAskQueue()
    expect(first.kind).toBe('confirm')
    settleAsk(first.id, true)
    await expect(a).resolves.toBe(true)
    settleAsk(second.id, 'New name')
    await expect(b).resolves.toBe('New name')
    expect(getAskQueue()).toHaveLength(0)
    unregister()
  })

  it('a host unmounting resolves pending asks as cancelled, never as consent', async () => {
    const unregister = registerAskHost()
    const a = lcConfirm({ title: 'Go live?', effects: [], confirmLabel: 'Go live', nativeText: 'x' })
    const b = lcPrompt({ title: 'Rename', label: 'Name', nativeText: 'y' })
    unregister()
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBeNull()
  })
})
