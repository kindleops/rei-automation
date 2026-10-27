// Operation Hidden Gold — the ACCEPTANCE WORLD: one disposable PostgreSQL 17 database (the Action Gateway world,
// links #26–#29, the R3 / turn world, the reader link and its reads) served to three real processes at once:
//   * the LeadCommand READER MCP (live mode over a local PostgREST + the /rest/v1 gateway shim; role lc_mcp_reader),
//   * the LeadCommand ACTION MCP (the real app over the gateway role, one bearer credential per agent principal),
//   * LeadCommand's WORKER (the runtime tick executing handed-off intents; the REAL queue runner with a SIMULATED
//     provider: nothing leaves this machine — any fetch or TextGrid credential read aborts the dispatch).
// Plus a loopback CONTROL endpoint for the acceptance run: a simulated seller reply, a state dump, a tick.
// DISPOSABLE ONLY: AGENT_PG_TEST_DB_URL must name a local scratch server. Never production.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { applyInTransaction, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { t34Db } from '../helpers/action-gateway-t34-pg.mjs'
import { registerAgent, seedThread, setControls, sel, MIG, gatewayPool, humanApprovals, ORG, OWNER, OPERATOR, SELLER, SELLER_2, OURS } from '../helpers/action-gateway-pg.mjs'
import { pgSupabase } from '../helpers/pg-supabase.mjs'
import { seedT34, worker, replySwitches, liveDispatch, dispatchQueued } from '../helpers/action-gateway-t34-world.mjs'
import { simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { buildApp as buildActionApp } from '../../../../mcp/leadcommand-action-mcp/src/app.mjs'
import { startHttp as startActionHttp } from '../../../../mcp/leadcommand-action-mcp/src/protocol/http.mjs'
import { writeSecretFile } from '../../../../mcp/leadcommand-action-mcp/src/config.mjs'
import { captureColumns, wideningSql, mintHs256 } from '../../../../mcp/leadcommand-mcp/test/support/local-stack.mjs'
import { SCOPE_NAMES } from '../../../../mcp/leadcommand-mcp/src/authz/scopes.mjs'

__setAutomationHoldResolverForTests(null) // the REAL hold registry answers every hold check

const OUT = process.env.OHG_WORLD_DIR || path.join(process.env.TMPDIR || '/tmp', 'ohg-world')
const PORTS = { reader: Number(process.env.OHG_READER_PORT || 4871), action: Number(process.env.OHG_ACTION_PORT || 4872), control: Number(process.env.OHG_CONTROL_PORT || 4873) }
const POSTGREST = process.env.LC_POSTGREST_BIN || '/usr/local/bin/postgrest'
const log = (...a) => console.log(new Date().toISOString(), ...a)
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })
const secret = (name, value) => writeSecretFile(path.join(OUT, name), value)

