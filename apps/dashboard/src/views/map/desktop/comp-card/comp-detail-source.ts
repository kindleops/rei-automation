/**
 * The app's one comp-detail store: get_map_sold_comp(p_comp_id) through the
 * Supabase client, abortable. Kept apart from the store so tests inject a
 * fake fetcher and never touch the network.
 */
import { loadCompDetail } from '../../mobile/useSoldComps'
import type { CompRecord } from './comp-card-model'
import { createCompDetailStore } from './comp-detail-store'

export const compDetailStore = createCompDetailStore(
  (id, signal) => loadCompDetail(id, signal) as Promise<CompRecord | null>,
)
