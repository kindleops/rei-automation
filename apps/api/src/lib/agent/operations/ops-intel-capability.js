// Read-only, MCP-safe operations intelligence capability for Agntei (8.5.21-b, Phase 10).
//
// ONE tool descriptor in the shape of the LeadCommand MCP 1.0 read catalog (feat/leadcommand-mcp-1:
// readOnlyHint, one read scope, closed input schema, output schema, limits, provenance) so the MCP
// gateway can register it unchanged. It READS what the supervisor and the brief already produced:
//   supervisor        latest supervisor.summary (statuses / counts / all_clear)
//   research_valuation agent.ops_research_valuation_snapshot (valuation coverage, overdue offers,
//                     negotiation authority)
//   valuation_dry_run latest valuation.refresh_batch (coverage gain; dry run)
//   recovery          latest recovery.batch + recovery.linkage (classes, next actions, research requests)
// Every missing source is { available: false, code } — never 0. Ids and counts only; the output is
// scanned for contact values (phone / e-mail shapes) and refused if any appear. No write, no send,
// no model, no paid call.
export const OPS_INTEL_TOOL_NAME = 'leadcommand_ops_intelligence_status'
export const OPS_INTEL_SECTIONS = Object.freeze(['supervisor', 'research_valuation', 'valuation_dry_run', 'recovery'])
const READ_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
const PHONE_RE = /(?<![0-9a-f-])\+?1?[2-9][0-9]{2}[-. ]?[0-9]{3}[-. ]?[0-9]{4}(?![0-9a-f-])/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

/** Recursively scan for contact-shaped string values (uuids / hashes / ISO dates are not phones). */
export function containsContactValue(v) {
  if (typeof v === 'string') return (PHONE_RE.test(v) && !/^\d{4}-\d{2}-\d{2}T/.test(v)) || EMAIL_RE.test(v)
  if (Array.isArray(v)) return v.some(containsContactValue)
  if (v && typeof v === 'object') return Object.values(v).some(containsContactValue)
  return false
}

const unavailable = (code) => ({ available: false, code })

export const opsIntelTool = Object.freeze({
  name: OPS_INTEL_TOOL_NAME,
  title: 'LeadCommand operations intelligence status (read-only)',
  description: 'Supervisor statuses, valuation coverage, overdue offers, negotiation authority, the latest valuation dry run and recovery linkage. Read-only: counts and record ids, never contact values. Missing sources are reported as unavailable, never as zero.',
  annotations: READ_ANNOTATIONS,
  scope: 'read:operations',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { sections: { type: 'array', minItems: 1, maxItems: OPS_INTEL_SECTIONS.length, items: { type: 'string', enum: [...OPS_INTEL_SECTIONS] } } },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['tool', 'at', 'sections', 'provenance'],
    properties: {
      tool: { type: 'string' }, at: { type: 'string' },
      sections: { type: 'object' },
      provenance: { type: 'array', items: { type: 'object' } },
    },
  },
  limits: Object.freeze({ timeout_ms: 8_000, max_ids_per_list: 20 }),
  /**
   * @param {{ sections?: string[] }} input
   * @param {{ store: { latestFinding: Function }, source?: { researchValuationSnapshot?: Function }|null, now?: () => number }} deps
   */
  async run(input = {}, { store, source = null, now = () => Date.now() } = {}) {
    const want = new Set(Array.isArray(input?.sections) && input.sections.length ? input.sections.filter((x) => OPS_INTEL_SECTIONS.includes(x)) : OPS_INTEL_SECTIONS)
    const at = new Date(now()).toISOString()
    const latest = (t) => (store?.latestFinding ? store.latestFinding({ finding_type: t }).catch((e) => ({ __unavailable: String(e?.code || 'STORE_UNAVAILABLE') })) : Promise.resolve({ __unavailable: 'STORE_NOT_CONFIGURED' }))
    const wrap = (f, code) => (!f ? unavailable(code) : f.__unavailable ? unavailable(f.__unavailable) : { available: true, at: f.retrieved_at || null, job_id: f.job_id || null, value: f.value })
    const out = {}
    const prov = []
    if (want.has('supervisor')) { out.supervisor = wrap(await latest('supervisor.summary'), 'SUPERVISOR_NOT_RUN'); prov.push({ section: 'supervisor', source: 'agent.finding:supervisor.summary' }) }
    if (want.has('research_valuation')) {
      const r = source?.researchValuationSnapshot ? await source.researchValuationSnapshot({ now: at }).then((x) => (x ? { available: true, value: x } : unavailable('RESEARCH_VALUATION_SNAPSHOT_EMPTY')), (e) => unavailable(String(e?.code || 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE'))) : unavailable('RESEARCH_VALUATION_SOURCE_NOT_CONFIGURED')
      if (r.available && r.value?.offers?.overdue_opportunity_ids) r.value = { ...r.value, offers: { ...r.value.offers, overdue_opportunity_ids: r.value.offers.overdue_opportunity_ids.slice(0, this?.limits?.max_ids_per_list ?? 20) } }
      out.research_valuation = r
      prov.push({ section: 'research_valuation', source: 'agent.ops_research_valuation_snapshot' })
    }
    if (want.has('valuation_dry_run')) { out.valuation_dry_run = wrap(await latest('valuation.refresh_batch'), 'VALUATION_REFRESH_NOT_RUN'); prov.push({ section: 'valuation_dry_run', source: 'agent.finding:valuation.refresh_batch' }) }
    if (want.has('recovery')) {
      const [b, l] = await Promise.all([latest('recovery.batch'), latest('recovery.linkage')])
      const batch = wrap(b, 'RECOVERY_NOT_RUN')
      const link = wrap(l, 'RECOVERY_LINKAGE_NOT_RUN')
      out.recovery = batch.available ? { ...batch, linkage: link.available ? { research: link.value?.research ?? null, valuation_requests: Array.isArray(link.value?.valuation_requests) ? link.value.valuation_requests.length : null, by_next_action: link.value?.by_next_action ?? null } : link } : batch
      prov.push({ section: 'recovery', source: 'agent.finding:recovery.batch + recovery.linkage' })
    }
    const result = { tool: OPS_INTEL_TOOL_NAME, at, sections: out, provenance: prov, read_only: true }
    if (containsContactValue(result)) return { tool: OPS_INTEL_TOOL_NAME, at, sections: {}, provenance: prov, read_only: true, refused: 'CONTACT_VALUE_IN_OUTPUT' }
    return result
  },
})
