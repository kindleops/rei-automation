// Agent S1 — the model gateway refuses every call; no SDK, no network anywhere in lib/agent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelGateway, GATEWAY_HAS_PROVIDER_CLIENT } from '../../src/lib/agent/gateway/model-gateway.js'
import { MODEL_SWITCHES } from '../../src/lib/agent/config/agent-config.js'

const AGENT_DIR = fileURLToPath(new URL('../../src/lib/agent/', import.meta.url))

function agentFiles() {
  const out = []
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name))
      else if (/\.(m?js|sql)$/.test(f.name)) out.push(join(d, f.name))
    }
  }
  walk(AGENT_DIR)
  return out
}

test('S1 model switches are frozen OFF', () => {
  assert.equal(MODEL_SWITCHES.models_approved, false)
  assert.equal(MODEL_SWITCHES.opus_enabled, false)
  assert.equal(MODEL_SWITCHES.external_hold, true)
  assert.ok(Object.isFrozen(MODEL_SWITCHES))
  assert.throws(() => { 'use strict'; MODEL_SWITCHES.models_approved = true })
  assert.equal(GATEWAY_HAS_PROVIDER_CLIENT, false)
})

test('gateway refuses every call, reserves nothing, touches no network', async () => {
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => { fetched += 1; throw new Error('network forbidden') }
  try {
    const gw = createModelGateway({ env: { AGENT_MAX_MODE: 'full' }, systemControlMode: 'full' })
    for (const route of ['agent.intent', 'agent.turn', 'agent.plan', 'agent.synthesize', 'research.extract_structured']) {
      const r = await gw.call({ route, model: 'claude-haiku-4-5', data_classes: ['aggregates'] })
      assert.deepEqual([r.ok, r.refused, r.code, r.reserved_usd, r.network], [false, true, 'MODELS_DISABLED', 0, false])
    }
    assert.equal((await gw.stream({ route: 'agent.turn' })).code, 'MODELS_DISABLED')
    assert.equal(fetched, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('refusal order holds even if switches were injected on (no provider client exists)', async () => {
  const on = { models_approved: true, external_hold: true, opus_enabled: false }
  assert.equal((await createModelGateway({ switches: on }).call({ route: 'x' })).code, 'EXTERNAL_HOLD')
  const noHold = { ...on, external_hold: false }
  assert.equal((await createModelGateway({ switches: noHold }).call({ route: 'x', model: 'claude-opus-5' })).code, 'OPUS_DISABLED')
  assert.equal((await createModelGateway({ switches: noHold }).call({ route: 'x', model: 'claude-haiku-4-5', data_classes: ['seller_message_text'] })).code, 'PROCESSOR_NOT_AUTHORIZED')
  const proc = [{ processor: 'anthropic', enabled: true, allowed_data_classes: ['aggregates'] }]
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: {} }).call({ route: 'x', data_classes: ['aggregates'] })).code, 'MODE_OFF')
  const full = { AGENT_MAX_MODE: 'full' }
  // Gate B: a verified named user, then the spend guard ($0 until the owner sets caps), then still no client
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: full }).call({ route: 'x', data_classes: ['aggregates'] })).code, 'IDENTITY_REQUIRED')
  const me = { verified: true, named: true, user_id: '11111111-1111-4111-8111-111111111111', method: 'supabase_jwt' }
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: full }).call({ route: 'x', data_classes: ['aggregates'], identity: { ...me, verified: false } })).code, 'IDENTITY_REQUIRED')
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: full }).call({ route: 'x', data_classes: ['aggregates'], identity: me, worst_case_usd: 0.01 })).code, 'SPEND_CAP_USER_DAY')
  const capped = { ...full, AGENT_SPEND_USER_DAILY_USD: '1', AGENT_SPEND_GLOBAL_DAILY_USD: '1', AGENT_TOKENS_USER_DAILY: '100000', AGENT_TOKENS_GLOBAL_DAILY: '100000' }
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: capped }).call({ route: 'x', data_classes: ['aggregates'], identity: me })).code, 'SPEND_CAP_USER_DAY', 'no worst-case estimate ⇒ unbounded ⇒ refused')
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: capped }).call({ route: 'x', data_classes: ['aggregates'], identity: me, worst_case_usd: 0.01, max_input_tokens: 1000, max_tokens: 100 })).code, 'NO_PROVIDER_CLIENT')
  // the kill switch dominates everything, and is OFF by default in production
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: { ...capped, AGENT_ENABLED: '0' } }).call({ route: 'x', identity: me, worst_case_usd: 0.01 })).code, 'AGENT_DISABLED')
  assert.equal((await createModelGateway({ switches: noHold, processors: proc, env: { ...capped, NODE_ENV: 'production' } }).call({ route: 'x', identity: me, worst_case_usd: 0.01 })).code, 'AGENT_DISABLED')
})

test('import graph: lib/agent imports no provider SDK / HTTP client and never calls fetch', () => {
  const forbidden = [/from\s+['"]openai['"]/, /@anthropic-ai\//, /from\s+['"]groq/, /from\s+['"]axios['"]/, /from\s+['"]node:https?['"]/, /from\s+['"]https?['"]/, /\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /opencode-zen|big-pickle|ai-router/]
  const files = agentFiles().filter((f) => !f.endsWith('.sql'))
  assert.ok(files.length > 20)
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const re of forbidden) assert.ok(!re.test(src), `${f} matches ${re}`)
  }
})

test('the only dynamic imports in lib/agent are the lazy service resolvers (read adapters, capability domain services)', () => {
  const strip = (src) => src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const hits = agentFiles().filter((f) => f.endsWith('.js') && /(?<![\w.])import\s*\(/.test(strip(readFileSync(f, 'utf8'))))
  // RC 8.5.15: review/conversation-ai-control.js lazily resolves the runtime store + agent pool
  assert.deepEqual(hits.map((f) => f.replace(AGENT_DIR, '')).sort(), ['capabilities/services.js', 'review/conversation-ai-control.js', 'tools/adapters/_read-tool.js'])
  // every specifier is a static string literal (no computed module paths)
  for (const rel of ['capabilities/services.js', 'review/conversation-ai-control.js']) {
    const src = strip(readFileSync(`${AGENT_DIR}${rel}`, 'utf8'))
    for (const m of src.matchAll(/(?<![\w.])import\s*\(([^)]*)\)/g)) assert.match(m[1].trim(), /^'[@./][^']+'$/, `${rel}: ${m[0]}`)
  }
})
