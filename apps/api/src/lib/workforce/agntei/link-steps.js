// "Register an Agntei agent" (docs/WORKFORCE-AGNTEI.md §1): the EXACT owner steps after the CEO created the
// pending_link employee, rendered as copyable commands. NOTHING here executes anything: the owner runs each step
// (the credential is minted on the owner's machine and never shown to LeadCommand; the SQL runs in the owner's SQL
// editor as an org owner). Pure.
import { WORKFORCE_GATEWAY_TOOLS, mcpToolName, suggestedAgentId } from './tools.js'

const q = (v) => `'${String(v).replace(/'/g, "''")}'`

/**
 * @param {{ employee: object, org_id: string, ceo_user_id: string|null, link_window_hours?: number, grant_days?: number }} o
 * @returns {{ agent_id, employee_id, steps: { id, title, who, kind, command, note }[], tools: string[] }}
 */
export function agnteiLinkSteps({ employee, org_id, ceo_user_id, link_window_hours = 24, grant_days = 30 }) {
  const agent_id = employee?.action_principal_id || suggestedAgentId(employee?.employee_id)
  const ceo = ceo_user_id || '<CEO_USER_ID>'
  const name = String(employee?.display_name || agent_id).replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 80) || agent_id
  const grants = WORKFORCE_GATEWAY_TOOLS.map((t) => `  (${q(org_id)}, ${q(agent_id)}, ${q(t.capability)}, 1, '{}', '{}', ${t.kind === 'read' ? '120, 2000' : '60, 500'}, ${t.spends ? '0.25' : '0'}, ${q(ceo)}, now() + interval '${grant_days} days')`)
  return {
    agent_id,
    employee_id: employee?.employee_id ?? null,
    tools: WORKFORCE_GATEWAY_TOOLS.map((t) => mcpToolName(t.tool)),
    steps: [
      { id: 'mint', title: 'Mint the agent credential (owner machine)', who: 'owner', kind: 'shell',
        command: `cd mcp/leadcommand-action-mcp && npm run mint:agent-credential -- --pepper-file ~/.leadcommand/action-pepper --agent-id ${agent_id} --out ~/.leadcommand/${agent_id}.credential`,
        note: 'Prints the credential digest. The credential file (0600) goes to the Agntei host only; it is never pasted into LeadCommand.' },
      { id: 'principal', title: 'Register the principal (SQL editor, as an org owner)', who: 'owner', kind: 'sql',
        command: `insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)\nvalues (${q(agent_id)}, ${q(org_id)}, ${q(name)}, ${q(ceo)}, '<DIGEST FROM STEP 1>', now() + interval '30 days', 1, '{}', ${q(ceo)});`,
        note: 'The sponsor is the CEO user. Tier ceiling 1: Workforce actions are internal only.' },
      { id: 'grants', title: 'Grant the Workforce tools (standing T1 grants)', who: 'owner', kind: 'sql',
        command: `insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at) values\n${grants.join(',\n')};`,
        note: 'Owner-minted rows; registration itself grants nothing. Research spend is capped at $0.25 per day.' },
      { id: 'bind', title: 'Bind the employee to the principal (link window)', who: 'owner', kind: 'sql',
        command: `select workforce.employee_bind_principal(${q(org_id)}, ${q(employee?.employee_id)}, ${q(agent_id)}, ${q(ceo)}, interval '${link_window_hours} hours');`,
        note: `The agent must link within ${link_window_hours} h. The binding lasts until the credential expires; workforce.employee_unbind ends it at once.` },
      { id: 'connect', title: 'Connect Agntei (operator)', who: 'operator', kind: 'agntei',
        command: `Agntei → Connections → add "LeadCommand Workforce": loopback HTTP to the Action MCP, Bearer = the contents of ~/.leadcommand/${agent_id}.credential; grant it to this one agent only.`,
        note: null },
      { id: 'link', title: 'First call: the agent links itself', who: 'agent', kind: 'mcp',
        command: `${mcpToolName('workforce_link_self')} { "client_request_id": "link-${agent_id.slice(4, 30)}-1", "external_install_id": "<AGNTEI INSTALL ID>", "external_agent_id": "<AGNTEI agent_… ID>" }`,
        note: 'Binds once: the same identity again is a no-op; a different one is refused (IDENTITY_MISMATCH) and suspends the grants.' },
    ],
  }
}
