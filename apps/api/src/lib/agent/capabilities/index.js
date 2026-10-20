// Capability plane wiring: the sealed registry of first capabilities, the
// invoker (enforcement), the approvals ledger, and the model-facing tool list.
//
// Gates (all default OFF): AGENT_ENABLED (Gate B kill switch) + AGENT_CAPABILITIES_ENABLED.
// Writes additionally need AGENT_CAPABILITIES_WRITES_ENABLED and the review-only switch
// lifted (AGENT_READ_ONLY, frozen ON in production builds — a reviewed code change).
// Secret: AGENT_CAPABILITY_SECRET (≥ 16 chars) seals thread refs; unset ⇒ unavailable.
import { createCapabilityRegistry, createCapabilityInvoker, describeCapability, capabilityGate } from './registry.js'
import { createCapabilityApprovals } from './approvals.js'
import { createThreadRefCodec } from './thread-ref.js'
import { createDomainServices, loadProductionDeps } from './services.js'
import { createPgCapabilityStore } from './stores.js'
import { isProductionRuntime } from '../config/agent-config.js'
import { campaignCapabilities } from './defs/campaigns.js'
import { inboxCapabilities } from './defs/inbox.js'
import { pipelineCapabilities } from './defs/pipeline.js'
import { platformCapabilities } from './defs/platform.js'
import { actionGatewayRequestCapabilities } from './defs/action-gateway-requests.js'
import { agentActionApprovalCapability, withActionGatewayServices } from '../../domain/action-gateway/approvals.js'

export { withActionGatewayServices }

// D1 (docs/ACTION-MCP-AUDIT.md §13): the Action Gateway's approval capability and its T2 human-request capabilities are
// registered here, so a named operator decides gateway approvals in production through the one decide path.
export const FIRST_CAPABILITIES = Object.freeze([...campaignCapabilities, ...inboxCapabilities, ...pipelineCapabilities, ...platformCapabilities, ...actionGatewayRequestCapabilities, agentActionApprovalCapability])
export const DEFAULT_ORG_ID = '00000000-0000-4000-8000-00000000a001'
export const CAPABILITY_SECRET_ENV = 'AGENT_CAPABILITY_SECRET'

export function createDefaultCapabilityRegistry(specs = FIRST_CAPABILITIES) {
  const registry = createCapabilityRegistry()
  for (const s of specs) registry.register(s)
  return registry.seal()
}

/** API tool names: dots are not allowed in tool names. */
export const toApiName = (id) => `cap__${id.replace(/\./g, '__')}`
export const fromApiName = (name) => (String(name).startsWith('cap__') ? String(name).slice(5).replace(/__/g, '.') : null)

/** Model-facing tool definitions. The tier is described, never a parameter. */
export function capabilityToolDefs(registry) {
  // capabilities only the Action Gateway files (prepare refuses) are decided by humans, never offered to a model
  return registry.list().filter((c) => c.filed_by !== 'action_gateway' && c.id !== agentActionApprovalCapability.id).map((c) => ({
    name: toApiName(c.id),
    description: `${c.description} [${c.side_effect}; ${c.tier === 'requires_explicit_approval' ? 'creates a pending approval only — a human decides' : c.tier}]`,
    input_schema: c.input_schema,
  })).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {{ env?, store, services, secret, now?, registry?, systemControlMode? }} o
 */
export function createCapabilityPlane({ env = process.env, store, services, secret, now = () => Date.now(), registry = createDefaultCapabilityRegistry(), systemControlMode = null }) {
  const refs = createThreadRefCodec({ secret })
  const svc = Object.freeze({ ...services, refs })
  const approvals = createCapabilityApprovals({ store, registry, services: svc, now })
  const invoker = createCapabilityInvoker({ registry, store, approvals, services: svc, env, now, systemControlMode })
  return Object.freeze({
    registry,
    invoker,
    approvals,
    store,
    services: svc,
    matrix: () => registry.list().map(describeCapability),
    toolDefs: () => capabilityToolDefs(registry),
  })
}

const PLANE = Symbol.for('lc.agent.capabilities.plane')

/** Process-wide production plane (agent_api pool). null when gated off or unconfigured. */
export async function getCapabilityPlane(env = process.env) {
  if (!capabilityGate(env).enabled) return null
  const secret = String(env?.[CAPABILITY_SECRET_ENV] || '')
  if (secret.length < 16) return null
  if (!globalThis[PLANE]) {
    const { getAgentPgPool, assertAgentPoolTls, getVerifiedRuntimeStore, getSystemValue } = await loadProductionDeps()
    const pool = getAgentPgPool(env)
    const store = createPgCapabilityStore({ pool })
    if (isProductionRuntime(env)) {
      // same posture as the runtime store: verified client TLS + a least-privilege role (agent_api)
      await assertAgentPoolTls(pool, env)
      await store.assertLeastPrivilege()
    }
    const services = withActionGatewayServices(createDomainServices({ runtimeStore: () => getVerifiedRuntimeStore(env) }), pool)
    globalThis[PLANE] = createCapabilityPlane({ env, store, services, secret, systemControlMode: () => getSystemValue('agent_mode') })
  }
  return globalThis[PLANE]
}

export function __resetCapabilityPlane() {
  delete globalThis[PLANE]
}
