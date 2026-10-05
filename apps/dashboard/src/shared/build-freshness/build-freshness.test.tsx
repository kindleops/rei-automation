/** @jsxRuntime automatic */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RELOAD_GUARD_PREFIX,
  dismissFreshnessNotice,
  getFreshnessNotice,
  hasUnsavedInput,
  parseMainEntry,
  pollForNewBuild,
  recoverFromChunkFailure,
  registerUnsavedInputProbe,
  resetBuildFreshnessForTests,
  startVersionPoll,
  type FreshnessDeps,
} from './build-freshness'
import { BuildFreshnessView, ChunkLoadFallback } from './BuildFreshnessNotice'

const OLD = '/assets/main-OLDhash1.js'
const NEW = '/assets/main-NEWhash2.js'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  }
}

function deps(over: Partial<FreshnessDeps> = {}): FreshnessDeps & { reload: ReturnType<typeof vi.fn> } {
  const reload = vi.fn()
  return {
    runningEntry: () => OLD,
    fetchLatestEntry: async () => NEW,
    hasUnsavedInput: () => false,
    storage: memoryStorage(),
    schedule: (fn) => fn(),
    ...over,
    reload: (over.reload as ReturnType<typeof vi.fn>) ?? reload,
  } as FreshnessDeps & { reload: ReturnType<typeof vi.fn> }
}

afterEach(() => resetBuildFreshnessForTests())

describe('parseMainEntry', () => {
  it('reads the hashed entry the boot script references', () => {
    expect(parseMainEntry(`<script>var ENTRY = '${NEW}'\nvar CSS = '__NEXUS_MAIN_CSS__'</script>`)).toBe(NEW)
    expect(parseMainEntry('<link href="/assets/main-Cb3A3cAZ.css">')).toBeNull()
    expect(parseMainEntry(null)).toBeNull()
  })
})

describe('chunk failure with a new build', () => {
  it('reloads exactly once and shows the reloading toast', async () => {
    const storage = memoryStorage()
    const d = deps({ storage })
    expect(await recoverFromChunkFailure(d)).toBe('reloading')
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(storage.map.has(RELOAD_GUARD_PREFIX + NEW)).toBe(true)
    expect(getFreshnessNotice()).toEqual({ kind: 'reloading', target: NEW })
    // a second failure in the same page never schedules a second reload
    expect(await recoverFromChunkFailure(d)).toBe('reloading')
    expect(d.reload).toHaveBeenCalledTimes(1)
  })

  it('the session guard prevents a loop when the reload landed on the old build again', async () => {
    const storage = memoryStorage()
    storage.setItem(RELOAD_GUARD_PREFIX + NEW, 'earlier')
    const d = deps({ storage })
    expect(await recoverFromChunkFailure(d)).toBe('deferred')
    expect(d.reload).not.toHaveBeenCalled()
    expect(getFreshnessNotice()?.kind).toBe('update-deferred')
  })

  it('concurrent failures share one check', async () => {
    const fetchLatestEntry = vi.fn(async () => NEW)
    const d = deps({ fetchLatestEntry })
    const [a, b] = await Promise.all([recoverFromChunkFailure(d), recoverFromChunkFailure(d)])
    expect([a, b]).toEqual(['reloading', 'reloading'])
    expect(fetchLatestEntry).toHaveBeenCalledTimes(1)
    expect(d.reload).toHaveBeenCalledTimes(1)
  })

  it('never auto-reloads without sessionStorage (no loop protection)', async () => {
    const d = deps({ storage: null })
    expect(await recoverFromChunkFailure(d)).toBe('deferred')
    expect(d.reload).not.toHaveBeenCalled()
  })
})

describe('chunk failure without a new build', () => {
  it('returns retry and does not reload (same build)', async () => {
    const d = deps({ fetchLatestEntry: async () => OLD })
    expect(await recoverFromChunkFailure(d)).toBe('retry')
    expect(d.reload).not.toHaveBeenCalled()
    expect(getFreshnessNotice()).toBeNull()
  })

  it('returns retry when the index itself is unreachable', async () => {
    const d = deps({ fetchLatestEntry: async () => { throw new TypeError('Failed to fetch') } })
    expect(await recoverFromChunkFailure(d)).toBe('retry')
    expect(d.reload).not.toHaveBeenCalled()
  })

  it('renders the app error state with a Retry button', () => {
    const html = renderToStaticMarkup(<ChunkLoadFallback outcome="retry" onRetry={() => undefined} />)
    expect(html).toContain('data-chunk-load-error="retry"')
    expect(html).toContain('>Retry</button>')
  })
})

