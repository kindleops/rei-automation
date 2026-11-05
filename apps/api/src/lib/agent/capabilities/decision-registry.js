// THE DECISION REGISTRY (Action MCP audit §0.3 / §13 D6 + D1).
//
// The one human decide path (POST /api/cockpit/agent/actions/approvals/:id/decide → approvals.decide) looks an
// approval's capability up in a registry. Until now that was the MODEL-FACING registry (FIRST_CAPABILITIES), so
// three kinds of approval could be FILED but never DECIDED (decide() found no spec and refused them as
// CAPABILITY_VERSION_CHANGED):
//   pipeline.grant_negotiation_envelope            an operator's negotiation envelope (envelope-approval.js)
//   pipeline.prepare_negotiation_send_authorization the distinct live-send authorization (send-authorization.js)
//   agent_actions.authorize_action                 one Action Gateway intent (action-gateway/approvals.js)
//
// They are DECIDE-ONLY: registered here so a human can decide them, and NEVER in the model tool list or the
// invoker (the plane's `registry` stays FIRST_CAPABILITIES). Their own prepare() refuses any non-operator
// source / any filer but the gateway, so registering them here opens no proposal path.
//
// HUMAN ONLY: decide() requires a verified, named, org-member identity (the route authenticates a Supabase
// session against the operator allowlist); a decide-only capability additionally refuses any identity that
// carries an agent marker (an Action Gateway principal can never decide, approve or deny).
import { createCapabilityRegistry } from './registry.js'
import { envelopeGrantCapability } from '../../domain/negotiation/envelope-approval.js'
import { sendAuthorizationCapability } from '../../domain/negotiation/send-authorization.js'
import { agentActionApprovalCapability } from '../../domain/action-gateway/approvals.js'

export const DECIDE_ONLY_CAPABILITIES = Object.freeze([envelopeGrantCapability, sendAuthorizationCapability, agentActionApprovalCapability])
export const DECIDE_ONLY_IDS = Object.freeze(DECIDE_ONLY_CAPABILITIES.map((c) => c.id))

export { isAgentIdentity } from '../security/identity.js'

/** The sealed registry the decide path reads: the model-facing specs + the decide-only ones. */
export function createDecisionRegistry(specs = []) {
  const reg = createCapabilityRegistry()
  const seen = new Set()
  for (const s of [...specs, ...DECIDE_ONLY_CAPABILITIES]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    reg.register(s)
  }
  return reg.seal()
}
