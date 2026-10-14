// Intelligence Command 2.0, increment A: the conversational fast path, public-web
// research (domain policy, cost accounting from usage, audit), live run events
// (ordering, SSE route), cancel (reserve settles as counted), and the typed result
// schema. No network: provider, read client and store are injected doubles.
import test from 'node:test'
import assert from 'node:assert/strict'

import { OWNER, makeTables, fakeDb, fakeServices, fakeProvider, toolUse, reply, answer, usage, LISTED_MODELS } from '../helpers/agent-research-fake.mjs'
import { authHeaders, makeToken } from '../helpers/agent-test-identity.mjs'
import { createAgentIdentityProvider } from '../../src/lib/agent/security/agent-auth.js'
import { createUserRateLimiter } from '../../src/lib/agent/security/rate-limit.js'
import { createResearchMemoryStore } from '../../src/lib/agent/research/research-store.js'
import { createResearchToolRegistry, toApiName } from '../../src/lib/agent/research/research-tools.js'
import { createModelResolver, actualUsd } from '../../src/lib/agent/research/models.js'
import { createAskService, joinText } from '../../src/lib/agent/research/ask-service.js'
import { isConversational, CONVERSATION_LIMITS } from '../../src/lib/agent/research/conversation.js'
import { webToolsFor, isBlockedUrl, webWorstCase, extractWebEvidence, WEB_BLOCKED_DOMAINS, WEB_LIMITS, WEB_SEARCH_USD } from '../../src/lib/agent/research/web-research.js'
import { validateResultInput, buildResult, isValidEnvelope, RESULT_TOOL, RESULT_KINDS } from '../../src/lib/agent/research/result-schema.js'
import { createRunEvents, refusalClass, TERMINAL_EVENTS } from '../../src/lib/agent/research/run-events.js'
import * as RR from '../../src/lib/agent/research/research-routes.js'
import { ensureMutationAuth } from '../../src/app/api/cockpit/_shared.js'

const ENV = Object.freeze({ NODE_ENV: 'development', AGENT_ENABLED: '1', AGENT_LIVE_ROUTES: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '10', AGENT_SPEND_CYCLE_USD: '150', AGENT_STORE: 'postgres' })
const WEB_ENV = Object.freeze({ ...ENV, AGENT_WEB_RESEARCH_ENABLED: '1' })
const IDENTITY = Object.freeze({ verified: true, named: true, user_id: OWNER, method: 'supabase_jwt' })

function make({ script, env = ENV, store = createResearchMemoryStore(), provider = null } = {}) {
  const db = fakeDb(makeTables())
  const p = provider || fakeProvider(script)
  const resolver = createModelResolver({ provider: p, env })
  const ask = createAskService({ store, registry: createResearchToolRegistry(), provider: p, resolver, createServices: () => fakeServices(db), env })
  return { ask, store, provider: p }
}

/** A provider that replays raw stream events through onEvent (like MessageStream does), then returns the message. */
function streamingProvider(steps) {
  const calls = []
  let n = 0
  return {
    calls,
    async listModels() { return LISTED_MODELS.map((m) => ({ ...m })) },
    async createMessage(body, { signal, onEvent } = {}) {
      calls.push(JSON.parse(JSON.stringify(body)))
      const step = steps[Math.min(n, steps.length - 1)]
      n += 1
      if (typeof step === 'function') return step(body, { signal, onEvent })
      for (const ev of step.events || []) onEvent?.(ev)
      return step.message
    },
  }
}