// ── 1. the database: the gateway world + link #29 + the reader link and its reads ────────────────────────────
const env = await t34Db()
log('database', env.url.replace(/\/\/[^@]*@/, '//'))
await applyInTransaction(env.db.pool, MIG('PROPOSED_20261027120000_action_gateway_ohg.sql'))
await runSqlFile(env.db.pool, path.join(REPO_DIR, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_baseline.sql'))
try { await applyInTransaction(env.db.pool, path.join(REPO_DIR, 'scripts/db/fixtures/_widen_placeholder.sql')) } catch { /* none */ }
const widen = path.join(OUT, 'widening.sql')
fs.writeFileSync(widen, wideningSql(await captureColumns()))
const widenOk = []
// the chain baseline already models probate / preforeclosure as the production-shaped relations: never rebuilt here
for (const stmt of fs.readFileSync(widen, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('--') && !/probate|preforeclosure|census_geo_metrics/.test(l))) {
  try { await env.db.pool.query(stmt); widenOk.push(stmt.slice(0, 60)) } catch (e) { log('widen skipped:', stmt.slice(0, 80), '→', e.message.slice(0, 80)) }
}
for (const f of ['PROPOSED_20261019150000_lc_mcp_reader.sql', 'PROPOSED_20261026120000_lc_mcp_conversation_intel.sql', 'PROPOSED_20261026150000_lc_mcp_corpus_census.sql', ...(process.env.OHG_EXTRA_READER_LINKS || '').split(',').filter(Boolean)]) {
  try { await applyInTransaction(env.db.pool, MIG(f)); log('applied', f) } catch (e) { log('NOT applied', f, '→', e.message.slice(0, 160)) }
}

// ── 2. the world: org, operators, switches (AI sending ACTIVATED in this disposable database only) ───────────
await seedT34(env)
// the lead-state writer's audit trail (production table; the chain fixtures lack it): every pipeline change an agent causes is recorded here
await env.owner.query(`create table if not exists public.universal_lead_state_events (id uuid primary key default gen_random_uuid(), thread_key text, property_id text, field_name text, previous_value text, new_value text, operator_id text, source_view text, reason text, change_source text, executed_next_action boolean, created_at timestamptz default now(), metadata jsonb)`)
// the seller's number decides the lawful sending window (08:00–21:00 recipient-local, from the area code); a run outside
// the continental-US evening uses a Pacific / Hawaii-zone seller so the certified send can be exercised at any hour
const GOLD_PHONE = process.env.OHG_SELLER_PHONE || SELLER
const GEO = process.env.OHG_GEO === 'HI' ? { city: 'Honolulu', state: 'HI', zip: '96816', market: 'Honolulu, HI', label: '4471 Marigold Ln, Honolulu, HI 96816' } : { city: 'Indianapolis', state: 'IN', zip: '46203', market: 'Indianapolis, IN', label: '4471 Marigold Ln, Indianapolis, IN 46203' }
await setControls(env.owner, { ...replySwitches([GOLD_PHONE, SELLER_2]), ai_conversation_company_identity: JSON.stringify({ name: 'Reivesti Home Buyers', website: null }) })
await liveDispatch(env)

/** The overlooked conversation: the seller answered 11 days ago with a price and a timeline; nobody replied. */
const gold = await seedThread(env.owner, { phone: GOLD_PHONE, property: '4471-marigold', inboundBody: 'Yes I still own it. The roof needs some work though, is that a problem for you?', minutesAgo: 11 * 24 * 60 })
// our ownership question went out twelve days ago; the seller's answer (eleven days ago) is the LATEST message of the thread
await env.owner.query(`update public.message_events set created_at = now() - interval '12 days', event_timestamp = now() - interval '12 days' where thread_key = $1 and direction = 'outbound'`, [GOLD_PHONE])
await env.owner.query(`update public.send_queue set created_at = now() - interval '12 days', sent_at = now() - interval '12 days' where thread_key = $1`, [GOLD_PHONE])
await env.owner.query(`update public.properties set property_address = '4471 Marigold Ln', property_address_city = $2, property_address_state = $3, property_address_zip = $4 where property_id = $1`, [gold.property, GEO.city, GEO.state, GEO.zip])
await env.owner.query(`update public.inbox_thread_state set last_inbound_at = now() - interval '11 days', latest_direction = 'inbound', latest_message_at = now() - interval '11 days', inbound_count = 1, outbound_count = 1, market = $2 where id = $1`, [gold.thread_id, GEO.market])
/** A soft "not now": never an opt-out, never closed. */
const soft = await seedThread(env.owner, { phone: SELLER_2, property: '812-cedar', inboundBody: 'Not interested right now, maybe in the spring once my sister moves out', minutesAgo: 20 * 24 * 60 })
await env.owner.query(`update public.properties set property_address = '812 Cedar St', property_address_city = 'Indianapolis', property_address_state = 'IN', property_address_zip = '46201' where property_id = $1`, [soft.property])
await env.owner.query(`update public.inbox_thread_state set last_inbound_at = now() - interval '20 days', latest_direction = 'inbound', latest_message_at = now() - interval '20 days', market = 'Indianapolis, IN' where id = $1`, [soft.thread_id])
// the reader's lead-state view of the two properties (what the chain baseline models), best effort per statement
for (const [sql, args] of [
  [`insert into public.eg_property_facts (property_id, market, zip_code) values ($1, $2, $3) on conflict (property_id) do nothing`, [gold.property, GEO.market, GEO.zip]],
  [`insert into public.eg_property_facts (property_id, market, zip_code) values ($1, 'Indianapolis, IN', '46201') on conflict (property_id) do nothing`, [soft.property]],
  [`update public.eg_property_facts set property_address_full = $2, property_address_city = $3, property_address_state = $4, refreshed_at = now() where property_id = $1`, [gold.property, GEO.label, GEO.city, GEO.state]],
  [`update public.eg_property_facts set property_address_full = '812 Cedar St, Indianapolis, IN 46201', property_address_city = 'Indianapolis', property_address_state = 'IN', refreshed_at = now() where property_id = $1`, [soft.property]],
  [`insert into public.property_acquisition_scores (property_id, aos_score, computed_at) select $1, 74, now() where not exists (select 1 from public.property_acquisition_scores where property_id = $1)`, [gold.property]],
  [`insert into public.campaign_target_graph (property_id, canonical_e164, sms_eligible) values ($1, $2, true)`, [gold.property, GOLD_PHONE]],
  ...(process.env.OHG_PROPERTY_STATE_UNKNOWN ? [[`update public.properties set property_address_state = null, property_address_zip = null where property_id = $1`, [gold.property]], [`update public.inbox_thread_state set market = null where id = $1`, [gold.thread_id]]] : []),
  [`insert into public.campaign_target_graph (property_id, canonical_e164, sms_eligible) values ($1, $2, true)`, [soft.property, SELLER_2]],
]) { try { await env.owner.query(sql, args) } catch (e) { log('seed skipped:', sql.slice(0, 70), '→', e.message.slice(0, 90)) } }

// ── 3. the agent principals: one credential each (never shared across identities) ───────────────────────────
const READS = [['conversation.read_context', 1], ['acquisitions.read_delivery', 1], ['acquisitions.read_annotations', 1]]
const WRITES = [['acquisitions.set_lead_temperature', 2], ['acquisitions.update_lead_status', 2], ['acquisitions.record_conversation_note', 2], ['acquisitions.record_seller_statement', 2],
  ['followups.schedule', 2], ['followups.cancel', 2], ['tasks.create_operator_task', 1], ['holds.set_thread_hold', 2]]
const creds = {
  sterling: await registerAgent(env.owner, { agent_id: 'agt_sterling', grants: [...READS, ...WRITES, ['conversation.queue_reply', 3]], tier_ceiling: 3, read_scopes: ['conversation_context.read'] }),
  equity: await registerAgent(env.owner, { agent_id: 'agt_equity', grants: [...READS, ['acquisitions.record_conversation_note', 2]], tier_ceiling: 2, read_scopes: ['conversation_context.read'] }),
  haven: await registerAgent(env.owner, { agent_id: 'agt_haven', grants: [...READS, ['acquisitions.record_conversation_note', 2]], tier_ceiling: 2, read_scopes: ['conversation_context.read'] }),
}
for (const [k, v] of Object.entries(creds)) secret(`cred-${k}`, v)

// ── 4. PostgREST + the /rest/v1 shim, the reader in LIVE mode (its own process, bearer token file) ───────────
const jwtSecret = crypto.randomBytes(32).toString('base64url')
const dbName = new URL(env.url).pathname.slice(1)
const pgHost = new URL(env.url).hostname, pgPort = new URL(env.url).port || '5432'
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const pgrstPort = await freePort()
const pgrst = spawn(POSTGREST, [], { env: { PATH: process.env.PATH, PGRST_DB_URI: `postgresql://authenticator@${pgHost}:${pgPort}/${dbName}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: jwtSecret, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(pgrstPort), PGRST_DB_POOL: '4', PGRST_LOG_LEVEL: 'error' }, stdio: ['ignore', 'ignore', 'pipe'] })
let pgrstErr = ''
pgrst.stderr.on('data', (d) => { pgrstErr = (pgrstErr + d).slice(-1500) })
for (let i = 0; ; i++) { try { const r = await fetch(`http://127.0.0.1:${pgrstPort}/`); if (r.status < 500) break } catch { /* not yet */ } if (i > 100) throw new Error(`PostgREST did not start: ${pgrstErr}`); await new Promise((r) => setTimeout(r, 100)) }
const shimPort = await freePort()
const shim = http.createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404).end(); return }
    if (!req.headers.apikey) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'No API key found in request' })); return }
    const chunks = []; for await (const c of req) chunks.push(c)
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'apikey'].includes(k)))
    const r = await fetch(`http://127.0.0.1:${pgrstPort}${req.url.slice('/rest/v1'.length)}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
    const out = Buffer.from(await r.arrayBuffer())
    res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k)))); res.end(out)
  } catch (e) { res.writeHead(502).end(String(e?.message || e)) }
})
await new Promise((r) => shim.listen(shimPort, '127.0.0.1', r))
const exp = (d) => Math.floor(Date.now() / 1000) + d * 86_400
const readerJwt = secret('reader.jwt', mintHs256(jwtSecret, { role: 'lc_mcp_reader', iss: 'supabase', iat: exp(0) - 60, exp: exp(7) }))
const anonJwt = secret('anon.key', mintHs256(jwtSecret, { role: 'anon', iss: 'supabase', iat: exp(0) - 60, exp: exp(365) }))
const readerToken = secret('reader.token', crypto.randomBytes(32).toString('base64url'))
const readerDir = path.join(REPO_DIR, 'mcp/leadcommand-mcp')
const readerLog = fs.openSync(path.join(OUT, 'reader.log'), 'a')
const reader = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'bin/leadcommand-mcp.mjs'], { cwd: readerDir, stdio: ['ignore', readerLog, readerLog], env: {
  PATH: process.env.PATH, HOME: process.env.HOME, LEADCOMMAND_MCP_DATA: 'live', LEADCOMMAND_MCP_SUPABASE_URL: `http://127.0.0.1:${shimPort}`, LEADCOMMAND_MCP_READER_JWT_FILE: readerJwt, LEADCOMMAND_MCP_API_KEY_FILE: anonJwt,
  LEADCOMMAND_MCP_PRINCIPAL_USER_ID: OWNER, LEADCOMMAND_MCP_ORG_ID: ORG, LEADCOMMAND_MCP_SCOPES: SCOPE_NAMES.join(' '), LEADCOMMAND_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_MCP_HTTP_PORT: String(PORTS.reader), LEADCOMMAND_MCP_HTTP_TOKEN_FILE: readerToken, LEADCOMMAND_MCP_AUDIT_FILE: path.join(OUT, 'reader-audit.jsonl') } })
