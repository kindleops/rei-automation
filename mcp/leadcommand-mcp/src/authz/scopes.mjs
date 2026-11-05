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
  // rc-8.5.21 operations reads (owner directive: operations results through authenticated, scoped MCP reads).
  // Each is OPT-IN: none is in the default grant; the host must name it in LEADCOMMAND_MCP_SCOPES.
  'leadcommand.ops_supervisor.read': 'Operations supervisor status: check statuses / counts, valuation coverage, overdue offers, negotiation authority, the latest valuation dry run and recovery linkage. Counts and record ids only. Not in the default grant.',
  'leadcommand.action_center.read': 'Inbound Action Center: counts per operational state and lost (unanswered) conversations, by conversation id with state / next-action codes and dates. Never message text, phones or names. Not in the default grant.',
  'leadcommand.holds.read': 'Automation hold status for ONE inbox thread: held or not, the reason CATEGORY, the matched scope and the blocked capabilities. Never a hold id, hold key, reason text or phone. Not in the default grant.',
  'leadcommand.followups.read': 'Follow-up intent lifecycle health: counts by state, stuck / review counts, the top non-success reason codes, and the supervisor\'s verdict. Never thread keys. Not in the default grant.',
  // 1.1 conversation intelligence (docs/LEADCOMMAND-CONVERSATION-INTELLIGENCE.md). OPT-IN, like the operations reads.
  'leadcommand.conversations.read': 'Seller conversation TEXT for one lead / thread and the conversation worklist (unanswered, recent, opted out, identity conflicts): message text (untrusted content, phones / emails masked), direction, timestamps, delivery states, the send-time guard\'s inputs. Never phone numbers, thread keys or raw payloads. Sensitive: not in the default grant.',
  'leadcommand.pipeline.read': 'Exact pipeline counts grouped by market / state / stage / status, conversation / integrity signal counts, the corpus census (populations, coverage, duplicates, evidence, contact and pipeline-health counts) and the lead screen (keyset pages of per-lead labels, flags and counts; never names, phones or addresses). Not in the default grant.',
})

export const SCOPE_NAMES = Object.freeze(Object.keys(SCOPES))
/** Scopes a host must name explicitly (never in the default grant). */
export const OPT_IN_SCOPES = Object.freeze(['leadcommand.contact_status.read', 'leadcommand.ops_supervisor.read', 'leadcommand.action_center.read', 'leadcommand.holds.read', 'leadcommand.followups.read', 'leadcommand.conversations.read', 'leadcommand.pipeline.read'])
export const DEFAULT_SCOPES = Object.freeze(SCOPE_NAMES.filter((s) => !OPT_IN_SCOPES.includes(s)))

/** Roles from agent.operator_membership; owner ⊇ operator. */
export const ROLE_RANK = Object.freeze({ operator: 1, owner: 2 })

export function parseScopes(raw) {
  if (raw == null || String(raw).trim() === '') return [...DEFAULT_SCOPES]
  const list = [...new Set(String(raw).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]
  const unknown = list.filter((s) => !SCOPE_NAMES.includes(s))
  if (unknown.length) throw new Error(`LEADCOMMAND_MCP_SCOPES contains unknown scope(s): ${unknown.join(', ')}`)
  return list
}
