/**
 * ANALYTICS LAB — saved views.
 *
 * A saved view is a named Lab context (range, compare, filters, breadcrumb,
 * mode, metric, grain). It is operator UI state, not business state.
 *
 * The store is `public.analytics_saved_views`, proposed in
 * supabase/migrations/PROPOSED_20260930120000_analytics_lab.sql and NOT
 * applied. Until the operator approves it this module reports the store as
 * unavailable and the client keeps views on the device, saying so.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { ContractError, normalizeContext, publicContext } from './query-contract.js'

const TABLE = 'analytics_saved_views'
export const PROPOSED_MIGRATION = 'apps/api/supabase/migrations/PROPOSED_20260930120000_analytics_lab.sql'
const missingTable = (error) => ['42P01', 'PGRST205', 'PGRST202'].includes(String(error?.code || '')) || /does not exist|could not find the table/i.test(String(error?.message || ''))

export async function listSavedViews(deps = {}) {
  const client = deps.supabase || defaultSupabase
  const res = await client.from(TABLE).select('id,label,description,context,definition_version,is_pinned,created_by,created_at,updated_at').order('is_pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(200)
  if (res.error) {
    if (missingTable(res.error)) return { store: 'unavailable', reason: 'The saved-views table is proposed, not applied. Views are kept on this device.', migration: PROPOSED_MIGRATION, views: [] }
    throw res.error
  }
  return { store: 'server', views: res.data || [] }
}

export async function saveView({ label, description = null, context, isPinned = false, createdBy = null } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const name = String(label ?? '').trim().slice(0, 80)
  if (!name) throw new ContractError('a saved view needs a label')
  // Validate by normalising: a view that the contract rejects is never stored.
  const ctx = normalizeContext(context || {})
  const row = { label: name, description: description ? String(description).slice(0, 280) : null, context: publicContext(ctx), definition_version: ctx.version, is_pinned: Boolean(isPinned), created_by: createdBy ? String(createdBy).slice(0, 120) : null }
  const res = await client.from(TABLE).insert(row).select('id,label,context,definition_version,is_pinned,created_at').single()
  if (res.error) {
    if (missingTable(res.error)) return { store: 'unavailable', reason: 'The saved-views table is proposed, not applied.', migration: PROPOSED_MIGRATION }
    throw res.error
  }
  return { store: 'server', view: res.data }
}
