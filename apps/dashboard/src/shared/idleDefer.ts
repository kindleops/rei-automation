type IdleCallback = () => void

const scheduleIdle = (callback: IdleCallback, timeoutMs = 4000): (() => void) => {
  if (typeof window === 'undefined') {
    callback()
    return () => {}
  }

  const win = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number
    cancelIdleCallback?: (id: number) => void
  }

  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(() => callback(), { timeout: timeoutMs })
    return () => win.cancelIdleCallback?.(id)
  }

  const id = win.setTimeout(callback, Math.min(timeoutMs, 1500))
  return () => win.clearTimeout(id)
}

export const runWhenBrowserIdle = (callback: IdleCallback, timeoutMs = 4000): (() => void) =>
  scheduleIdle(callback, timeoutMs)