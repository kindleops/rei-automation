/**
 * ENTITY GRAPH · ONE COMPLETE PAGE (owner, 2026-10-08: "the grid only loads
 * field values for rows currently on screen — you scroll and cells fill in
 * afterward").
 *
 * ROOT CAUSE: browse returned the projection only; every visible picker
 * column (details.row) and every outreach column (details.outreach) was a
 * second and third request fired by the client AFTER the rows rendered
 * (200 ms debounce + a round trip each), per appended page — so cells popped
 * in while scrolling.
 *
 * Now `fields=<visible enrichment fields>` and `outreach=1` ride on the browse
 * request: the server reads the page, then the column values and the outreach
 * state for exactly those ids IN PARALLEL, and answers one response with every
 * visible value attached. Read-only, keyed reads (same whitelists as the
 * /columns and /outreach-state routes). An attachment that fails leaves the
 * rows intact and is NAMED in `attached.errors` — never a silent blank.
 */
import { browseEntityGraph } from './entity-graph-service.js'
import { getEntityGraphColumnEnrichment, parseEntityGraphColumnFields } from './entity-graph-column-enrichment.js'
import { getEntityGraphOutreachState } from './entity-graph-outreach-state.js'

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase())

export async function browseEntityGraphPage(params = {}, deps = {}) {
  const {
    browse = browseEntityGraph,
    enrich = getEntityGraphColumnEnrichment,
    outreachState = getEntityGraphOutreachState,
  } = deps
  const { fields: rawFields, outreach: rawOutreach, ...browseParams } = params
  const started = Date.now()
  const data = await browse(browseParams, deps.supabase ? { supabase: deps.supabase } : {})
  const tab = String(browseParams.tab || 'properties').toLowerCase()
  const fields = tab === 'properties' ? parseEntityGraphColumnFields(rawFields) : []
  const wantsOutreach = tab === 'properties' && truthy(rawOutreach)
  const results = Array.isArray(data?.results) ? data.results : []
  const ids = [...new Set(results.filter((r) => r?.entityType === 'property' && r.entityId).map((r) => String(r.entityId)))]
  const attached = { fields, outreach: wantsOutreach, errors: [], ms: { browse: Date.now() - started } }
  if (!ids.length || (!fields.length && !wantsOutreach)) return { ...data, attached }

  const t1 = Date.now()
  const [cols, out] = await Promise.all([
    fields.length
      ? enrich({ fields: fields.join(','), property_ids: ids.join(',') }, deps.supabase ? { supabase: deps.supabase } : {})
        .catch((error) => { attached.errors.push({ source: 'columns', message: String(error?.message || 'columns_failed').slice(0, 160) }); return null })
      : Promise.resolve(null),
    wantsOutreach
      ? outreachState({ property_ids: ids.join(',') }, deps.supabase ? { supabase: deps.supabase } : {})
        .catch((error) => { attached.errors.push({ source: 'outreach', message: String(error?.message || 'outreach_failed').slice(0, 160) }); return null })
      : Promise.resolve(null),
  ])
  attached.ms.attach = Date.now() - t1
  for (const u of out?.unavailable || []) attached.errors.push({ source: `outreach.${u.source}`, message: u.message })
  if (cols && fields.length) attached.fieldsLoaded = fields
  const values = cols?.values || {}
  const states = out?.states || null
  return {
    ...data,
    results: results.map((r) => {
      if (r?.entityType !== 'property') return r
      const id = String(r.entityId)
      const details = { ...(r.details || {}) }
      if (cols) details.row = { ...(details.row || {}), ...(values[id] || {}) }
      if (states) details.outreach = states[id] ?? null
      return { ...r, details }
    }),
    attached,
  }
}