const textEvents = (text) => [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...text.match(/.{1,7}/gs).map((d) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_stop' },
]

const webUsage = (searches, i = 9000, o = 300) => ({ ...usage(i, o), server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } })
const LISTING = 'https://www.example-listings.com/homes/123-main-st'
function webMessage({ searches = 1, results = [{ url: LISTING, title: 'Main St listing', page_age: '2 days ago' }], text = 'Public web: the listing shows Active.' } = {}) {
  const content = []
  for (let i = 0; i < searches; i += 1) {
    content.push({ type: 'server_tool_use', id: `srv_${i}`, name: 'web_search', input: { query: `123 main st listing ${i}` } })
    content.push({ type: 'web_search_tool_result', tool_use_id: `srv_${i}`, content: results.map((r) => ({ type: 'web_search_result', encrypted_content: 'x', ...r })) })
  }
  content.push({ type: 'text', text, citations: [{ type: 'web_search_result_location', url: LISTING, title: 'Main St listing', cited_text: 'Active', encrypted_index: 'y' }] })
  return reply(content, 'end_turn', webUsage(searches))
}

// ── 1: conversational fast path ───────────────────────────────────────────────
test('fast path: "What\'s good bro?" ⇒ ONE model call, no tools, short prompt, low max_tokens; settled + audited', async () => {
  const { ask, store, provider } = make({ script: [answer('Not much, just keeping the pipeline warm. Want me to dig into anything?', usage(120, 20))] })
  const { run_id, done, mode } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: "What's good bro?" })
  assert.equal(mode, 'conversation')
  const r = await done
  assert.equal(r.state, 'completed')
  assert.equal(provider.calls.length, 1)
  const body = provider.calls[0]
  assert.equal(body.tools, undefined, 'no tools are offered on the fast path')
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.max_tokens, CONVERSATION_LIMITS.max_tokens)
  assert.ok(body.max_tokens <= 200)
  const sys = body.system.map((b) => b.text).join('\n')
  assert.match(sys, /Do not list your capabilities/)
  assert.doesNotMatch(sys, /READ-ONLY research assistant/, 'the research rules (and their disclaimer) are not sent')
  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') < 2000)
  const led = store._state.ledger
  assert.equal(led.length, 1)
  assert.equal(led[0].state, 'settled')
  assert.equal(led[0].actual_usd, actualUsd('claude-haiku-5-5', usage(120, 20)).usd)
  assert.ok(led[0].reserved_usd >= led[0].actual_usd)
  const s = await ask.status(run_id, OWNER)
  assert.equal(s.mode, 'conversation')
  assert.equal(s.counters.tool_calls, 0)
  assert.deepEqual(s.audit.map((a) => a.kind), ['run_start', 'model_call', 'run_end'])
  assert.equal(s.audit[0].name, 'research.converse')
  assert.match(s.answer.answer_md, /pipeline/)
})

test('fast path classifier: greetings / thanks only; any research cue, context or length goes to the research loop', () => {
  for (const q of ["What's good bro?", 'yo', 'hey there', 'thanks!', 'how is it going', 'good morning', 'sup'] ) assert.equal(isConversational(q), true, q)
  for (const q of ["what's good with the Dallas campaign", 'hey how many hot leads today', 'hi, check property 123456', 'thanks, now compare these', 'yo send a text to the seller', 'What is the listing status of 12 Main St', 'hello '.repeat(20)]) assert.equal(isConversational(q), false, q)
  assert.equal(isConversational('hey', { property_ids: ['123456'] }), false, 'context attached ⇒ research')
  assert.equal(isConversational('hey', { campaign_id: '11111111-1111-4111-8111-111111111111' }), false)
})

test('fast path: every gate still applies — the budget refuses before the provider is called', async () => {
  const { ask, provider } = make({ script: [answer('hi')], store: createResearchMemoryStore({ limits: { day_usd: 0 } }) })
  const { done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'hey' })
  const r = await done
  assert.equal(r.state, 'refused')
  assert.equal(r.outcome, 'AGENT_SPEND_CAP_DAY')
  assert.equal(provider.calls.length, 0)
})

