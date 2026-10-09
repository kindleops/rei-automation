/**
 * ENTITY GRAPH · OWNING-COMPANY REGISTRY STATUS — ONE normalization (owner,
 * 2026-10-09: "filter properties whose owning LLC/corp is inactive / dissolved
 * … and also see the reason").
 *
 * Source: seller.company (state business registry, ~41K rows, keyed
 * (jurisdiction_code, company_number)). A property reaches its company through
 * seller.property_entity_contact_v1.owning_entity_id = '<company_number>:<jurisdiction_code>'
 * (verified 2026-10-09 on prod, all 48,135 rows: 18,858 keyed ids, 18,858
 * matched seller.company = 100%; 29,277 are 'name_only' — an entity name with
 * no registry record). seller.campaign_eligible_entity_v1 is the SAME rows
 * filtered to campaign-eligible contacts, so it is not the link source.
 *
 * current_status is free text from ~50 state registries (277 distinct values:
 * "Active", "In Existence", "Goodstanding", "Admin. Dissolved", "Forfeited
 * Existence", "Suspended   Ftb", "Term/Cancel", …). The class below is the
 * ONE reading of it; the raw text always travels with it as the reason.
 *
 * Classes: active · inactive · dissolved · forfeited · terminated_cancelled ·
 * withdrawn · unknown · not_a_company. The registry's own words win over its
 * `inactive` flag (217 "Active And In Good Standing" rows carry inactive=true
 * and a dissolution date — likely reinstated); the flag decides only when the
 * text is blank or unrecognised. Revoked / expired / void / dead are terminal
 * → terminated_cancelled; merged / converted / suspended / not in good
 * standing / delinquent → inactive; "pending dissolution" / "intent to
 * dissolve" still exist → active.
 */

export const COMPANY_STATUS_CLASSES = Object.freeze([
  'active', 'inactive', 'dissolved', 'forfeited', 'terminated_cancelled', 'withdrawn', 'unknown', 'not_a_company',
])

export const COMPANY_STATUS_LABEL = Object.freeze({
  active: 'Active',
  inactive: 'Inactive',
  dissolved: 'Dissolved',
  forfeited: 'Forfeited',
  terminated_cancelled: 'Terminated / cancelled',
  withdrawn: 'Withdrawn',
  unknown: 'Unknown',
  not_a_company: 'Not a company',
})

/** Ordered: the first rule whose pattern matches the normalized status text wins. */
export const COMPANY_STATUS_RULES = Object.freeze([
  // registry noise / name reservations — not an entity state
  ['unknown', /^(\d+|[a-z])$|reserv|^multiple$|^sop$|^misc\.?$|\\/],
  // still exists, a dissolution or withdrawal only pending
  ['active', /pending (admin )?dissolution|pending termination|intent to dissolve|withdrawal pending/],
  ['forfeited', /forfeit/],
  ['dissolved', /dissol|\bdiss\b|\bdiss[./]/],
  ['withdrawn', /withdraw/],
  ['terminated_cancelled', /terminat|cancel|term\/cancel|revok|expired|\bdead\b|\bvoid\b|deleted|removed by statute|existence ceased|ousted|law repealed|rejected/],
  ['inactive', /inactive|\bin active\b|suspen|not in good standing|not current|delinquent|^ngs$|bad standing|non ?complian|noncompliance|past due|default|\bheld\b|\bhold\b|merged|convert|bankruptcy|receivership|franchise tax ended|pendinact|pending inactive|flawed|incomplete|consolidat|non qualified|non domesticated|name change/],
  ['active', /active|good ?standing|existence|\bexists?\b|existing|current|incorporated|organized|registered|reinstated|revived|restored|qualified|redomesticated|excused|in process|process of appeal/],
])

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * @param {{ current_status?: string|null, inactive?: boolean|null, dissolution_date?: string|Date|null }} company
 * @returns {{ class: string, raw: string|null, basis: 'status_text'|'inactive_flag'|'dissolution_date'|'none' }}
 */
export function classifyCompanyStatus(company = {}) {
  const raw = String(company?.current_status ?? '').trim().replace(/\s+/g, ' ') || null
  const text = norm(raw)
  if (text) {
    for (const [cls, re] of COMPANY_STATUS_RULES) if (re.test(text)) return { class: cls, raw, basis: 'status_text' }
  }
  if (company?.dissolution_date && !text) return { class: 'dissolved', raw, basis: 'dissolution_date' }
  if (company?.inactive === true) return { class: 'inactive', raw, basis: 'inactive_flag' }
  return { class: 'unknown', raw, basis: 'none' }
}

/**
 * The property-level company fact.
 *   ec       seller.property_entity_contact_v1 row (+ the joined seller.company columns), or null
 *   corporate properties.is_corporate_owner
 * registry_match: matched | name_only | no_entity_record | individual
 */
export function propertyCompanyStatus(ec, { corporate = null } = {}) {
  if (!ec) {
    return corporate === true
      ? { class: 'unknown', raw: null, registryMatch: 'no_entity_record', name: null }
      : { class: 'not_a_company', raw: null, registryMatch: 'individual', name: null }
  }
  const keyed = /^[^:]+:[^:]+$/.test(String(ec.owning_entity_id ?? ''))
  if (!keyed || !ec.company_number) {
    return { class: 'unknown', raw: null, registryMatch: 'name_only', name: String(ec.owning_entity_name ?? '').trim() || null }
  }
  const c = classifyCompanyStatus(ec)
  return { class: c.class, raw: c.raw, basis: c.basis, registryMatch: 'matched', name: String(ec.company_name || ec.owning_entity_name || '').trim() || null }
}
