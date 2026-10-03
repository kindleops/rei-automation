/**
 * RESEARCH SOURCES — Browser 1.0 "Save Source" (phase 1).
 *
 * A saved source is an observational POINTER attached to a property or
 * company — provenance only: URL, title, source type, linked object, timestamp,
 * operator. No page content, no notes, no browsing history. OPERATOR-PRIVATE:
 * every read and write is scoped to the Worker-verified operator. Saving one writes exactly two rows — the source and
 * an `attach` audit row — and never touches a property, owner, value or tax
 * fact. Removal is soft and audited. Navigation is never recorded.
 *
 * The operator is ALWAYS the one the Cloudflare Worker verified
 * (x-ops-user-id); a body never names it.
 *
 * The tables are a PROPOSED migration
 * (supabase/migrations-draft/browser/20261002230000_research_sources.sql).
 * Until it is applied every call reports `research_store_unavailable` (503) and
 * the dashboard keeps sources on the device.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const SOURCES_TABLE = 'research_sources'
export const AUDIT_TABLE = 'research_source_audit'
const COLUMNS = 'research_source_id, object_type, object_id, url, page_title, destination_type, captured_at'

export const DESTINATION_TYPES = new Set(['WEB_SEARCH', 'ASSESSOR', 'TAX', 'RECORDER', 'GIS', 'PERMITS', 'CODE', 'ZILLOW', 'REDFIN', 'REALTOR', 'GOOGLE_MAPS', 'STREET_VIEW', 'COUNTY_PROPERTY_SEARCH', 'STATE_CORPORATE'])
const OBJECT_TYPES = new Set(['property', 'company'])
const MAX_LIST = 100

export class ResearchSourceError extends Error {
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

const unavailable = (cause) => new ResearchSourceError('research_store_unavailable', 503, 'Research source storage is not enabled yet.', { cause })
const bad = (reason) => new ResearchSourceError('invalid_source', 400, reason)

export function operatorIdOf(headers) {
  const v = headers && typeof headers.get === 'function' ? headers.get('x-ops-user-id') : null
  const id = typeof v === 'string' ? v.trim() : ''
  return id && id.length <= 128 ? id : null
}

/** http(s) only; no credentials; ≤ 4000 chars. Returns the normalised URL or throws. */
export function safeUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.length > 4000) throw bad('url must be 1–4000 characters')
  let u
  try { u = new URL(text) } catch { throw bad('url is not a web address') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('only http(s) sources can be saved')
  if (u.username || u.password) throw bad('urls with credentials are refused')
  return u.toString()
}

export function validateSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('source must be an object')
  const objectType = String(raw.object_type || '')
  if (!OBJECT_TYPES.has(objectType)) throw bad('object_type must be property or company')
  const objectId = typeof raw.object_id === 'string' ? raw.object_id.trim() : String(raw.object_id ?? '').trim()
  if (!objectId || objectId.length > 128) throw bad('object_id is required')
  const destination = raw.destination_type == null ? null : String(raw.destination_type)
  if (destination !== null && !DESTINATION_TYPES.has(destination)) throw bad('unknown destination_type')
  const title = raw.page_title == null ? null : String(raw.page_title).trim().slice(0, 300) || null
  return { object_type: objectType, object_id: objectId, url: safeUrl(raw.url), page_title: title, destination_type: destination }
}

export function createResearchSourcesService({ db = defaultSupabase, now = () => new Date() } = {}) {
  const sources = () => db.from(SOURCES_TABLE)
  const audit = () => db.from(AUDIT_TABLE)
  const guard = (error) => { if (error) throw isMissingTable(error) ? unavailable(error) : error }

  async function list(operatorId, objectType, objectId) {
    if (!OBJECT_TYPES.has(String(objectType || '')) || !objectId) throw bad('object_type and object_id are required')
    const { data, error } = await sources().select(COLUMNS).eq('captured_by', operatorId).eq('object_type', objectType).eq('object_id', String(objectId)).is('removed_at', null).order('captured_at', { ascending: false }).limit(MAX_LIST)
    guard(error)
    return data || []
  }

  async function save(operatorId, raw) {
    const row = validateSource(raw)
    const stamp = now().toISOString()
    // one live attachment per (operator, object, url): saving again returns the existing row (no duplicate audit)
    const { data: existing, error: readErr } = await sources().select(COLUMNS).eq('captured_by', operatorId).eq('object_type', row.object_type).eq('object_id', row.object_id).eq('url', row.url).is('removed_at', null).maybeSingle()
    guard(readErr)
    if (existing) return { source: existing, created: false }
    const { data, error } = await sources().insert({ ...row, captured_at: stamp, captured_by: operatorId }).select(COLUMNS).single()
    guard(error)
    const { error: auditErr } = await audit().insert({ action: 'attach', research_source_id: data.research_source_id, object_type: row.object_type, object_id: row.object_id, url: row.url, destination_type: row.destination_type, page_title: row.page_title, actor: operatorId, created_at: stamp })
    guard(auditErr)
    return { source: data, created: true }
  }

  async function remove(operatorId, id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw bad('research_source_id is required')
    const stamp = now().toISOString()
    const { data, error } = await sources().update({ removed_at: stamp }).eq('research_source_id', id).eq('captured_by', operatorId).is('removed_at', null).select('research_source_id, object_type, object_id, url').maybeSingle()
    guard(error)
    if (!data) throw new ResearchSourceError('not_found', 404, 'No live source with that id.')
    const { error: auditErr } = await audit().insert({ action: 'remove', research_source_id: id, object_type: data.object_type, object_id: data.object_id, url: data.url, actor: operatorId, created_at: stamp })
    guard(auditErr)
    return { research_source_id: id }
  }

  /** An operator reports a broken destination (registry follow-up). Audit only. */
  async function report(operatorId, raw) {
    const destinationId = typeof raw?.destination_id === 'string' ? raw.destination_id.trim().slice(0, 80) : ''
    if (!destinationId) throw bad('destination_id is required')
    const url = raw?.url ? safeUrl(raw.url) : null
    const { error } = await audit().insert({ action: 'report_broken', destination_id: destinationId, url, actor: operatorId, created_at: now().toISOString() })
    guard(error)
    return { destination_id: destinationId }
  }

  return { list, save, remove, report }
}
