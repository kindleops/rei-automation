/**
 * PIPELINE · RETURN STATE — the exact Pipeline the operator left.
 *
 * Open Beside keeps Pipeline mounted, so nothing is lost. Only when a
 * cross-app open has to take Pipeline's own pane (the workspace is full, or
 * no shell is running) is this snapshot written; the next Pipeline mount in
 * this tab — Back, or re-opening Pipeline — consumes it once and comes back
 * on the same mode, filters, search, chips, open deal and scroll position.
 *
 * Session-scoped (one tab), single-use, and short-lived: a snapshot older
 * than RETURN_TTL_MS is history, not a return.
 */
import type { PipelineCommandParams } from '../../../domain/pipeline/pipeline-command-api'
import type { LiveOwner } from './pipeline-desk-model'

export const RETURN_KEY = 'nexus.pipeline.desk.return.v1'
export const RETURN_TTL_MS = 30 * 60_000

export interface PipelineReturnState {
  mode: 'overview' | 'flow' | 'table' | 'offers'
  params: PipelineCommandParams
  query: string
  owner: LiveOwner | null
  stage: string | null
  showDormant: boolean
  openId: string | null
  /** the Pipeline scroll root and, in Table, the grid's own scroller */
  scrollTop: number
  gridScrollTop: number
  savedAt: number
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const store = (): Store | null => { try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null } }

export function saveReturnState(state: Omit<PipelineReturnState, 'savedAt'>, s: Store | null = store(), now = Date.now()) {
  try { s?.setItem(RETURN_KEY, JSON.stringify({ ...state, savedAt: now })) } catch { /* quota / private mode */ }
}

export function clearReturnState(s: Store | null = store()) {
  try { s?.removeItem(RETURN_KEY) } catch { /* ignore */ }
}

/**
 * Read (without clearing — a render may run twice; the caller clears after
 * mount). Null when there is none, it is stale, or it is malformed.
 */
export function peekReturnState(s: Store | null = store(), now = Date.now()): PipelineReturnState | null {
  if (!s) return null
  let raw: string | null = null
  try { raw = s.getItem(RETURN_KEY) } catch { return null }
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as PipelineReturnState
    if (!v || typeof v.savedAt !== 'number' || now - v.savedAt > RETURN_TTL_MS) return null
    if (!['overview', 'flow', 'table', 'offers'].includes(v.mode)) return null
    return {
      mode: v.mode,
      params: v.params && typeof v.params === 'object' ? v.params : { scope: 'active' },
      query: typeof v.query === 'string' ? v.query : '',
      owner: (v.owner as LiveOwner | null) ?? null,
      stage: typeof v.stage === 'string' ? v.stage : null,
      showDormant: Boolean(v.showDormant),
      openId: typeof v.openId === 'string' ? v.openId : null,
      scrollTop: Number(v.scrollTop) || 0,
      gridScrollTop: Number(v.gridScrollTop) || 0,
      savedAt: v.savedAt,
    }
  } catch { return null }
}
