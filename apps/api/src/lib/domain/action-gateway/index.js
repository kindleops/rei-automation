// LeadCommand Action Gateway (phase 1) — the ONE execution service for agent mutations.
// docs/ACTION-MCP.md · supabase/migrations/PROPOSED_20261019160000_action_gateway.sql (PROPOSED, born OFF)
export { createActionGateway } from './gateway.js'
export { createActionCatalog, ACTIONS, READS, ACTION_NAMES, REQUESTED_TOOLS, NEVER_EXPOSED, HOLD_REASON_CODES } from './catalog.js'
export { createPostgrestActionStore } from './store-postgrest.js'
export { createGatewayReads, createGatewayServices, withReplyPolicyRead } from './ports.js'
export { credentialDigest, mintAgentCredential, AGENT_CREDENTIAL_RE } from './credentials.js'
export { agentActionApprovalCapability, createIntentApprovalReader, buildApprovalRequest, judgeApproval, approvalSnapshotOf } from './approvals.js'
export { ActionGatewayError, GATEWAY_ERROR_CLASSES } from './errors.js'
export * from './constants.js'