reader.on('exit', (c) => log('reader exited', c))

// ── 5. the Action MCP: the real app over the gateway role (tenant claim), bearer = the agent's own credential ──
const actionDb = pgSupabase(env.db.trackPool(gatewayPool(env.url, ORG)))
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeJwt = (p) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(p)}.${crypto.randomBytes(24).toString('base64url')}` // never verified: the database client is injected
const actionEnv = {
  LEADCOMMAND_ACTION_MCP_ORG_ID: ORG, LEADCOMMAND_ACTION_MCP_SUPABASE_URL: 'http://127.0.0.1:59999',
  LEADCOMMAND_ACTION_MCP_API_KEY_FILE: secret('action-anon', fakeJwt({ role: 'anon', iss: 'supabase', exp: exp(30) })),
  LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: secret('action-gateway.jwt', fakeJwt({ role: 'lc_action_gateway', lc_org: ORG, iss: 'supabase', iat: exp(0), exp: exp(30) })),
  LEADCOMMAND_ACTION_MCP_PEPPER_FILE: secret('action-pepper', 'action-gateway-test-pepper-0123456789abcdef-not-a-secret'),
  LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: '', LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: String(PORTS.action),
  LEADCOMMAND_ACTION_MCP_AUDIT_FILE: path.join(OUT, 'action-audit.jsonl'),
}
const actionApp = await buildActionApp({ env: actionEnv, db: actionDb, scrub: false })
const actionListener = await startActionHttp({ app: actionApp })
log('action mcp', actionListener.url)

// ── 6. LeadCommand's worker + the REAL queue runner with the SIMULATED provider ──────────────────────────────
const w = worker(env)
const sim = simProvider()
const sends = path.join(OUT, 'sends.jsonl')
let sentSeen = 0
async function pump() {
  const tk = await w.tick()
  const rows = await sel(env.owner, `select id, queue_key, thread_key, message_origin from public.send_queue where queue_status = 'queued' and (message_origin = 'ai_generated' or queue_key like 'followup%') order by id`)
  for (const r of rows) {
    const d = await dispatchQueued(env, w, r.id, sim).catch((e) => ({ error: e.message }))
    log('dispatch', r.id, r.queue_key, JSON.stringify(d).slice(0, 160))
  }
  await w.execution.reconcileReceipts()
  while (sentSeen < sim.sent.length) { fs.appendFileSync(sends, JSON.stringify({ at: new Date().toISOString(), provider: 'SIMULATED', ...sim.sent[sentSeen] }) + '\n'); sentSeen++ }
  return tk
}
const pumpTimer = setInterval(() => pump().catch((e) => log('pump error', e.message)), Number(process.env.OHG_PUMP_MS || 2500))

// ── 7. the control endpoint (loopback): a simulated seller reply, the state of a thread, a tick ─────────────
const mask = (s) => String(s ?? '').replace(/\+?1?3125550(\d{3})/g, '•••-$1')
const control = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)) }
  try {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'POST' && u.pathname === '/seller-reply') {
      const chunks = []; for await (const c of req) chunks.push(c)
      const { thread_id, body } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const [t] = await sel(env.owner, 'select id, thread_key, property_id, our_number from public.inbox_thread_state where id = $1', [thread_id])
      if (!t) return send(404, { error: 'thread not found' })
      const id = crypto.randomUUID()
      await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
        values ($1, $2, 'inbound', $3::text, $3::text, $4::text, $5, now(), now(), $6, 'en')`, [id, `SMsim${id.slice(0, 8)}`, t.thread_key, t.our_number || OURS, String(body).slice(0, 600), t.property_id])
      await env.owner.query(`update public.inbox_thread_state set last_inbound_at = now(), latest_direction = 'inbound', latest_message_at = now(), inbound_count = coalesce(inbound_count, 0) + 1 where id = $1`, [thread_id])
      log('seller reply (SIMULATED) on', thread_id, JSON.stringify(String(body).slice(0, 80)))
      return send(200, { ok: true, message_id: id, simulated: true })
    }
    if (req.method === 'GET' && u.pathname.startsWith('/state/')) {
      const thread_id = u.pathname.slice('/state/'.length)
      const [t] = await sel(env.owner, 'select id, property_id, lead_temperature, operational_status, lifecycle_stage, manual_temperature_lock, temperature_reason, temperature_source, last_inbound_at, latest_direction from public.inbox_thread_state where id = $1', [thread_id])
      if (!t) return send(404, { error: 'thread not found' })
      const [tk] = await sel(env.owner, 'select thread_key from public.inbox_thread_state where id = $1', [thread_id])
      const messages = (await sel(env.owner, 'select id, direction, message_body, created_at from public.message_events where thread_key = $1 order by created_at', [tk.thread_key])).map((m) => ({ ...m, message_body: mask(m.message_body) }))
      const queue = (await sel(env.owner, 'select id, queue_key, queue_status, message_origin, scheduled_for, sent_at, delivered_at, failed_reason, created_at, message_body from public.send_queue where thread_key = $1 order by id', [tk.thread_key])).map((q) => ({ ...q, message_body: mask(q.message_body) }))
      const intents = await sel(env.owner, `select i.intent_id, i.agent_id, i.action, i.state, i.result_code, i.created_at, r.state as receipt_state, r.code as receipt_code, r.queue_row_id from action_gateway.action_intents i left join action_gateway.seller_action_receipts r on r.intent_id = i.intent_id where i.params ->> 'thread_id' = $1 order by i.created_at`, [thread_id])
      const annotations = (await sel(env.owner, 'select annotation_id, agent_id, kind, class, value, amount, note, inbound_message_id, created_at from action_gateway.lead_annotations where thread_id = $1 order by created_at', [thread_id])).map((a) => ({ ...a, note: mask(a.note) }))
      const followups = await sel(env.owner, `select * from public.followup_intents where thread_key = $1 order by created_at`, [tk.thread_key]).catch(() => [])
      const approvals = await sel(env.owner, `select approval_id, capability_id, state, decision, decided_by, created_at from agent.approval_request order by created_at`)
      const holds = await sel(env.owner, `select hold_key, hold_type, blocked_capabilities, set_at, released_at from public.automation_holds where thread_key = $1`, [tk.thread_key])
      return send(200, { thread: t, messages, queue, intents, annotations, followups: followups.map((f) => ({ ...f, thread_key: undefined })), approvals, holds, provider_sends: sim.sent.map((s) => ({ ...s, to: undefined, body: undefined, provider: 'SIMULATED' })), provider: 'SIMULATED (no external delivery)' })
    }
    if (req.method === 'POST' && u.pathname === '/approve-intent') {
      // LeadCommand's OWN operator approval of a seller-facing (T3) intent — the existing human decide path, as the ops
      // console would record it. Agntei's approval never substitutes for it: both are required for an agent-initiated send.
      const chunks = []; for await (const c of req) chunks.push(c)
      const { intent_id } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const [a] = await sel(env.owner, `select approval_id, state from agent.approval_request where target ->> 'intent_id' = $1 order by created_at desc limit 1`, [intent_id])
      if (!a) return send(404, { error: 'no approval request for that intent' })
      const d = await humanApprovals(env).decide(a.approval_id)
      log('LeadCommand operator approval (SIMULATED operator decide)', a.approval_id, JSON.stringify(d).slice(0, 160))
      return send(200, { ok: d?.ok !== false, approval_id: a.approval_id, decided_by: 'operator (disposable world)', result: d })
    }
    if (req.method === 'POST' && u.pathname === '/tick') return send(200, await pump())
    if (req.method === 'GET' && u.pathname === '/sends') return send(200, { provider: 'SIMULATED', sent: sim.sent })
    if (req.method === 'GET' && u.pathname === '/world') return send(200, world)
    send(404, { error: 'not found' })
  } catch (e) { send(500, { error: String(e?.message || e) }) }
})
await new Promise((r) => control.listen(PORTS.control, '127.0.0.1', r))

