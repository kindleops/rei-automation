// Conversation Engine 2.0 — operator review/control plane (shadow): read model, auth order, and
// "controls write only through agent.runtime_emergency_stop / agent.runtime_pause_kind".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  REVIEW_KIND, buildControlState, decodeInboundRef, jobInboundSids, normalizeJob, parseControlRequest, readShadowFlags, runControlAction,
} from '../../src/lib/domain/conversation-ai/review-control.js'
import { handleConversationAiControlGet, handleConversationAiControlPost } from '../../src/lib/agent/review/conversation-ai-control.js'
import { encodeRef } from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { SRC } from '../helpers/import-graph.mjs'

const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const okAuth = () => ({ ok: true })
const denyAuth = () => ({ ok: false, response: new Response(null, { status: 401 }) })
const okIdentity = { authenticate: async () => ({ ok: true, identity: { user_id: OP } }) }
const okLimiter = { check: () => ({ ok: true }) }
const post = (body) => new Request('http://x/api/cockpit/agent/conversation-ai/control', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const get = () => new Request('http://x/api/cockpit/agent/conversation-ai/control')

function spyStore() {
  const calls = []
  return {
    calls,
    emergencyStop: async (o) => { calls.push(['emergencyStop', o]); return { ok: true, emergency_stop: true } },
    pauseKind: async (o) => { calls.push(['pauseKind', o]); return { ok: true, kind: o.kind, enabled: false } },
    status: async () => ({ limits: { runtime_enabled: true, emergency_stop: false, kind_limits: { [REVIEW_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP, event_budget_cap_usd: 0.01 } }, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60 }, open: { queued: 1 }, ended_24h: { completed: 3 }, heartbeats: [{ worker_id: 'agent-runtime-tick', last_tick_at: '2026-10-14T10:00:00Z', age_s: 20, ticks: 9 }] }),
  }
}

test('flags are reported as booleans only; the shadow flag is exactly "true"', () => {
  const f = readShadowFlags({ AI_CONVERSATION_SHADOW_ENABLED: 'true', AGENT_RUNTIME_ENABLED: '1' }, { agentEnabled: true })
  assert.deepEqual(f, { ai_conversation_shadow_enabled: true, agent_runtime_enabled: true, agent_enabled: true, cron_agent_runtime_enabled: null })
  assert.equal(readShadowFlags({ AI_CONVERSATION_SHADOW_ENABLED: '1' }).ai_conversation_shadow_enabled, false)
  assert.equal(readShadowFlags({ CRON_AGENT_RUNTIME_ENABLED: 'false' }).cron_agent_runtime_enabled, false)
})

test('shadow is ON only when every gate is on; unknown when the runtime is unreadable', () => {
  const flags = { ai_conversation_shadow_enabled: true, agent_runtime_enabled: true, agent_enabled: true, cron_agent_runtime_enabled: null }
  const status = { limits: { runtime_enabled: true, emergency_stop: false, kind_limits: { [REVIEW_KIND]: { enabled: true, armed_by: OP } } } }
  assert.equal(buildControlState({ flags, status, budget: { enabled: true } }).shadow.state, 'on')
  assert.equal(buildControlState({ flags, status: { limits: { ...status.limits, emergency_stop: true } }, budget: { enabled: true } }).shadow.state, 'off')
  assert.equal(buildControlState({ flags, status, budget: { enabled: false } }).shadow.state, 'off')
  assert.equal(buildControlState({ flags: { ...flags, ai_conversation_shadow_enabled: false }, status, budget: { enabled: true } }).shadow.state, 'off')
  assert.equal(buildControlState({ flags, status: null, budget: null }).shadow.state, 'unknown')
  const s = buildControlState({ flags, status, budget: { enabled: true } })
  assert.equal(s.mode, 'shadow')
  assert.equal(s.send_path, 'none')
})

test('job rows normalize to codes only; inbound ref decodes and joins to the message id', () => {
  const sid = 'SM0123abc'
  const ref = encodeRef(sid)
  assert.equal(decodeInboundRef(ref), sid)
  assert.equal(decodeInboundRef('xyz'), null)
  assert.deepEqual(jobInboundSids([{ inbound_ref: ref }, { inbound_ref: ref }, { inbound_ref: null }]), [sid])
  const j = normalizeJob({ job_id: 'mjob_x', state: 'dead_letter', attempt: 3, max_attempts: 3, inbound_ref: ref, created_at: '2026-10-14T10:00:00Z', ended_at: '2026-10-14T10:00:02Z', last_error: { code: 'AGENT_MODEL_UNAVAILABLE', message: 'secret detail 555-123-4567' }, result: null }, new Map([[sid, 'evt-1']]))
  assert.equal(j.inbound_message_id, 'evt-1')
  assert.equal(j.error_code, 'AGENT_MODEL_UNAVAILABLE')
  assert.equal(j.wall_ms, 2000)
  assert.ok(!JSON.stringify(j).includes('555'))
})

test('control requests: only the two actions, confirm required, reason digit-stripped', () => {
  assert.equal(parseControlRequest({ action: 'resume', confirm: true }).code, 'ACTION_INVALID')
  assert.equal(parseControlRequest({ action: 'emergency_stop' }).code, 'CONFIRM_REQUIRED')
  const p = parseControlRequest({ action: 'emergency_stop', confirm: true, reason: 'call 555 123 4567 now' })
  assert.equal(p.ok, true)
  assert.ok(!/[0-9]/.test(p.reason))
})

test('runControlAction calls ONLY the runtime functions, with the verified operator', async () => {
  const s = spyStore()
  assert.equal((await runControlAction({ store: s, action: 'emergency_stop', by: OP, reason: 'x' })).ok, true)
  assert.equal((await runControlAction({ store: s, action: 'pause_kind', by: OP })).ok, true)
  assert.deepEqual(s.calls.map((c) => c[0]), ['emergencyStop', 'pauseKind'])
  assert.equal(s.calls[0][1].by, OP)
  assert.deepEqual(s.calls[1][1], { kind: REVIEW_KIND, by: OP })
})

test('against the runtime memory twin: emergency stop latches, pause disables the kind', async () => {
  const store = createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { [REVIEW_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  await runControlAction({ store, action: 'pause_kind', by: OP })
  await runControlAction({ store, action: 'emergency_stop', by: OP, reason: 'panel' })
  const st = await store.status()
  assert.equal(st.limits.emergency_stop, true)
  assert.equal(st.limits.kind_limits[REVIEW_KIND].enabled, false)
})

test('POST: dashboard auth → named operator → rate limit → runtime function', async () => {
  const s = spyStore()
  const runtime = async () => ({ store: s })
  assert.equal((await handleConversationAiControlPost(post({ action: 'emergency_stop', confirm: true }), { auth: denyAuth, identity: okIdentity, limiter: okLimiter, runtime })).status, 401)
  const noUser = { authenticate: async () => ({ ok: false, status: 403, code: 'OPERATOR_NOT_ALLOWLISTED' }) }
  assert.equal((await handleConversationAiControlPost(post({ action: 'emergency_stop', confirm: true }), { auth: okAuth, identity: noUser, limiter: okLimiter, runtime })).status, 403)
  const limited = { check: () => ({ ok: false, code: 'RATE_LIMITED', retry_after_s: 9 }) }
  assert.equal((await handleConversationAiControlPost(post({ action: 'emergency_stop', confirm: true }), { auth: okAuth, identity: okIdentity, limiter: limited, runtime })).status, 429)
  assert.equal((await handleConversationAiControlPost(post({ action: 'emergency_stop' }), { auth: okAuth, identity: okIdentity, limiter: okLimiter, runtime })).status, 422)
  assert.equal(s.calls.length, 0)
  const r = await handleConversationAiControlPost(post({ action: 'emergency_stop', confirm: true, reason: 'test' }), { auth: okAuth, identity: okIdentity, limiter: okLimiter, runtime })
  assert.equal(r.status, 200)
  assert.deepEqual(s.calls.map((c) => c[0]), ['emergencyStop'])
  const down = async () => { throw new Error('AGENT_DATABASE_URL_REQUIRED') }
  assert.equal((await handleConversationAiControlPost(post({ action: 'pause_kind', confirm: true }), { auth: okAuth, identity: okIdentity, limiter: okLimiter, runtime: down })).status, 503)
})

test('GET: read-only state with jobs joined to inbound ids; degrades to errors, never throws', async () => {
  const s = spyStore()
  const sid = 'SMabc'
  const queries = []
  const pool = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push(String(sql).trim().split(/\s+/).slice(0, 3).join(' '))
        if (/from agent\.research_limits/.test(sql)) return { rows: [{ enabled: true, day_usd: '10', cycle_usd: '150', run_usd: '2.5', spent_day: '0.04', spent_cycle: '1.2', spent_day_kind: '0.03' }] }
        if (/from agent\.research_job/.test(sql)) { assert.deepEqual(params, [REVIEW_KIND, 50]); return { rows: [{ job_id: 'mjob_1', state: 'completed', attempt: 1, max_attempts: 3, inbound_ref: encodeRef(sid), result: { code: 'RECORDED', outcome: 'REPLY_CANDIDATE', cost_usd: 0.004 } }] } }
        return { rows: [] }
      },
      release: () => {},
    }),
  }
  const supabase = { from: () => ({ select: () => ({ in: (_c, v) => ({ eq: () => ({ limit: async () => ({ data: v.map((x) => ({ id: 'evt-9', provider_message_sid: x })) }) }) }) }) }) }
  const env = { AI_CONVERSATION_SHADOW_ENABLED: 'true', AGENT_RUNTIME_ENABLED: '1', AGENT_ENABLED: '1' }
  const r = await handleConversationAiControlGet(get(), { env, auth: okAuth, runtime: async () => ({ store: s, pool }), supabase })
  const b = await r.json()
  assert.equal(r.status, 200)
  assert.equal(queries[0], 'begin read only')
  assert.equal(b.shadow.state, 'on')
  assert.equal(b.kind.max_concurrency, 1)
  assert.equal(b.budget.per_event_reserve_usd, 0.01)
  assert.equal(b.budget.day_cap_usd, 10)
  assert.equal(b.jobs[0].inbound_message_id, 'evt-9')
  assert.equal(s.calls.length, 0) // GET never controls
  const down = await handleConversationAiControlGet(get(), { env: {}, auth: okAuth, runtime: async () => { throw new Error('AGENT_DATABASE_URL_REQUIRED') } })
  const d = await down.json()
  assert.equal(down.status, 200)
  assert.equal(d.shadow.state, 'unknown')
  assert.deepEqual(d.errors, ['AGENT_DATABASE_URL_REQUIRED'])
  assert.equal((await handleConversationAiControlGet(get(), { auth: denyAuth })).status, 401)
})

test('static: the control module and route write nothing directly and import no send path', () => {
  for (const f of ['lib/agent/review/conversation-ai-control.js', 'lib/domain/conversation-ai/review-control.js', 'app/api/cockpit/agent/conversation-ai/control/route.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8')
    assert.ok(!/\b(insert\s+into|update\s+agent\.|delete\s+from|\.insert\(|\.update\(|\.upsert\(|\.delete\()/i.test(src), `${f} writes directly`)
    assert.ok(!/send[-_]?queue|sms-engine|textgrid|queueAutoReply/i.test(src.replace(/^\s*\/\/.*$/gm, '')), `${f} names a send path`)
  }
})
