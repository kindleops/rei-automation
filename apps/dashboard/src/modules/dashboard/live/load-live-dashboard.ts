import { loadCommandCenterStore } from '../../../domain/normalize-command-center'
import { adaptLiveDashboardModel } from './live-dashboard.adapter'
import { fetchLiveDashboard } from './live-dashboard.fetcher'
import type { LiveDashboardModel } from './live-dashboard.adapter'
import { hydrateLiveDashboardFromSupabase } from '../../../lib/data/mapData'
import { isDev, shouldUseSupabase } from '../../../lib/data/shared'

// ─── Mode selection ────────────────────────────────────────────────────────
// When VITE_BACKEND_API_URL is set the loader calls the live API.
// Without it, the reference mock dataset is used (local development default).
const LIVE_API_URL = import.meta.env.VITE_BACKEND_API_URL ?? ''

// ─── Cache ────────────────────────────────────────────────────────────────
// One inflight promise at a time.  Resets on route change / hard refresh.
let liveDashboardPromise: Promise<LiveDashboardModel> | null = null

async function loadFromApi(): Promise<LiveDashboardModel> {
  try {
    return await fetchLiveDashboard()
  } catch (err) {
    // Degrade gracefully: fall back to mock data and annotate the model
    // so the UI can show a degraded banner.
    console.warn('[NEXUS] Live API unavailable, falling back to mock data.', err)
    const store = await loadCommandCenterStore()
    const model = adaptLiveDashboardModel(store)
    return {
      ...model,
      dataSource: 'mock',
      degraded: {
        reason: err instanceof Error ? err.message : 'Live API unavailable',
        partial: ['All data is sourced from the reference mock dataset'],
      },
    }
  }
}

async function loadFromMock(): Promise<LiveDashboardModel> {
  const store = await loadCommandCenterStore()
  const base = { ...adaptLiveDashboardModel(store), dataSource: 'mock' as const }

  if (!shouldUseSupabase()) {
    return base
  }

  try {
    return await hydrateLiveDashboardFromSupabase(base)
  } catch (error) {
    if (isDev) {
      console.warn('[NEXUS] Live map Supabase hydration failed, using mock model.', error)
    }
    return {
      ...base,
      degraded: {
        reason: error instanceof Error ? error.message : 'Supabase live map hydration failed',
        partial: ['Map and market metrics are using local reference data'],
      },
    }
  }
}

export const loadLiveDashboard = (): Promise<LiveDashboardModel> => {
  if (liveDashboardPromise) return liveDashboardPromise
  liveDashboardPromise = LIVE_API_URL ? loadFromApi() : loadFromMock()
  return liveDashboardPromise
}

// Exposed for use in polling / manual refresh
export const resetLiveDashboardCache = () => {
  liveDashboardPromise = null
}