const world = {
  started_at: new Date().toISOString(), database: dbName, provider: 'SIMULATED', ports: PORTS,
  reader: { url: `http://127.0.0.1:${PORTS.reader}/mcp`, token_file: readerToken, mode: 'live (local PostgREST over the disposable database)' },
  action: { url: `${actionListener.url}`, credential_files: Object.fromEntries(Object.keys(creds).map((k) => [k, path.join(OUT, `cred-${k}`)])), agents: { sterling: 'agt_sterling', equity: 'agt_equity', haven: 'agt_haven' } },
  control: { url: `http://127.0.0.1:${PORTS.control}` },
  threads: { gold: { thread_id: gold.thread_id, property_id: gold.property, inbound_id: gold.inbound_id, address: GEO.label, zip: GEO.zip }, soft: { thread_id: soft.thread_id, property_id: soft.property, inbound_id: soft.inbound_id, address: '812 Cedar St, Indianapolis, IN 46201' } },
  org: ORG, owner: OWNER, operator: OPERATOR, out_dir: OUT,
}
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world, null, 2))
log('WORLD READY', JSON.stringify({ reader: world.reader.url, action: world.action.url, control: world.control.url, threads: world.threads }))

async function shutdown() {
  clearInterval(pumpTimer)
  await new Promise((r) => control.close(r))
  await new Promise((r) => shim.close(r))
  reader.kill('SIGTERM'); pgrst.kill('SIGTERM')
  try { await actionListener.close?.() } catch { /* ignore */ }
  await env.db.drop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
