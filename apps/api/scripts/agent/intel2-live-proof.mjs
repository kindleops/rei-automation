// LOCAL live-quality proof for Intelligence 2.0 increment A (never run in production).
//   A: "What's good bro?"  → conversational fast path (one Haiku call, no tools)
//   B: public listing status of one real address (web_search on)
// Real provider key from the environment (never printed). LeadCommand reads go through the
// guarded GET-only read client; the agent store is the in-memory twin (no production writes).
// Output: latency, cost, model calls, searches, citations; text redacted with REDACT_FILE tokens.
//
//   node --import ./tests/register-aliases.mjs scripts/agent/intel2-live-proof.mjs "<address>"
import { readFileSync } from 'node:fs'
import { createAnthropicProvider } from '../../src/lib/ai/anthropic-provider.js'
import { createResearchMemoryStore } from '../../src/lib/agent/research/research-store.js'
import { createResearchToolRegistry } from '../../src/lib/agent/research/research-tools.js'
import { createModelResolver } from '../../src/lib/agent/research/models.js'
import { createAskService } from '../../src/lib/agent/research/ask-service.js'
import { createQuickScanReadClient } from '../../src/lib/agent/quick-scan/read-client.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'

const address = process.argv[2]
const only = process.argv[3] || 'AB'
const OP = '00000000-0000-4000-8000-0000000000aa'
const env = { ...process.env, NODE_ENV: 'development', AGENT_ENABLED: '1', AGENT_LIVE_ROUTES: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_SPEND_GLOBAL_DAILY_USD: '0.5', AGENT_SPEND_USER_DAILY_USD: '0.5', AGENT_SPEND_CYCLE_USD: '0.5', AGENT_WEB_RESEARCH_ENABLED: '1' }
const tokens = (() => { try { return readFileSync(process.env.REDACT_FILE || '/dev/null', 'utf8').split(/[^A-Za-z]+/).filter((t) => t.length >= 3) } catch { return [] } })()
const redact = (s) => tokens.reduce((out, t) => out.replace(new RegExp(`\\b${t}\\b`, 'gi'), '[name]'), String(s ?? ''))

const provider = createAnthropicProvider({ env })
const store = createResearchMemoryStore({ limits: { day_usd: 0.5, cycle_usd: 0.5, run_usd: 0.5 } })
const ask = createAskService({ store, registry: createResearchToolRegistry(), provider, resolver: createModelResolver({ provider, env }), createServices: () => createQuickScanServices({ db: createQuickScanReadClient({ env }).client }), env })
const identity = { verified: true, named: true, user_id: OP, method: 'local_proof' }

async function run(label, question) {
  const t0 = Date.now()
  const { run_id, done } = await ask.ask({ operator_id: OP, identity, question })
  const events = []
  let firstText = null
  ask.subscribe(run_id, OP, {}, (e) => { if (e) { events.push(e.type); if (e.type === 'text_delta' && firstText == null) firstText = Date.now() - t0 } })
  const r = await done
  const s = await ask.status(run_id, OP)
  const ledger = store._state.ledger.filter((x) => x.run_id === run_id)
  const cites = s.result?.blocks?.find((b) => b.kind === 'web_citations')?.citations || []
  console.log(JSON.stringify({
    test: label,
    state: r.state, outcome: r.outcome, mode: s.mode, refusal: s.refusal,
    wall_ms: Date.now() - t0, run_latency_ms: s.latency_ms, first_text_ms: firstText,
    model_calls: s.counters.model_calls, tool_calls: s.counters.tool_calls, web_searches: s.counters.web_searches,
    cost_usd: s.cost_usd,
    ledger: ledger.map((x) => ({ state: x.state, reserved_usd: x.reserved_usd, actual_usd: x.actual_usd })),
    calls: s.calls.map((c) => ({ model: c.model, in: c.input_tokens, out: c.output_tokens, cache_read: c.cache_read_input_tokens, web_search_requests: c.web_search_requests, cost_usd: c.cost_usd, latency_ms: c.latency_ms, stop: c.stop })),
    tools: s.audit.filter((a) => a.kind === 'tool_call').map((a) => `${a.name}:${a.outcome}:${a.rows_returned}`),
    event_types: [...new Set(events)],
    citations: cites.map((c) => ({ url: c.url, title: redact(c.title), retrieved_at: c.retrieved_at })),
    result_kinds: s.result?.blocks?.map((b) => b.kind) || [],
    answer: redact(s.answer?.answer_md || '').slice(0, 1200),
  }, null, 2))
}

if (only.includes('A')) await run('A_greeting', "What's good bro?")
if (only.includes('B') && address) await run('B_web_listing', `What is the current public listing status of ${address}? Is it listed for sale or recently sold? Use the public web.`)
