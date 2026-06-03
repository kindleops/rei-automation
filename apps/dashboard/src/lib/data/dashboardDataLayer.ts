import type { AnyRecord } from './shared'

export type DashboardConnectionState = 'live' | 'degraded_polling' | 'offline' | 'reconnecting'

export const dataLayerNow = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

const durationSince = (startedAt: number): number => Math.max(0, Math.round(dataLayerNow() - startedAt))

const withCommonTiming = (
  name: string,
  startedAt: number,
  meta: AnyRecord = {},
): AnyRecord => ({
  name,
  durationMs: durationSince(startedAt),
  ...meta,
})

export const logDataLayerQueryStart = (name: string, meta: AnyRecord = {}): number => {
  const startedAt = dataLayerNow()
  console.log('[DATA_LAYER_QUERY_START]', {
    name,
    startedAt,
    ...meta,
  })
  return startedAt
}

export const logDataLayerQueryDone = (
  name: string,
  startedAt: number,
  meta: AnyRecord = {},
): void => {
  console.log('[DATA_LAYER_QUERY_DONE]', withCommonTiming(name, startedAt, meta))
}

export const loadDashboardViewModel = async <T>(
  viewModel: string,
  run: () => Promise<T>,
  meta: AnyRecord = {},
): Promise<T> => {
  const startedAt = dataLayerNow()
  console.log('[VIEW_MODEL_LOAD_START]', {
    viewModel,
    startedAt,
    ...meta,
  })

  try {
    const result = await run()
    console.log('[VIEW_MODEL_LOAD_DONE]', withCommonTiming(viewModel, startedAt, {
      viewModel,
      ok: true,
      ...meta,
    }))
    return result
  } catch (error) {
    console.warn('[VIEW_MODEL_LOAD_DONE]', withCommonTiming(viewModel, startedAt, {
      viewModel,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...meta,
    }))
    throw error
  }
}

export const logHydrationPhaseDone = (
  phase: string,
  startedAt: number,
  meta: AnyRecord = {},
): void => {
  console.log('[HYDRATION_PHASE_DONE]', withCommonTiming(phase, startedAt, {
    phase,
    ...meta,
  }))
}

export const logCacheAccess = (
  cacheName: string,
  hit: boolean,
  meta: AnyRecord = {},
): void => {
  console.log(hit ? '[CACHE_HIT]' : '[CACHE_MISS]', {
    cacheName,
    hit,
    ...meta,
  })
}

export const logCacheCommitDone = (
  source: string,
  startedAt: number,
  meta: AnyRecord = {},
): void => {
  console.log('[CACHE_COMMIT_DONE]', withCommonTiming(source, startedAt, {
    source,
    ...meta,
  }))
}

export const logRealtimePatchApplied = (meta: AnyRecord = {}): void => {
  console.log('[REALTIME_PATCH_APPLIED]', meta)
}

export const logRealtimeFallbackPolling = (
  reason: string,
  meta: AnyRecord = {},
): void => {
  console.warn('[REALTIME_FALLBACK_POLLING]', {
    reason,
    ...meta,
  })
}
