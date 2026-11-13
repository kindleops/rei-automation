// The Workforce actions an Agntei agent uses through the Action Gateway (docs/WORKFORCE-AGNTEI.md §2). ONE list:
// the gateway catalog (domain/action-gateway/actions/workforce) registers exactly these, the MCP exposes them as
// leadcommand_<tool>, and the "Register an Agntei agent" steps render one standing grant per capability.
// All are T1 (internal): none reaches send / offer / stage / campaign / contact. Pure data.

export const WORKFORCE_GATEWAY_TOOLS = Object.freeze([
  Object.freeze({ tool: 'workforce_whoami', capability: 'workforce.whoami', kind: 'read' }),
  Object.freeze({ tool: 'workforce_list_assignments', capability: 'workforce.list_assignments', kind: 'read' }),
  Object.freeze({ tool: 'workforce_get_mission', capability: 'workforce.get_mission', kind: 'read' }),
  Object.freeze({ tool: 'workforce_link_self', capability: 'workforce.link_self', kind: 'write' }),
  Object.freeze({ tool: 'workforce_open_mission', capability: 'workforce.open_mission', kind: 'write' }),
  Object.freeze({ tool: 'workforce_claim_assignment', capability: 'workforce.claim_assignment', kind: 'write' }),
  Object.freeze({ tool: 'workforce_report_progress', capability: 'workforce.report_progress', kind: 'write' }),
  Object.freeze({ tool: 'workforce_complete_assignment', capability: 'workforce.complete_assignment', kind: 'write' }),
  Object.freeze({ tool: 'workforce_request_research', capability: 'workforce.request_research', kind: 'write', spends: true }),
  Object.freeze({ tool: 'workforce_handoff', capability: 'workforce.handoff', kind: 'write' }),
  Object.freeze({ tool: 'workforce_escalate', capability: 'workforce.escalate', kind: 'write' }),
])
export const WORKFORCE_TOOL_NAMES = Object.freeze(WORKFORCE_GATEWAY_TOOLS.map((t) => t.tool))
export const WORKFORCE_CAPABILITIES = Object.freeze(WORKFORCE_GATEWAY_TOOLS.map((t) => t.capability))
/** The MCP name of a gateway tool (leadcommand_ + the gateway name). */
export const mcpToolName = (tool) => `leadcommand_${tool}`
/** The Agntei agent's principal id suggested for an employee (agt_<the employee slug>). */
export const suggestedAgentId = (employee_id) => `agt_${String(employee_id || '').replace(/^emp_/, '').replace(/[^a-z0-9_]/g, '_').slice(0, 40)}`.replace(/^agt_$/, 'agt_agent')
