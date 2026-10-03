import { callBackend } from '../../lib/api/backendClient'
import type { DestinationType } from './destinations/types'
import { guardUrl } from './registry'

/**
 * SAVE SOURCE — attach a research page to a property/company as evidence.
 * Provenance only (URL, title, source type, linked object, time, operator);
 * operator-private on the server.
 *
 * OBSERVATIONAL ONLY: a saved source is a pointer (URL + title + where it
 * came from). It never changes an owner, value, tax amount or any property
 * fact; capturing a fact from it is a separate, future, provenance-carrying
 * action (Capture Fact — not built).
 *
 * Server: /api/cockpit/research/sources (operator from the Worker's
 * x-ops-user-id). Until the PROPOSED research_sources migration is applied
 * the API answers research_store_unavailable and the source is kept on this
 * device (lc.browser.sources.v1), honestly labelled as such.
 */

export interface SavedSource {
  research_source_id: string
  object_type: 'property' | 'company'
  object_id: string
  url: string
  page_title: string | null
  destination_type: DestinationType | null
  captured_at: string
  /** where it lives: the server, or this device only */
  where: 'server' | 'device'
}

export interface SaveSourceInput {
  objectType: 'property' | 'company'
  objectId: string
  url: string
  pageTitle: string | null
  destinationType: DestinationType | null
}

export type SaveResult = { ok: true; source: SavedSource } | { ok: false; reason: 'invalid' | 'unauthorized' | 'failed'; message: string }

export interface SourcesApi {
  save(input: SaveSourceInput): Promise<SaveResult>
  list(objectType: string, objectId: string): Promise<SavedSource[]>
  /** An operator flags a registry destination as broken (audit only; local until the store exists). */
  report(input: { destinationId: string; url: string | null }): Promise<{ where: 'server' | 'device' }>
}

const PATH = '/api/cockpit/research/sources'
const LOCAL_KEY = 'lc.browser.sources.v1'
const REPORT_KEY = 'lc.browser.reports.v1'
const MAX_LOCAL = 200

type Row = Omit<SavedSource, 'where'>
type Body = { ok?: boolean; error?: string; message?: string; source?: Row; sources?: Row[] }

function readLocal(): Row[] {
  try { const v = JSON.parse(window.localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeLocal(rows: Row[]) {
  try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(rows.slice(0, MAX_LOCAL))) } catch { /* device storage full: nothing to do */ }
}

/** Validate on the way out, exactly as the server does on the way in. */
export function validateSource(input: SaveSourceInput): { ok: true; url: string } | { ok: false; message: string } {
  if (input.objectType !== 'property' && input.objectType !== 'company') return { ok: false, message: 'Sources attach to a property or a company.' }
  if (!input.objectId || input.objectId.length > 128) return { ok: false, message: 'No record to attach this source to.' }
  const g = guardUrl(input.url)
  if (!g.ok) return { ok: false, message: 'Only http(s) pages can be saved as sources.' }
  return { ok: true, url: g.url }
}

export function createSourcesApi(call: typeof callBackend = callBackend, now: () => Date = () => new Date()): SourcesApi {
  return {
    async save(input) {
      const v = validateSource(input)
      if (!v.ok) return { ok: false, reason: 'invalid', message: v.message }
      const payload = {
        object_type: input.objectType,
        object_id: input.objectId,
        url: v.url,
        page_title: input.pageTitle?.slice(0, 300) ?? null,
        destination_type: input.destinationType,
      }
      const res = await call<Body>(PATH, { method: 'POST', body: JSON.stringify({ source: payload }), headers: { 'content-type': 'application/json' }, timeoutMs: 20_000 })
      if (res.ok && res.data?.source) return { ok: true, source: { ...res.data.source, where: 'server' } }
      const err = (res.ok ? res.data : (res.upstream as Body | undefined))?.error
      if (!res.ok && (res.status === 401 || res.status === 403) && err !== 'research_store_unavailable') return { ok: false, reason: 'unauthorized', message: 'The server refused to save this source.' }
      if (err === 'invalid_source') return { ok: false, reason: 'invalid', message: (res.ok ? res.data?.message : (res.upstream as Body | undefined)?.message) || 'The server rejected this source.' }
      // store not enabled yet (or unreachable): keep it on this device
      const row: Row = { research_source_id: `local-${now().getTime().toString(36)}`, ...payload, captured_at: now().toISOString() }
      writeLocal([row, ...readLocal().filter((r) => !(r.object_type === row.object_type && r.object_id === row.object_id && r.url === row.url))])
      return { ok: true, source: { ...row, where: 'device' } }
    },
    async list(objectType, objectId) {
      const local = readLocal().filter((r) => r.object_type === objectType && r.object_id === objectId).map((r) => ({ ...r, where: 'device' as const }))
      const res = await call<Body>(`${PATH}?object_type=${encodeURIComponent(objectType)}&object_id=${encodeURIComponent(objectId)}`, { timeoutMs: 20_000 })
      const server = res.ok && Array.isArray(res.data?.sources) ? res.data!.sources!.map((r) => ({ ...r, where: 'server' as const })) : []
      const seen = new Set(server.map((r) => r.url))
      return [...server, ...local.filter((r) => !seen.has(r.url))]
    },
    async report(input) {
      const res = await call<Body>(PATH, { method: 'POST', body: JSON.stringify({ report: { destination_id: input.destinationId, url: input.url } }), headers: { 'content-type': 'application/json' }, timeoutMs: 20_000 })
      if (res.ok) return { where: 'server' }
      try {
        const prev = JSON.parse(window.localStorage.getItem(REPORT_KEY) || '[]')
        window.localStorage.setItem(REPORT_KEY, JSON.stringify([{ destination_id: input.destinationId, url: input.url, at: now().toISOString() }, ...(Array.isArray(prev) ? prev : [])].slice(0, 50)))
      } catch { /* nothing to keep it in */ }
      return { where: 'device' }
    },
  }
}

export const sourcesApi = createSourcesApi()