describe('dirty composer blocks the reload', () => {
  it('a registered draft probe defers the reload and offers it instead', async () => {
    const unregister = registerUnsavedInputProbe(() => true)
    const storage = memoryStorage()
    const d = deps({ storage, hasUnsavedInput: () => hasUnsavedInput(null) })
    expect(await recoverFromChunkFailure(d)).toBe('deferred')
    expect(d.reload).not.toHaveBeenCalled()
    expect(storage.map.size).toBe(0) // the one-shot guard is not spent
    expect(getFreshnessNotice()).toEqual({ kind: 'update-deferred', target: NEW })
    const html = renderToStaticMarkup(
      <BuildFreshnessView notice={getFreshnessNotice()} onReload={() => undefined} onDismiss={() => undefined} />,
    )
    expect(html).toContain('Update available — reload when ready')
    unregister()
  })

  it('detects unsent text in a composer textarea and inputs inside an open modal', () => {
    const doc = (sel: Record<string, Array<Record<string, unknown>>>) => ({
      querySelectorAll: (s: string) => (s === 'textarea' ? sel.textarea ?? [] : s.includes('contenteditable') ? sel.ce ?? [] : sel.modal ?? []),
    })
    expect(hasUnsavedInput(doc({ textarea: [{ value: 'Hi Alex, ' }] }))).toBe(true)
    expect(hasUnsavedInput(doc({ textarea: [{ value: '   ' }] }))).toBe(false)
    expect(hasUnsavedInput(doc({ textarea: [{ value: 'log', readOnly: true }] }))).toBe(false)
    expect(hasUnsavedInput(doc({ modal: [{ type: 'text', value: 'Campaign name' }] }))).toBe(true)
    expect(hasUnsavedInput(doc({ modal: [{ type: 'checkbox', value: 'on' }] }))).toBe(false)
    expect(hasUnsavedInput(doc({ ce: [{ textContent: 'note' }] }))).toBe(true)
  })
})

describe('version poll pill', () => {
  it('shows "New version available · Reload" when the build changed, without reloading', async () => {
    const d = deps()
    expect(await pollForNewBuild(d)).toBe(true)
    expect(d.reload).not.toHaveBeenCalled()
    expect(getFreshnessNotice()).toEqual({ kind: 'update-available', target: NEW })
    const html = renderToStaticMarkup(
      <BuildFreshnessView notice={getFreshnessNotice()} onReload={() => undefined} onDismiss={() => undefined} />,
    )
    expect(html).toContain('New version available')
    expect(html).toContain('>Reload</button>')
  })

  it('stays quiet when the build is unchanged, and a dismissed target does not return', async () => {
    expect(await pollForNewBuild(deps({ fetchLatestEntry: async () => OLD }))).toBe(false)
    expect(getFreshnessNotice()).toBeNull()
    await pollForNewBuild(deps())
    dismissFreshnessNotice()
    await pollForNewBuild(deps())
    expect(getFreshnessNotice()).toBeNull()
  })

  it('polls every 5 minutes and on focus (throttled)', async () => {
    let clock = 0
    let tick: () => void = () => undefined
    let focus: () => void = () => undefined
    const fetchLatestEntry = vi.fn(async () => OLD)
    const stop = startVersionPoll(deps({ fetchLatestEntry }), {
      setInterval: (fn, ms) => {
        expect(ms).toBe(5 * 60 * 1000)
        tick = fn
        return 1
      },
      clearInterval: () => undefined,
      addFocusListener: (fn) => {
        focus = fn
        return () => undefined
      },
      now: () => clock,
    })
    focus() // too soon after boot
    expect(fetchLatestEntry).toHaveBeenCalledTimes(0)
    clock = 60_000
    focus()
    expect(fetchLatestEntry).toHaveBeenCalledTimes(1)
    tick()
    expect(fetchLatestEntry).toHaveBeenCalledTimes(2)
    stop()
  })

  it('renders nothing with no notice', () => {
    expect(renderToStaticMarkup(<BuildFreshnessView notice={null} onReload={() => undefined} onDismiss={() => undefined} />)).toBe('')
  })
})
