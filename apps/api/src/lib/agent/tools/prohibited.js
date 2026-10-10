// T4 — prohibited for the agent (architecture §3.4, §15.8). NEVER registered.
// A tool spec matching any rule below is refused at definition time, so a
// prohibited capability is not merely denied at call time: it is unreachable.
//
// Three independent nets:
//   1 name patterns       (what the tool says it is)
//   2 written domains     (spec.touches: what canonical data it writes)
//   3 wrapped modules     (spec.wraps.module: what code it calls)
// Plus: no raw SQL, no generic route proxy, no URL-taking/egress tool, no
// approval-granting tool, no self-modification.

export const PROHIBITED_DOMAINS = Object.freeze([
  // suppression / contactability
  'suppression', 'opt_out', 'contactability',
  // identity
  'owner_phone_verification', 'identity_tier', 'contact_matching_tags', 'person_property_phone_link',
  // contact history
  'contact_history', 'message_events_rewrite',
  // control plane
  'system_control', 'queue_control', 'sender_pools', 'routing_coverage', 'outbound_settings',
  // money + valuation canon
  'canonical_price', 'offer', 'quote', 'asking_price', 'valuation_canon', 'acquisition_scores', 'negotiation_params',
  // contracts / closings
  'contract', 'closing',
  // external communication / commitments
  'email_send', 'buyer_outreach', 'third_party_message', 'financial_commitment',
  // automation authoring
  'workflow_authoring', 'template_authoring', 'sms_templates', 'seller_automation_control',
  // data destruction
  'business_data_delete',
  // self-modification
  'agent_policy', 'operator_policy', 'budget_caps', 'price_book', 'model_routes', 'system_prompt', 'approval_grant',
])

export const PROHIBITED_RULES = Object.freeze([
  { id: 'suppression', re: /(^|\.)(un)?suppress(_|\.|$)|(set|write|release|clear|apply|mark|add|remove)_?(opt_?out|dnc|contactab)/i, reason: 'Suppression is a compliance path, never an agent action' },
  { id: 'identity', re: /(owner_?verify|verify_?phone|identity_?tier|matching_?tag|link_?(person|phone|property)|unlink)/i, reason: 'Identity verification and linking are human-only' },
  { id: 'contact_history', re: /(contact_?history|mark_?not_?contacted|rewrite_?message|message_?events?\.(write|update|delete))/i, reason: 'Contact history is immutable to the agent' },
  { id: 'control_plane', re: /(system_?control|queue\.(control|run|auto_?enqueue|retry|reprocess|reconcile|more)|queue_?more|auto_?reply_?mode|campaign_?mode|processor_?mode|sender_?pool|routing_?coverage|kill_?switch)/i, reason: 'Control plane and outbound settings are owner-only' },
  { id: 'money', re: /(current_?offer|submit_?offer|offer\.(create|submit|send|update)|set_?price|asking_?price|quote\.(create|send)|valuation\.(write|recalc|snapshot)|underwriting_?push|acquisition_?scores?\.(write|update)|negotiation_?params)/i, reason: 'Canonical prices, offers and valuation canon are never written by the agent' },
  { id: 'contracts', re: /(contract\.|closing\.|closing_?desk|finalize_?closing)/i, reason: 'Contracts and closings are human-only' },
  { id: 'external_comms', re: /(email\.send|send_?email|manual_?email|buyer\.(send|blast|outreach)|send_?package|third_?party)/i, reason: 'External communications are never sent by the agent' },
  { id: 'automation_authoring', re: /(workflow\.(publish|arm|pause|resume|mutate)|template\.(activate|write|create|update)|sms_?templates?\.(write|insert|update)|seller_?automation\.(execute|control))/i, reason: 'Automation and template authoring need owner wording review' },
  { id: 'destruction', re: /(\.delete($|_)|\.truncate|\.purge|\.drop|hard_?delete)/i, reason: 'Business data destruction is prohibited' },
  { id: 'self_modification', re: /(agent\.(policy|config|prompt|route|caps?)|operator_?policy|budget_?caps?|price_?book|model_?route|system_?prompt|approval\.(grant|approve|consume)|approve_?approval)/i, reason: 'The agent never modifies its own permissions, budgets, prompts or approvals' },
  { id: 'raw_sql', re: /(^|\.)(sql|raw_?sql|query_?db|execute_?sql|rpc_?any)($|\.|_)/i, reason: 'No raw SQL tool exists' },
  { id: 'generic_proxy', re: /(call_?route|any_?route|route_?proxy|http\.(get|post|request)|fetch_?url|web_?fetch|(^|\.)browse_?(web|url))/i, reason: 'No generic route proxy or ambient egress tool exists' },
])

/** Modules a tool may never wrap (send engine, provider transports, suppression writers). */
export const PROHIBITED_MODULE_PATTERNS = Object.freeze([
  /lib\/providers\/textgrid/i,
  /lib\/domain\/queue\/(process-send-queue|canonical-queue-writer|queue-atomic-claim|force-due|cancel|release|queue-control)/i,
  /lib\/domain\/outbound\//i,
  /lib\/domain\/seller-flow\//i,
  /suppression/i,
  /system-control/i,
  /lib\/domain\/closings\//i,
  /lib\/email\/.*send/i,
])

/** Input property names that would make a tool a SQL/egress/proxy surface. */
export const PROHIBITED_INPUT_KEYS = Object.freeze(['sql', 'raw_sql', 'statement', 'query_sql', 'route', 'url', 'endpoint', 'method', 'headers', 'host', 'table', 'rpc'])

/**
 * @returns {{ prohibited: boolean, rule: string|null, reason: string|null }}
 */
export function classifyProhibited(spec = {}) {
  const name = String(spec.name || '')
  for (const r of PROHIBITED_RULES) if (r.re.test(name)) return { prohibited: true, rule: r.id, reason: r.reason }
  for (const d of spec.touches || []) {
    if (PROHIBITED_DOMAINS.includes(d)) return { prohibited: true, rule: `domain:${d}`, reason: `Writes prohibited domain "${d}"` }
  }
  const mod = String(spec.wraps?.module || '')
  for (const re of PROHIBITED_MODULE_PATTERNS) if (re.test(mod)) return { prohibited: true, rule: 'module', reason: `Wraps a prohibited module (${mod})` }
  if (spec.wraps?.kind === 'sql' || spec.wraps?.kind === 'route_proxy') return { prohibited: true, rule: 'raw_sql', reason: 'No raw SQL or generic proxy tool exists' }
  const props = Object.keys(spec.input_schema?.properties || {})
  for (const p of props) if (PROHIBITED_INPUT_KEYS.includes(p.toLowerCase())) return { prohibited: true, rule: 'input_surface', reason: `Input "${p}" would expose SQL/egress/proxy` }
  if (spec.side_effect === 'prohibited' || spec.tier === 'T4') return { prohibited: true, rule: 'tier', reason: 'T4 is not registerable' }
  return { prohibited: false, rule: null, reason: null }
}