// ── 2: web research policy ─────────────────────────────────────────────────
test('web policy: off by default; when on, web_search carries blocked_domains (never allowed+blocked), bounded max_uses', () => {
  assert.deepEqual(webToolsFor({ env: ENV }), [])
  const tools = webToolsFor({ env: WEB_ENV })
  assert.equal(tools.length, 1, 'web_fetch needs its own flag')
  const s = tools[0]
  assert.equal(s.name, 'web_search')
  assert.match(s.type, /^web_search_\d{8}$/)
  assert.equal(s.max_uses, WEB_LIMITS.search_uses_per_call)
  assert.ok(Array.isArray(s.blocked_domains) && s.blocked_domains.length > 10)
  assert.equal(s.allowed_domains, undefined)
  // the run budget shrinks the offer, and an exhausted budget offers nothing
  assert.equal(webToolsFor({ env: WEB_ENV, used: { searches: WEB_LIMITS.search_uses_per_run - 1, fetches: 0 } })[0].max_uses, 1)
  assert.deepEqual(webToolsFor({ env: WEB_ENV, used: { searches: WEB_LIMITS.search_uses_per_run, fetches: 0 } }), [])
  const both = webToolsFor({ env: { ...WEB_ENV, AGENT_WEB_FETCH_ENABLED: '1' } })
  assert.deepEqual(both.map((t) => t.name), ['web_search', 'web_fetch'])
  assert.equal(both[1].max_content_tokens, WEB_LIMITS.fetch_max_content_tokens)
  assert.deepEqual(webToolsFor({ env: { ...ENV, AGENT_WEB_FETCH_ENABLED: '1' } }), [], 'fetch alone never turns web on')
})

test('web policy: login court portals, paywalls and people-search sites are blocked; non-http URLs are blocked', () => {
  for (const u of ['https://pacer.uscourts.gov/x', 'https://ecf.txnd.uscourts.gov/cgi-bin', 'https://www.wsj.com/articles/a', 'https://www.whitepages.com/name/x', 'https://www.truepeoplesearch.com/find', 'ftp://example.com/a', 'not a url']) assert.equal(isBlockedUrl(u), true, u)
  for (const u of ['https://www.zillow.com/homedetails/x', 'https://www.redfin.com/TX/Dallas/x', 'https://www.dallascounty.org/notice']) assert.equal(isBlockedUrl(u), false, u)
  assert.ok(WEB_BLOCKED_DOMAINS.includes('pacer.gov') && WEB_BLOCKED_DOMAINS.includes('spokeo.com'))
  const ev = extractWebEvidence(webMessage({ results: [{ url: 'https://www.spokeo.com/person', title: 'People' }, { url: LISTING, title: 'Main St listing' }] }))
  assert.deepEqual(ev.citations.map((c) => c.url), [LISTING], 'a blocked result never becomes a citation')
})

