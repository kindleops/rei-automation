/**
 * HOME LAYOUTS — operator-private persistence for the desktop Home command
 * board (Home 2.0). One row per saved layout:
 *
 *   operator_home_layouts (operator_id, layout_id) → name, is_default,
 *   profile, schema_version, revision, preset, primary_family,
 *   widget_instances (id, type, owner_app, geometry per width family, size
 *   mode, config + version, context, refresh, lock, stack), timestamps.
 *
 * The operator is ALWAYS the one the Cloudflare Worker verified
 * (x-ops-user-id); a body or query never names it. Writes are revision-checked:
 * a write that is not newer than the stored row is refused with the current
 * row so the client can adopt it (no silent overwrite between sessions).
 *
 * The table is a PROPOSED migration
 * (supabase/migrations/20261002200000_operator_home_layouts.sql).
 * Until it is applied every call reports `home_store_unavailable` and the
 * dashboard keeps its layouts locally.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const HOME_LAYOUT_TABLE = 'operator_home_layouts'
const COLUMNS = 'layout_id, name, is_default, profile, schema_version, revision, preset, primary_family, widget_instances, created_at, updated_at'

const LAYOUT_ID = /^[A-Za-z0-9_-]{4,64}$/
const PRESETS = new Set(['command', 'acquisitions', 'intelligence', 'closings', 'minimal'])
const FAMILIES = new Set(['narrow', 'standard', 'wide', 'ultra', 'wall'])
export const MAX_WIDGETS = 64
export const MAX_DOCUMENT_BYTES = 200_000
export const MAX_LAYOUTS = 40

export class HomeLayoutError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

export function isMissingTable(error) {
  if (!error) return false
  const code = String(error.code || '')
  if (['42P01', 'PGRST205', 'PGRST204', '42703'].includes(code)) return true
  const m = String(error.message || '').toLowerCase()
  return m.includes('does not exist') || m.includes('schema cache') || m.includes('could not find the table')
}

const unavailable = (cause) => new HomeLayoutError('home_store_unavailable', 503, 'Home layout storage is not enabled yet.', { cause })

export function operatorIdOf(headers) {
  const v = headers && typeof headers.get === 'function' ? headers.get('x-ops-user-id') : null
  const id = typeof v === 'string' ? v.trim() : ''
  return id && id.length <= 128 ? id : null
}

/** Validate and normalise one layout from a client. Throws invalid_layout with the reason. */
export function validateLayout(raw) {
  const bad = (reason) => new HomeLayoutError('invalid_layout', 400, reason)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('layout must be an object')
  const id = typeof raw.layout_id === 'string' ? raw.layout_id.trim() : ''
  if (!LAYOUT_ID.test(id)) throw bad('layout_id must be 4–64 letters, digits, _ or -')
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > 80) throw bad('name must be 1–80 characters')
  const revision = Number(raw.revision)
  if (!Number.isInteger(revision) || revision < 0 || revision > 1e9) throw bad('revision must be a non-negative integer')
  const schemaVersion = Number(raw.schema_version ?? 1)
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 100) throw bad('schema_version must be a positive integer')
  if (!Array.isArray(raw.widget_instances)) throw bad('widget_instances must be an array')
  if (raw.widget_instances.length > MAX_WIDGETS) throw bad(`at most ${MAX_WIDGETS} widgets per layout`)
  for (const w of raw.widget_instances) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw bad('every widget instance must be an object')
    if (typeof w.id !== 'string' || !LAYOUT_ID.test(w.id)) throw bad('every widget instance needs a stable id')
    if (typeof w.type !== 'string' || !w.type || w.type.length > 50) throw bad('every widget instance needs a type')
  }
  const bytes = Buffer.byteLength(JSON.stringify(raw.widget_instances), 'utf8')
  if (bytes > MAX_DOCUMENT_BYTES) throw bad('layout is too large')
  const preset = raw.preset == null ? null : String(raw.preset)
  if (preset !== null && !PRESETS.has(preset)) throw bad('unknown preset')
  const family = raw.primary_family == null ? null : String(raw.primary_family)
  if (family !== null && !FAMILIES.has(family)) throw bad('unknown primary_family')
  return {
    layout_id: id,
    name,
    is_default: raw.is_default === true,
    profile: 'desktop',
    schema_version: schemaVersion,
    revision,
    preset,
    primary_family: family,
    widget_instances: raw.widget_instances,
  }
}

export function createHomeLayoutService({ db = defaultSupabase, now = () => new Date() } = {}) {
  const table = () => db.from(HOME_LAYOUT_TABLE)

  async function list(operatorId) {
    const { data, error } = await table().select(COLUMNS).eq('operator_id', operatorId).order('updated_at', { ascending: false }).limit(MAX_LAYOUTS)
    if (error) throw isMissingTable(error) ? unavailable(error) : error
    return data || []
  }

  async function current(operatorId, layoutId) {
    const { data, error } = await table().select(COLUMNS).eq('operator_id', operatorId).eq('layout_id', layoutId).maybeSingle()
    if (error) throw isMissingTable(error) ? unavailable(error) : error
    return data || null
  }

  async function save(operatorId, raw) {
    const row = validateLayout(raw)
    const existing = await current(operatorId, row.layout_id)
    if (existing && Number(existing.revision) >= row.revision) {
      throw new HomeLayoutError('revision_conflict', 409, 'A newer copy of this layout was saved in another session.', { current: existing })
    }
    if (!existing) {
      const { count, error } = await table().select('layout_id', { count: 'exact', head: true }).eq('operator_id', operatorId)
      if (error) throw isMissingTable(error) ? unavailable(error) : error
      if ((count || 0) >= MAX_LAYOUTS) throw new HomeLayoutError('too_many_layouts', 400, `At most ${MAX_LAYOUTS} saved layouts.`)
    }
    const stamp = now().toISOString()
    if (row.is_default) {
      // one default per operator (also enforced by a partial unique index)
      const { error } = await table().update({ is_default: false, updated_at: stamp }).eq('operator_id', operatorId).eq('is_default', true).neq('layout_id', row.layout_id)
      if (error) throw isMissingTable(error) ? unavailable(error) : error
    }
    const { data, error } = await table()
      .upsert({ ...row, operator_id: operatorId, updated_at: stamp, ...(existing ? {} : { created_at: stamp }) }, { onConflict: 'operator_id,layout_id' })
      .select(COLUMNS)
      .single()
    if (error) throw isMissingTable(error) ? unavailable(error) : error
    return data
  }

  async function remove(operatorId, layoutId) {
    if (!LAYOUT_ID.test(String(layoutId || ''))) throw new HomeLayoutError('invalid_layout', 400, 'layout_id is required')
    const { error } = await table().delete().eq('operator_id', operatorId).eq('layout_id', layoutId)
    if (error) throw isMissingTable(error) ? unavailable(error) : error
    return { layout_id: layoutId }
  }

  return { list, save, remove }
}
