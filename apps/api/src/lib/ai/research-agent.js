// Server wiring for the read-only research agent (owner GO 10-10).
//
// The only module that joins the provider client (lib/ai/anthropic-provider.js)
// to lib/agent — lib/agent itself stays free of any provider SDK or key.
//   store     agent_api Postgres pool ONLY (AGENT_STORE=postgres is required in
//             production by the route gate; the pool refuses postgres/service
//             roles and verifies TLS — live-agent.js agentPgPoolConfig). The store
//             also asserts the connected role is neither superuser nor BYPASSRLS.
//   provider  AGENT_ANTHROPIC_API_KEY (container secret)
//   models    resolved from GET /v1/models (cached 1 h), never guessed
//   tools     the sealed read-only research registry over the guarded read client
import { createAnthropicProvider } from './anthropic-provider.js'
import { getAgentPgPool, liveStoreKind, assertAgentPoolTls } from '@/lib/agent/live/live-agent.js'
import { isProductionRuntime } from '@/lib/agent/config/agent-config.js'
import { createResearchPgStore } from '@/lib/agent/research/research-store.js'
import { createResearchToolRegistry } from '@/lib/agent/research/research-tools.js'
import { createModelResolver } from '@/lib/agent/research/models.js'
import { createAskService } from '@/lib/agent/research/ask-service.js'
import { createQuickScanReadClient } from '@/lib/agent/quick-scan/read-client.js'
import { createQuickScanServices } from '@/lib/agent/quick-scan/services.js'
import { AgentError } from '@/lib/agent/runtime/store.js'

const KEY = Symbol.for('lc.agent.research.agent')

function logLine(o) {
  // structured, redacted (research/pii.js redactForLog): codes, counts, hashed ids only
  try { console.info(JSON.stringify({ source: 'agent.research', ...o })) } catch { /* never throw from logging */ }
}

export function buildResearchAgent({ env = process.env, pool = null, provider = null, store = null, createServices = null } = {}) {
  const s = store || createResearchPgStore({ pool: pool || getAgentPgPool(env) })
  const p = provider || createAnthropicProvider({ env })
  const registry = createResearchToolRegistry()
  const resolver = createModelResolver({ provider: p, env, log: logLine })
  const services = createServices || (() => createQuickScanServices({ db: createQuickScanReadClient({ env }).client }))
  const ask = createAskService({ store: s, registry, provider: p, resolver, createServices: services, env, log: logLine })
  return { store: s, provider: p, registry, resolver, ask }
}

/** Process-wide research agent; fails closed when the durable store is not the agent_api Postgres store. */
export async function getResearchAgent({ env = process.env } = {}) {
  if (globalThis[KEY]) return globalThis[KEY]
  if (liveStoreKind(env) !== 'postgres') throw new AgentError('RESEARCH_STORE_REQUIRED', 'the research agent requires AGENT_STORE=postgres')
  const agent = buildResearchAgent({ env })
  if (isProductionRuntime(env)) {
    await assertAgentPoolTls(getAgentPgPool(env), env) // client-side verified TLS to the configured host (fail closed)
    await agent.store.assertLeastPrivilege()
  }
  // a run left 'running' by a previous container: its open reserves stay counted ('unknown')
  await agent.store.interruptStale({ olderThanMs: 10 * 60 * 1000 }).catch(() => 0)
  globalThis[KEY] = agent
  return agent
}

export function __resetResearchAgent() {
  delete globalThis[KEY]
}