test('web cost: reserve covers searches + inflated tokens; settled = usage tokens × tier + web_search_requests × $0.01', async () => {
  const msg = webMessage({ searches: 2 })
  const { ask, store, provider } = make({ env: WEB_ENV, script: [msg] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'What is the public listing status of 123 Main St, Dallas TX?' })
  const r = await done
  assert.equal(r.state, 'completed')
  const body = provider.calls[0]
  const offered = body.tools.find((t) => t.name === 'web_search')
  assert.ok(offered && offered.blocked_domains.length)
  assert.equal(body.tools.at(-1).cache_control.type, 'ephemeral')
  const row = store._state.ledger[0]
  const expected = Number((actualUsd('claude-haiku-5-5', msg.usage).usd + 2 * WEB_SEARCH_USD).toFixed(6))
  assert.equal(row.actual_usd, expected, 'settled from the usage counts')
  assert.ok(row.reserved_usd >= row.actual_usd, 'reserve ≥ actual')
  assert.ok(row.reserved_usd >= offered.max_uses * WEB_SEARCH_USD, 'the reserve includes every offered search fee')
  const w = webWorstCase({ promptTokensBound: 10_000, offered: { searches: 3, fetches: 0 } })
  assert.equal(w.fee_usd, 0.03)
  assert.ok(w.extra_prompt_tokens >= 3 * WEB_LIMITS.search_result_tokens_bound)
  const s = await ask.status(run_id, OWNER)
  const webRows = s.audit.filter((a) => a.kind === 'tool_call' && a.name === 'web.search')
  assert.equal(webRows.length, 2, 'one audit row per counted search')
  assert.ok(webRows.every((a) => a.cost_usd === WEB_SEARCH_USD && a.outcome === 'ok' && /^[0-9a-f]{64}$/.test(a.params_sha256)))
  assert.equal(s.counters.web_searches, 2)
  assert.equal(s.calls[0].web_search_requests, 2)
  // typed result: public web citations are kept apart from internal evidence
  assert.ok(isValidEnvelope(s.result))
  const cites = s.result.blocks.find((b) => b.kind === 'web_citations')
  assert.equal(cites.citations[0].url, LISTING)
  assert.equal(cites.citations[0].title, 'Main St listing')
  assert.match(cites.citations[0].retrieved_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(s.result.evidence.public_web.map((c) => c.url), [LISTING])
  assert.deepEqual(s.result.evidence.internal.tools, [])
})

test('web honesty: a search is never claimed unless usage counts it (content alone is not proof)', async () => {
  const m = webMessage({ searches: 1 })
  m.usage = usage(9000, 300) // no server_tool_use counts
  const { ask, store } = make({ env: WEB_ENV, script: [m] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Is 123 Main St listed publicly?' })
  await done
  const s = await ask.status(run_id, OWNER)
  assert.equal(s.audit.filter((a) => a.name === 'web.search').length, 0)
  assert.equal(s.counters.web_searches, 0)
  assert.equal(store._state.ledger[0].actual_usd, actualUsd('claude-haiku-5-5', m.usage).usd, 'no search fee without a counted search')
})

test('web: off ⇒ no web tool is offered and none is reserved for', async () => {
  const { ask, provider, store } = make({ script: [answer('done')] })
  const { done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'What is the public listing status of 123 Main St?' })
  await done
  assert.ok(!provider.calls[0].tools.some((t) => /^web_/.test(t.name)))
  assert.ok(store._state.ledger[0].reserved_usd < 0.05)
})

test('web: pause_turn continues the provider turn with the content sent back unchanged', async () => {
  const paused = reply([{ type: 'server_tool_use', id: 'srv_0', name: 'web_search', input: { query: 'q' } }, { type: 'web_search_tool_result', tool_use_id: 'srv_0', content: [{ type: 'web_search_result', url: LISTING, title: 'L', encrypted_content: 'x' }] }], 'pause_turn', webUsage(1))
  const { ask, provider } = make({ env: WEB_ENV, script: [paused, answer('Public web: Active.')] })
  const { done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'listing status of 123 Main St?' })
  const r = await done
  assert.equal(r.state, 'completed')
  assert.equal(provider.calls.length, 2)
  assert.deepEqual(provider.calls[1].messages.at(-1), { role: 'assistant', content: paused.content })
})

// ── 3: live events ───────────────────────────────────────────────────────────
test('events: real backend order — run_start → model_call_start → tool_start/end → model_call_end … text_delta … completed', async () => {
  const toolMsg = reply([toolUse(toApiName('campaign.list'), {})], 'tool_use', usage(3000, 80))
  const provider = streamingProvider([
    { events: [{ type: 'message_start' }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'campaign__list' } }, { type: 'message_stop' }], message: toolMsg },
    { events: textEvents('There are 2 campaigns. Both are paused.\nNothing else to report.'), message: answer('There are 2 campaigns. Both are paused.\nNothing else to report.') },
  ])
  const { ask } = make({ provider })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Which campaigns exist?' })
  const seen = []
  ask.subscribe(run_id, OWNER, { after: 0 }, (ev) => { if (ev) seen.push(ev) })
  await done
  const types = seen.map((e) => e.type)
  assert.equal(types[0], 'run_start')
  assert.deepEqual(types.filter((t) => t !== 'text_delta'), ['run_start', 'model_call_start', 'model_call_end', 'tool_start', 'tool_end', 'model_call_start', 'model_call_end', 'completed'])
  // the streamed text arrives inside its model call, before the call ends
  const i2 = types.lastIndexOf('model_call_start'); const e2 = types.lastIndexOf('model_call_end')
  const deltas = seen.filter((e) => e.type === 'text_delta')
  assert.ok(deltas.length >= 2)
  assert.ok(deltas.every((d) => seen.indexOf(d) > i2 && seen.indexOf(d) < e2))
  assert.equal(deltas.map((d) => d.text).join(''), 'There are 2 campaigns. Both are paused.\nNothing else to report.')
  assert.equal(seen.find((e) => e.type === 'tool_start').tool, 'campaign.list')
  assert.ok(seen.every((e, i) => i === 0 || e.seq > seen[i - 1].seq), 'strictly increasing seq')
  const end = seen.at(-1)
  assert.equal(end.state, 'completed')
  assert.match(end.answer_md, /2 campaigns/)
  assert.equal(seen.filter((e) => TERMINAL_EVENTS.includes(e.type)).length, 1)
  assert.ok(!JSON.stringify(seen).match(/percent|progress|%/), 'no invented progress')
  // a late subscriber (after the run ended) replays the same log
  const replay = []
  ask.subscribe(run_id, OWNER, { after: 2 }, (ev) => { if (ev) replay.push(ev.type) })
  assert.deepEqual(replay, types.slice(2))
  assert.equal(ask.subscribe(run_id, 'someone-else', {}, () => {}), null, 'owner-only')
})

