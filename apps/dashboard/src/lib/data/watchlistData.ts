import { callBackend } from '../api/backendClient'

/**
 * WATCHLIST — read and written ONLY through apps/api (/api/cockpit/signals/watches,
 * service role, operator allowlist). The browser no longer touches
 * notification_watchlist directly: its anon policies made it world-writable while
 * signed-in operators (role `authenticated`, no policy) read nothing and every
 * write failed RLS silently.
 */

export type WatchType = 'seller' | 'property' | 'thread' | 'prospect' | 'owner' | 'campaign'
/** The canonical subject vocabulary (a thread is a seller). */
export type WatchEntityType = 'seller' | 'property' | 'campaign'

export interface WatchlistEntry {
  id: string
  entity_type: string
  entity_id: string
  watch_type: WatchType
  watch_key: string
  label: string | null
  address: string | null
  market: string | null
  thread_key: string | null
  property_id: string | null
  created_at: string
  updated_at: string
}

export type WatchlistTogglePayload = {
  watch_type: WatchType
  watch_key: string
  label?: string
  thread_key?: string
  prospect_id?: string
  owner_id?: string
  master_owner_id?: string
  property_id?: string
  phone?: string
  address?: string
  market?: string
}

export interface WatchlistRead {
  items: WatchlistEntry[]
  supportedTypes: WatchEntityType[]
}

const PATH = '/api/cockpit/signals/watches'

type ListBody = { ok?: boolean; items?: WatchlistEntry[]; supported_types?: WatchEntityType[] }
type WriteBody = { ok?: boolean; result?: 'added' | 'removed'; message?: string }

export class WatchlistError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function readWatchlist(): Promise<WatchlistRead> {
  const res = await callBackend<ListBody>(PATH, { timeoutMs: 20_000 })
  if (!res.ok || !res.data?.ok) throw new WatchlistError(res.ok ? 'Watches could not be read.' : res.message || 'Watches could not be read.', res.status)
  return { items: res.data.items ?? [], supportedTypes: res.data.supported_types ?? ['seller', 'property'] }
}

/** Kept for existing callers: an unreadable list reads as empty (never invented). */
export const fetchWatchlist = async (): Promise<WatchlistEntry[]> => {
  try { return (await readWatchlist()).items } catch { return [] }
}

async function write(method: 'POST' | 'DELETE', body: Record<string, unknown>, query = ''): Promise<'added' | 'removed'> {
  const res = await callBackend<WriteBody>(`${PATH}${query}`, {
    method,
    ...(method === 'POST' ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
  if (!res.ok || !res.data?.ok || !res.data.result) {
    throw new WatchlistError(res.ok ? res.data?.message || 'The watch could not be saved.' : res.message || 'The watch could not be saved.', res.status)
  }
  return res.data.result
}

export const watchEntity = (entity_type: WatchEntityType, entity_id: string, extra: { label?: string | null; address?: string | null; market?: string | null } = {}) =>
  write('POST', { entity_type, entity_id, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) })

export const unwatchEntity = (entity_type: WatchEntityType, entity_id: string) =>
  write('DELETE', {}, `?${new URLSearchParams({ entity_type, entity_id }).toString()}`)

/** Legacy toggle (Inbox WatchBell): the server flips the row and says which way. */
export const toggleWatch = (payload: WatchlistTogglePayload): Promise<'added' | 'removed'> =>
  write('POST', { action: 'toggle', ...payload })

export const unwatch = async (watch_type: string, watch_key: string): Promise<void> => {
  await write('DELETE', {}, `?${new URLSearchParams({ entity_type: watch_type === 'thread' ? 'seller' : watch_type, entity_id: watch_key }).toString()}`)
}
