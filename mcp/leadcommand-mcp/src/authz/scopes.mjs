// Scope catalog. Every tool needs exactly ONE read scope; there is no write
// scope in 1.0, and none can be granted (unknown scopes are refused at boot).
export const SCOPES = Object.freeze({
  'leadcommand.leads.read': 'Seller-lead state (stage, status, last contact date, campaign membership, score tier). No names, phones or message text.',
  'leadcommand.properties.read': 'Property / asset facts, recorded-document summaries, distress evidence. No owner names or mailing addresses.',
  'leadcommand.scores.read': 'Decision Engine output for a property (property_acquisition_scores) with its freshness verdict.',
  'leadcommand.market.read': 'ZIP-level market rollups from the current Market Intelligence build.',
  'leadcommand.comps.read': 'Recorded market sales near a subject property, with buyer-evidence basis. No buyer names.',
  'leadcommand.campaigns.read': 'Campaign status, lifecycle, counters and target status counts. No recipients.',
  'leadcommand.contact_status.read': 'SMS eligibility + suppression STATE for a lead. Never phone numbers. Sensitive: not in the default grant.',
})

export const SCOPE_NAMES = Object.freeze(Object.keys(SCOPES))
export const DEFAULT_SCOPES = Object.freeze(SCOPE_NAMES.filter((s) => s !== 'leadcommand.contact_status.read'))

/** Roles from agent.operator_membership; owner ⊇ operator. */
export const ROLE_RANK = Object.freeze({ operator: 1, owner: 2 })

export function parseScopes(raw) {
  if (raw == null || String(raw).trim() === '') return [...DEFAULT_SCOPES]
  const list = [...new Set(String(raw).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]
  const unknown = list.filter((s) => !SCOPE_NAMES.includes(s))
  if (unknown.length) throw new Error(`LEADCOMMAND_MCP_SCOPES contains unknown scope(s): ${unknown.join(', ')}`)
  return list
}