test('events: streamed text is masked; a contact-shaped chunk stops the live stream (the final answer is masked again)', async () => {
  const text = 'Call them. The number is 214 555 0199 today.\nDone.'
  const provider = streamingProvider([{ events: textEvents(text), message: answer(text) }])
  const { ask } = make({ provider })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Summarize campaign health' })
  const seen = []
  ask.subscribe(run_id, OWNER, {}, (ev) => { if (ev) seen.push(ev) })
  await done
  const streamed = seen.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')
  assert.doesNotMatch(streamed, /214 555 0199|2145550199/)
  assert.doesNotMatch(seen.at(-1).answer_md, /214 555 0199/)
})

test('events: web search status comes from the provider stream; the count comes from usage', async () => {
  const msg = webMessage({ searches: 1 })
  const provider = streamingProvider([{ events: [{ type: 'message_start' }, { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_0', name: 'web_search' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }], message: msg }])
  const { ask } = make({ provider, env: WEB_ENV })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Is 123 Main St listed?' })
  const seen = []
  ask.subscribe(run_id, OWNER, {}, (ev) => { if (ev) seen.push(ev) })
  await done
  const ws = seen.find((e) => e.type === 'web_search')
  assert.equal(ws.searches, 1)
  const st = seen.find((e) => e.type === 'tool_start' && e.tool === 'web_search')
  assert.ok(st && st.provider_executed)
  assert.ok(seen.indexOf(st) < seen.indexOf(ws))
})

test('events: a failed run ends with failed + its refusal class', async () => {
  const err = Object.assign(new Error('x'), { code: 'PROVIDER_READ_TIMEOUT', billed: 'unknown', phase: 'stream' })
  const { ask } = make({ script: [err] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Which campaigns exist?' })
  const seen = []
  ask.subscribe(run_id, OWNER, {}, (ev) => { if (ev) seen.push(ev) })
  await done
  const end = seen.at(-1)
  assert.equal(end.type, 'failed')
  assert.equal(end.refusal_class, 'timeout')
  assert.equal(refusalClass('AGENT_SPEND_CAP_DAY'), 'budget')
  assert.equal(refusalClass('PROVIDER_AUTH'), 'configuration')
  assert.equal(refusalClass('CANCELLED'), 'cancelled')
})

test('events: the bus caps text deltas, never the terminal event', () => {
  const ev = createRunEvents()
  for (let i = 0; i < 5000; i += 1) ev.push('text_delta', { text: 'x' })
  ev.push('completed', { state: 'completed' })
  assert.equal(ev.events.at(-1).type, 'completed')
  assert.ok(ev.dropped > 0)
  assert.equal(ev.push('text_delta', { text: 'late' }), null, 'nothing after the terminal event')
})

// ── 4: SSE route ────────────────────────────────────────────────────────────
function identity() {
  return createAgentIdentityProvider({ env: { OPS_ALLOWED_USER_IDS: OWNER }, verifyToken: async (token) => ({ id: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub, is_anonymous: false }) })
}
const BASE = 'http://localhost:3000/api/cockpit/agent/live/ask'
const req = (path = '', { method = 'GET', headers = authHeaders(OWNER), body } = {}) => new Request(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
const opts = (r, extra = {}) => ({ env: ENV, auth: ensureMutationAuth, identity: identity(), limiter: createUserRateLimiter({ limits: { mutation_per_min: 1000, read_per_min: 1000, daily_runs: 100 } }), research: r, ...extra })

function parseSse(text) {
  return text.split('\n\n').filter((f) => f.includes('data: ')).map((f) => {
    const type = /event: (.*)/.exec(f)?.[1]
    return { type, data: JSON.parse(/data: (.*)/.exec(f)[1]) }
  })
}

test('SSE route: text/event-stream of the run events in order, ending at the terminal event; poll endpoint unchanged', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const provider = streamingProvider([async (_b, { onEvent }) => { await gate; for (const e of textEvents('All quiet. Nothing is due.')) onEvent?.(e); return answer('All quiet. Nothing is due.') }])
  const r = make({ provider })
  const res = await RR.handleResearchAsk(req('', { method: 'POST', body: { question: 'Anything due in the pipeline?' } }), opts(r))
  assert.equal(res.status, 202)
  const { run_id } = await res.json()
  const sse = await RR.handleResearchEvents(req(`/${run_id}/events`), { ...opts(r), params: { run_id } })
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type'), /^text\/event-stream/)
  release()
  const frames = parseSse(await sse.text())
  const types = frames.map((f) => f.type)
  assert.equal(types[0], 'run_start')
  assert.equal(types.at(-1), 'completed')
  assert.ok(types.includes('model_call_start') && types.includes('text_delta') && types.includes('model_call_end'))
  // ?after= resumes; a stranger gets 404 from the prologue (allowlist) or an empty stream
  const resumed = parseSse(await (await RR.handleResearchEvents(req(`/${run_id}/events?after=${frames.at(-2).data.seq}`), { ...opts(r), params: { run_id } })).text())
  assert.deepEqual(resumed.map((f) => f.type), ['completed'])
  const poll = await (await RR.handleResearchRun(req(`/${run_id}`), { ...opts(r), params: { run_id } })).json()
  assert.equal(poll.state, 'completed')
  assert.ok(isValidEnvelope(poll.result))
  assert.equal((await RR.handleResearchEvents(req('/nope/events'), { ...opts(r), params: { run_id: 'nope' } })).status, 404)
})

test('SSE route: a run this process does not hold ⇒ the durable snapshot + its terminal event', async () => {
  const r = make({ script: [answer('ok')] })
  const { run_id, done } = await r.ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Which campaigns exist?' })
  await done
  const fresh = { ...r, ask: { ...r.ask, subscribe: () => null } } // simulates another instance
  const frames = parseSse(await (await RR.handleResearchEvents(req(`/${run_id}/events`), { ...opts(fresh), params: { run_id } })).text())
  assert.deepEqual(frames.map((f) => f.type), ['snapshot', 'completed'])
  assert.equal(frames[1].data.from, 'durable_status')
})

// ── 5: cancel ───────────────────────────────────────────────────────────────
test('cancel: aborts the in-flight call, no further model / tool call, reserve stays counted (unknown), run ends cancelled', async () => {
  const provider = streamingProvider([(_b, { signal }) => new Promise((_res, rej) => {
    signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'PROVIDER_ABORTED', billed: 'unknown', phase: 'stream' })), { once: true })
  })])
  const r = make({ provider })
  const res = await RR.handleResearchAsk(req('', { method: 'POST', body: { question: 'Which campaigns exist?' } }), opts(r))
  const { run_id } = await res.json()
  await new Promise((x) => setTimeout(x, 20))
  const c = await RR.handleResearchCancel(req(`/${run_id}/cancel`, { method: 'POST' }), { ...opts(r), params: { run_id } })
  assert.equal(c.status, 202)
  const run = r.ask.active.get(run_id)
  const seen = []
  r.ask.subscribe(run_id, OWNER, {}, (ev) => { if (ev) seen.push(ev) })
  await new Promise((x) => setTimeout(x, 30))
  assert.equal(run ? r.ask.active.has(run_id) : false, false)
  const s = await r.ask.status(run_id, OWNER)
  assert.equal(s.state, 'cancelled')
  assert.equal(s.outcome, 'CANCELLED')
  assert.equal(provider.calls.length, 1, 'no further model call')
  const led = r.store._state.ledger
  assert.equal(led.length, 1)
  assert.equal(led[0].state, 'unknown', 'an aborted call is never released on a guess: counted at its reserve')
  assert.ok(!led.some((x) => x.state === 'reserved'), 'nothing left open')
  assert.equal(seen.at(-1).type, 'cancelled')
  // cancelling again: the run has ended
  assert.equal((await RR.handleResearchCancel(req(`/${run_id}/cancel`, { method: 'POST' }), { ...opts(r), params: { run_id } })).status, 409)
})

test('cancel: between steps ⇒ no reserve is opened for the next call', async () => {
  let r
  const provider = streamingProvider([
    () => { r.ask.cancel([...r.ask.active.keys()][0], OWNER); return reply([toolUse(toApiName('campaign.list'), {})], 'tool_use', usage(3000, 50)) },
    { events: [], message: answer('never') },
  ])
  r = make({ provider })
  const { run_id, done } = await r.ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Which campaigns exist?' })
  const out = await done
  assert.equal(out.state, 'cancelled')
  assert.equal(provider.calls.length, 1)
  assert.equal(r.store._state.ledger.length, 1)
  assert.equal(r.store._state.ledger[0].state, 'settled', 'the finished call settles from usage')
  const s = await r.ask.status(run_id, OWNER)
  assert.equal(s.audit.filter((a) => a.kind === 'tool_call').length, 0, 'the queued tool never ran')
  assert.equal(r.ask.cancel(run_id, 'intruder').ok, false)
})

// ── 6: typed results ─────────────────────────────────────────────────────────
test('schema: kinds are versioned; property_research validates; public_web facts need a server-observed URL', () => {
  assert.deepEqual([...RESULT_KINDS], ['answer', 'property_research', 'web_citations', 'conversation_summary', 'campaign_audience_preview', 'approval_preview'])
  const observed = new Set([LISTING])
  const ok = validateResultInput({ kind: 'property_research', title: '123 Main St', facts: [{ label: 'Listing', value: 'Active', evidence: 'public_web', source: LISTING }, { label: 'Owner type', value: 'Individual', evidence: 'internal', source: 'eg.ownership' }], listing_status: { status: 'Active', source_url: LISTING, as_of: '2026-10-13' } }, { observedUrls: observed })
  assert.equal(ok.ok, true)
  assert.equal(ok.block.facts.length, 2)
  assert.equal(validateResultInput({ kind: 'property_research', title: 'x', facts: [{ label: 'L', value: 'v', evidence: 'public_web', source: 'https://made-up.example/x' }] }, { observedUrls: observed }).code, 'RESULT_WEB_SOURCE_UNOBSERVED')
  assert.equal(validateResultInput({ kind: 'property_research', title: 'x', listing_status: { status: 'Active', source_url: 'https://made-up.example' } }, { observedUrls: observed }).code, 'RESULT_WEB_SOURCE_UNOBSERVED')
  assert.equal(validateResultInput({ kind: 'property_research', title: 'x', facts: [{ label: 'L', value: 'v', evidence: 'vibes' }] }).code, 'RESULT_FACT_SHAPE')
  assert.equal(validateResultInput({ kind: 'web_citations', title: 'x' }).code, 'RESULT_KIND_UNKNOWN', 'citations are server-built only')
  assert.equal(validateResultInput({ kind: 'nope', title: 'x' }).code, 'RESULT_KIND_UNKNOWN')
  assert.equal(validateResultInput({ kind: 'conversation_summary', title: 'x', extra: 1 }).code, 'RESULT_FIELD_UNKNOWN')
  assert.equal(validateResultInput({ kind: 'conversation_summary' }).code, 'RESULT_TITLE_REQUIRED')
  const ap = validateResultInput({ kind: 'approval_preview', title: 'Pause campaign', action: 'pause campaign' })
  assert.equal(ap.block.executed, false)
  assert.equal(ap.block.requires_approval, true)
  assert.equal(validateResultInput({ kind: 'campaign_audience_preview', title: 'x', estimated_count: -1 }).code, 'RESULT_COUNT_SHAPE')
  assert.equal(validateResultInput({ kind: 'campaign_audience_preview', title: 'x' }).block.created, false)
  const env = buildResult({ answerMd: 'hi', citations: [{ url: LISTING, title: 'L', retrieved_at: '2026-10-13T00:00:00.000Z', source: 'web_search' }], internal: { tools: ['eg.property_core'], property_ids: ['123456'] } })
  assert.equal(isValidEnvelope(env), true)
  assert.deepEqual(env.blocks.map((b) => b.kind), ['answer', 'web_citations'])
  assert.deepEqual(env.evidence.internal.tools, ['eg.property_core'])
  assert.equal(isValidEnvelope({ ...env, version: 2 }), false)
})

test('schema: present_result as the final step ends the run with a typed card (masked, stored, re-read)', async () => {
  const final = reply([{ type: 'text', text: 'Here is the card.' }, toolUse(RESULT_TOOL, { kind: 'property_research', title: 'Property 123456', property_id: '123456', facts: [{ label: 'Owner phone', value: 'reach at 214-555-0199', evidence: 'internal', source: 'eg.contact_map' }] })], 'tool_use', usage(3000, 120))
  const { ask, provider } = make({ script: [final] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Research property 123456', context: { property_ids: ['123456'] } })
  const r = await done
  assert.equal(r.state, 'completed')
  assert.equal(provider.calls.length, 1, 'no extra model call after the final card')
  assert.ok(provider.calls[0].tools.some((t) => t.name === RESULT_TOOL))
  const s = await ask.status(run_id, OWNER)
  const card = s.result.blocks.find((b) => b.kind === 'property_research')
  assert.equal(card.property_id, '123456')
  assert.doesNotMatch(JSON.stringify(card), /214-555-0199/, 'contact data in a card is masked before it is stored or shown')
  assert.equal(s.answer.answer_md, 'Here is the card.')
})

test('schema: an invalid present_result is refused (audited) and the model answers in Markdown instead', async () => {
  const bad = reply([toolUse(RESULT_TOOL, { kind: 'property_research', title: 'x', listing_status: { status: 'Active', source_url: 'https://invented.example/x' } })], 'tool_use', usage(3000, 60))
  const { ask, provider } = make({ script: [bad, answer('Markdown answer.')] })
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: IDENTITY, question: 'Research 123 Main St listing' })
  await done
  assert.equal(provider.calls.length, 2)
  const s = await ask.status(run_id, OWNER)
  assert.ok(s.audit.some((a) => a.kind === 'tool_refused' && a.name === RESULT_TOOL && a.outcome === 'RESULT_WEB_SOURCE_UNOBSERVED'))
  assert.deepEqual(s.result.blocks.map((b) => b.kind), ['answer'])
})

test('text join: citation spans concatenate; text after a tool block starts a new paragraph', () => {
  assert.equal(joinText([{ type: 'text', text: 'The home is ' }, { type: 'text', text: 'listed' }, { type: 'text', text: '.' }]), 'The home is listed.')
  assert.equal(joinText([{ type: 'text', text: 'Searching.' }, { type: 'server_tool_use' }, { type: 'web_search_tool_result' }, { type: 'text', text: 'Found it.' }]), 'Searching.\n\nFound it.')
})

void makeToken
