// ACQUISITIONS CERTIFICATION WORLD (link #32): one disposable PostgreSQL 17 database — the Action Gateway chain
// #26 → #27 → #28 → #29 → #31 → the ledger's agent_outbound kind → #32, the reader link and its reads — served to:
//   * the LeadCommand READER MCP (live mode over a local PostgREST + the /rest/v1 shim; role lc_mcp_reader),
//   * the LeadCommand ACTION MCP (the real app over the gateway role; one bearer credential per agent principal),
//   * LeadCommand's WORKER (the runtime tick executing handed-off intents — the agents' EXACT texts, validated
//     deterministically: NO model anywhere on the agent path — and the REAL queue runner with a SIMULATED provider:
//     nothing leaves this machine; the production receipt sweep follows each row; a loopback carrier receipt
//     (POST /carrier-receipt) runs the REAL delivery reconciliation for delivered / undelivered),
//   * a loopback CONTROL endpoint: a simulated seller reply written the way the inbound webhook writes it (message_events,
//     inbox_thread_state, and the agents' feed: inbound_message + opt_out for a stop), state dumps, the feed, ticks, and
//     the R2 emergency stop as an operator sets it.
// Owner architecture correction 2026-10-29: Agntei's AI employees compose EVERY SMS (sms_send_agent_text →
// queue_agent_text); ai_agent_text_enabled is turned on in THIS disposable database only. The brief-based agent
// message and the certified reply (LeadCommand composing) are retired: AGENT_COMPOSES_TEXT.
// DISPOSABLE ONLY: AGENT_PG_TEST_DB_URL must name a local scratch server (the harness refuses anything else).
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

import { applyInTransaction, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { agentMessageDb } from '../helpers/action-gateway-agent-message-pg.mjs'
import { registerAgent, seedThread, setControls, sel, MIG, gatewayPool, makeGateway, ORG, OWNER, OPERATOR } from '../helpers/action-gateway-pg.mjs'
import { pgSupabase } from '../helpers/pg-supabase.mjs'
import { seedT34, worker, liveDispatch, dispatchQueued } from '../helpers/action-gateway-t34-world.mjs'
import { simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { fakeProvider } from '../helpers/conversation-ai-runtime-fakes.mjs'
import { actionGatewayRuntimeMaintenance } from '../../src/lib/ai/action-gateway-execution.js'
import { syncDeliveryEvent } from '../../src/lib/supabase/sms-engine.js'
import { appendLeadEvent } from '../../src/lib/domain/outreach/lead-events.js'
import { isStopRequest } from '../../src/lib/domain/conversation-ai/stop-request.js'
import { recordPhoneSuppression } from '../../src/lib/domain/compliance/record-phone-suppression.js'
import { patchUniversalLeadState } from '../../src/lib/domain/lead-state/patch-universal-lead-state.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { buildApp as buildActionApp } from '../../../../mcp/leadcommand-action-mcp/src/app.mjs'
import { startHttp as startActionHttp } from '../../../../mcp/leadcommand-action-mcp/src/protocol/http.mjs'
import { writeSecretFile } from '../../../../mcp/leadcommand-action-mcp/src/config.mjs'
import { captureColumns, wideningSql, mintHs256 } from '../../../../mcp/leadcommand-mcp/test/support/local-stack.mjs'
import { SCOPE_NAMES } from '../../../../mcp/leadcommand-mcp/src/authz/scopes.mjs'

__setAutomationHoldResolverForTests(null) // the REAL hold registry answers every hold check

const OUT = process.env.ACQ_WORLD_DIR || path.join(process.env.TMPDIR || '/tmp', 'acq-world')
const PORTS = { reader: Number(process.env.ACQ_READER_PORT || 4881), action: Number(process.env.ACQ_ACTION_PORT || 4882), control: Number(process.env.ACQ_CONTROL_PORT || 4883) }
const POSTGREST = process.env.LC_POSTGREST_BIN || '/usr/local/bin/postgrest'
const MARKET = 'Honolulu, HI'
const log = (...a) => console.log(new Date().toISOString(), ...a)
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })
const secret = (name, value) => writeSecretFile(path.join(OUT, name), value)

// ── 1. the database: the agent-message chain + the reader link and its reads ─────────────────────────────────
const env = await agentMessageDb()
log('database', env.url.replace(/\/\/[^@]*@/, '//'))
await runSqlFile(env.db.pool, path.join(REPO_DIR, 'mcp/leadcommand-mcp/migrations/test/lc_mcp_reader_chain_baseline.sql'))
const widen = path.join(OUT, 'widening.sql')
fs.writeFileSync(widen, wideningSql(await captureColumns()))
for (const stmt of fs.readFileSync(widen, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('--') && !/probate|preforeclosure|census_geo_metrics/.test(l))) {
  try { await env.db.pool.query(stmt) } catch (e) { log('widen skipped:', stmt.slice(0, 80), '→', e.message.slice(0, 80)) }
}
// the reader links: #1.0 reader, 1.1 conversation intelligence, 1.2 census, 1.3 the acquisition reads (thread contact
// eligibility, follow-ups, execution log, offers, operator tasks) — applied over the REAL relations of this chain (never
// that link's emulation fixture: it inserts synthetic rows)
for (const f of ['PROPOSED_20261019150000_lc_mcp_reader.sql', 'PROPOSED_20261026120000_lc_mcp_conversation_intel.sql', 'PROPOSED_20261026150000_lc_mcp_corpus_census.sql', 'PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql', ...(process.env.ACQ_EXTRA_READER_LINKS || '').split(',').filter(Boolean)]) {
  try { await applyInTransaction(env.db.pool, MIG(f)); log('applied', f) } catch (e) { log('NOT applied', f, '→', e.message.slice(0, 160)) }
}

// ── 2. the world: org, operators, switches, senders, the fallback template ───────────────────────────────────
await seedT34(env)
await env.owner.query(`create table if not exists public.universal_lead_state_events (id uuid primary key default gen_random_uuid(), thread_key text, property_id text, field_name text, previous_value text, new_value text, operator_id text, source_view text, reason text, change_source text, executed_next_action boolean, created_at timestamptz default now(), metadata jsonb)`)
// the dispatcher's outbound message_events upsert keys on message_event_key (unique in production; the fixtures lack it):
// without it the thread history would miss our own sends
try { await env.owner.query(`create unique index if not exists message_events_message_event_key_uq on public.message_events (message_event_key)`) } catch (e) { log('message_event_key index skipped:', e.message.slice(0, 80)) }
// automation_suppressions in its production shape (the gateway fixtures model six columns; the reader's thread contact
// eligibility reads created_at / conversation_thread_id): columns only, no rows
await env.owner.query(`alter table public.automation_suppressions add column if not exists event_type text, add column if not exists action_type text, add column if not exists rule_key text,
  add column if not exists dedupe_key text, add column if not exists conversation_thread_id text, add column if not exists property_id text, add column if not exists prospect_id text,
  add column if not exists master_owner_id text, add column if not exists phone_number_id text, add column if not exists queue_item_id text, add column if not exists payload jsonb default '{}'::jsonb,
  add column if not exists suppressed_at timestamptz default now(), add column if not exists created_at timestamptz default now(), add column if not exists updated_at timestamptz default now()`)
for (const c of ['contactability_status text', 'disposition text', 'is_suppressed boolean', 'opt_out boolean', 'wrong_number boolean']) await env.owner.query(`alter table public.inbox_thread_state add column if not exists ${c}`)
/** The canonical registry's marks for a seller who opted out / a confirmed wrong number (patch-universal-lead-state). */
const OPTED_OUT_MARKS = `contactability_status = 'opted_out', is_suppressed = true`
const WRONG_NUMBER_MARKS = `disposition = 'wrong_number', contactability_status = 'invalid_number', is_suppressed = true`

const HI_SENDER = '+18085550199'
const P = { gold: '+18085550101', soft: '+18085550102', ft_a: '+18085550103', ft_b: '+18085550104', stopped: '+18085550105', wrong: '+18085550106', eastern: '+13175550107' }
const PID = { gold: '808100001', soft: '808100002', ft_a: '808100003', ft_b: '808100004', stopped: '808100005', wrong: '808100006', eastern: '808100007' }
const STREET = { gold: '4471 Marigold Ln', soft: '812 Cedar St', ft_a: '1550 Kapiolani Blvd', ft_b: '2230 Wilder Ave', stopped: '96 Kaimuki Ave', wrong: '310 Lunalilo St', eastern: '77 Pali Hwy' }
const FIRST = { gold: 'Dana', soft: 'Ray', ft_a: 'Keoni', ft_b: 'Malia', stopped: 'Lee', wrong: 'Pat', eastern: 'Sam' }

await setControls(env.owner, {
  // the agents' own texts: switched ON in THIS world only (born OFF everywhere else); the default caps
  ai_agent_text_enabled: 'true',
  ai_agent_text_policy: JSON.stringify({ max_per_day_global: 200, max_per_lead_per_day: 6, max_initiated_per_lead_per_day: 1, followup_min_quiet_hours: 24, reengage_min_quiet_hours: 72, policy_version: 'acq-world.v1' }),
  ai_conversation_company_identity: JSON.stringify({ name: 'Reivesti Home Buyers', website: null, human_review: false, persona_descriptor: null }),
  // the contact scope is REQUIRED for agent texts: exactly this world's sellers (the reply engine itself stays off)
  ai_conversation_send_policy: JSON.stringify({ enabled: false, scope: { thread_keys: Object.values(P) } }),
})
await liveDispatch(env)
await env.owner.query(`insert into public.textgrid_numbers (phone_number, status, market, health_state, daily_limit) values ($1, 'active', $2, 'healthy', 500)`, [HI_SENDER, MARKET])
await env.owner.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body, template_name) values
  ('t-acq-checkin-1', 'consider_selling_follow_up', 'English', true, true, 'Hi {{seller_first_name}}, {{agent_name}} here again. Any change of plans on {{property_address}}?', 'acquisitions check-in')`)

async function property(k, { city = 'Honolulu', state = 'HI', zip = '96816' } = {}) {
  await env.owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ($1, 'SFR', $2, $3, $4, $5)
    on conflict (property_id) do update set property_address_city = excluded.property_address_city, property_address_state = excluded.property_address_state, property_address_zip = excluded.property_address_zip, property_address = excluded.property_address`, [PID[k], city, state, zip, STREET[k]])
}
async function prospect(k) { await env.owner.query(`insert into public.prospects (prospect_id, first_name, full_name) values ($1, $2, $2 || ' K') on conflict do nothing`, [`pr-${k}`, FIRST[k]]) }
let campaignId = null
async function target(k, { identity = 'verified', status = 'ready' } = {}) {
  campaignId ||= (await env.owner.query(`insert into public.campaigns (name, status) values ('Honolulu acquisitions', 'active') returning id`)).rows[0].id
  await property(k); await prospect(k)
  return (await env.owner.query(`insert into public.campaign_targets (campaign_id, property_id, prospect_id, to_phone_number, market, language, state, property_address, touch_number, target_status, routing_status, identity_status, suppression_status, metadata)
    values ($1, $2, $3, $4, $5, 'English', 'HI', $6, 1, $7, 'ready', $8, 'clear', jsonb_build_object('candidate_snapshot', jsonb_build_object('seller_first_name', $9::text))) returning id`,
  [campaignId, PID[k], `pr-${k}`, P[k], MARKET, STREET[k], status, identity, FIRST[k]])).rows[0].id
}
async function thread(k, { inboundBody, daysAgo, ourText }) {
  const t = await seedThread(env.owner, { phone: P[k], property: PID[k], inboundBody, minutesAgo: daysAgo * 24 * 60 })
  await property(k); await prospect(k)
  const outAt = `${daysAgo * 24 + 1} hours`
  await env.owner.query(`update public.message_events set created_at = now() - $2::interval, event_timestamp = now() - $2::interval, message_body = $3, from_phone_number = $4 where thread_key = $1 and direction = 'outbound'`, [P[k], outAt, ourText, HI_SENDER])
  await env.owner.query(`update public.message_events set to_phone_number = $2 where thread_key = $1 and direction = 'inbound'`, [P[k], HI_SENDER])
  await env.owner.query(`update public.send_queue set created_at = now() - $2::interval, sent_at = now() - $2::interval, message_body = $3, from_phone_number = $4, agent_name = 'Helen' where thread_key = $1`, [P[k], outAt, ourText, HI_SENDER])
  await env.owner.query(`update public.inbox_thread_state set our_number = $2, market = $3, prospect_id = $4, last_inbound_at = now() - make_interval(days => $5::int), latest_direction = 'inbound', latest_message_at = now() - make_interval(days => $5::int), inbound_count = 1, outbound_count = 1 where id = $1`,
    [t.thread_id, HI_SENDER, MARKET, `pr-${k}`, daysAgo])
  return t
}

// 1 gold: the seller's latest message is unanswered and asks a question
const gold = await thread('gold', { inboundBody: 'Yes I still own it. The roof needs some work though, is that a problem for you?', daysAgo: 2, ourText: 'Hi Dana, this is Helen. Do you still own the house on Marigold Ln?' })
// 2 soft: "not now, maybe in spring", 20+ days ago; we answered then, nothing since
const soft = await thread('soft', { inboundBody: 'Not right now, maybe in the spring once my sister moves out', daysAgo: 22, ourText: 'Hi Ray, this is Helen. Do you still own the house on Cedar St?' })
await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
  values ($1, 'SMsoftack1', 'outbound', $2::text, $3::text, $2::text, 'Understood, thanks Ray. Good luck with the move.', now() - interval '21 days', now() - interval '21 days', $4, 'en')`, [crypto.randomUUID(), P.soft, HI_SENDER, PID.soft])
await env.owner.query(`update public.inbox_thread_state set latest_direction = 'outbound', latest_message_at = now() - interval '21 days', outbound_count = 2 where id = $1`, [soft.thread_id])
// 3 / 4 first-touch targets: eligible, no conversation
const ftA = await target('ft_a')
const ftB = await target('ft_b')
// 5 stopped: a campaign target we texted 40 days ago whose number answered STOP: opted out (thread marks + suppression list)
const stopped = await target('stopped')
const stoppedThread = await thread('stopped', { inboundBody: 'STOP', daysAgo: 40, ourText: 'Hi Lee, this is Helen. Do you still own the house on Kaimuki Ave?' })
await env.owner.query(`update public.inbox_thread_state set ${OPTED_OUT_MARKS} where id = $1`, [stoppedThread.thread_id])
await env.owner.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [P.stopped])
// 6 wrong: a thread whose number is marked wrong
const wrong = await thread('wrong', { inboundBody: 'Wrong number, I do not own any house', daysAgo: 6, ourText: 'Hi Pat, this is Helen. Do you still own the house on Lunalilo St?' })
await env.owner.query(`insert into public.phones (phone_id, canonical_e164, phone_contact_status) values ('ph-wrong', $1, 'wrong_number')`, [P.wrong])
await env.owner.query(`update public.inbox_thread_state set ${WRONG_NUMBER_MARKS} where id = $1`, [wrong.thread_id])
// 7 eastern: a campaign target with an Eastern-time (317) number: the 08:00–21:00 recipient window decides
const eastern = await target('eastern')

// the reader's view of the properties (best effort per statement: the chain baseline models these relations)
for (const k of Object.keys(P)) {
  for (const [sql, args] of [
    [`insert into public.eg_property_facts (property_id, market, zip_code) values ($1, $2, '96816') on conflict (property_id) do nothing`, [PID[k], MARKET]],
    [`update public.eg_property_facts set property_address_full = $2, property_address_city = 'Honolulu', property_address_state = 'HI', refreshed_at = now() where property_id = $1`, [PID[k], `${STREET[k]}, Honolulu, HI 96816`]],
    // the graph's verdict agrees with the seed: eligible seeds are queue-eligible; stopped / wrong number are not
    [`insert into public.campaign_target_graph (property_id, canonical_e164, sms_eligible, queue_eligible, queue_block_reason, seller_person_key, prospect_id, timezone, identity_alignment, property_address_full, property_city, property_zip, state, market)
      values ($1, $2, $3, $3, $4, $5, $5, $6, 'verified', $7, 'Honolulu', '96816', $8, $9)`,
      [PID[k], P[k], !['stopped', 'wrong'].includes(k), k === 'stopped' ? 'opted_out' : k === 'wrong' ? 'wrong_number' : null, `pr-${k}`, k === 'eastern' ? 'America/Indiana/Indianapolis' : 'Pacific/Honolulu', STREET[k], 'HI', MARKET]],
    [`update public.properties set property_address_full = $2 where property_id = $1`, [PID[k], `${STREET[k]}, Honolulu, HI 96816`]],
  ]) { try { await env.owner.query(sql, args) } catch (e) { log('reader seed skipped:', sql.slice(0, 60), '→', e.message.slice(0, 80)) } }
}

// ── 3. the agent principals: one credential each; owner-minted STANDING seller-facing grants for the two senders ─
const READS = [['conversation.read_context', 1], ['acquisitions.read_delivery', 1], ['acquisitions.read_annotations', 1]]
const WRITES = [['acquisitions.set_lead_temperature', 2], ['acquisitions.update_lead_status', 2], ['acquisitions.record_conversation_note', 2], ['acquisitions.record_seller_statement', 2],
  ['followups.schedule', 2], ['followups.cancel', 2], ['tasks.create_operator_task', 1], ['holds.set_thread_hold', 2]]
const LEADS = [['leads.assign_lead', 2], ['leads.release_lead', 2], ['leads.read_assignment', 1], ['leads.read_pool', 1], ['events.read', 1], ['controls.read', 1]]
const BASIS = 'disposable certification world'
const mintStanding = (agent_id, capability) => env.owner.query(
  `insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_failures_per_hour, max_cap_hits_per_hour, granted_by, valid_from, expires_at, standing_seller_facing, standing_basis)
   values ($1, $2, $3, 3, '{}'::jsonb, '{}'::jsonb, 30, 200, 0, 5, 5, $4, now(), now() + interval '30 days', true, $5)`, [ORG, agent_id, capability, OWNER, BASIS])
const creds = {}
// the two senders: an owner-minted STANDING grant for conversation.queue_agent_text (basis 'disposable certification
// world'); Sterling, the head of acquisitions, also holds leads.transfer_lead (he reassigns and supervises), Nova does not
for (const [k, id] of [['sterling', 'agt_sterling'], ['nova', 'agt_nova']]) {
  creds[k] = await registerAgent(env.owner, { agent_id: id, grants: [...READS, ...WRITES, ...LEADS, ...(k === 'sterling' ? [['leads.transfer_lead', 2]] : [])], tier_ceiling: 3, read_scopes: ['conversation_context.read'] })
  await mintStanding(id, 'conversation.queue_agent_text')
}
for (const [k, id] of [['equity', 'agt_equity'], ['haven', 'agt_haven']]) {
  creds[k] = await registerAgent(env.owner, { agent_id: id, grants: [...READS, ['acquisitions.record_conversation_note', 2]], tier_ceiling: 2, read_scopes: ['conversation_context.read'] })
}
for (const [k, v] of Object.entries(creds)) secret(`cred-${k}`, v)

// ── 4. PostgREST + the /rest/v1 shim, the reader in LIVE mode ────────────────────────────────────────────────
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
const readerLog = fs.openSync(path.join(OUT, 'reader.log'), 'a')
const reader = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'bin/leadcommand-mcp.mjs'], { cwd: path.join(REPO_DIR, 'mcp/leadcommand-mcp'), stdio: ['ignore', readerLog, readerLog], env: {
  PATH: process.env.PATH, HOME: process.env.HOME, LEADCOMMAND_MCP_DATA: 'live', LEADCOMMAND_MCP_SUPABASE_URL: `http://127.0.0.1:${shimPort}`, LEADCOMMAND_MCP_READER_JWT_FILE: readerJwt, LEADCOMMAND_MCP_API_KEY_FILE: anonJwt,
  LEADCOMMAND_MCP_PRINCIPAL_USER_ID: OWNER, LEADCOMMAND_MCP_ORG_ID: ORG, LEADCOMMAND_MCP_SCOPES: SCOPE_NAMES.join(' '), LEADCOMMAND_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_MCP_HTTP_PORT: String(PORTS.reader), LEADCOMMAND_MCP_HTTP_TOKEN_FILE: readerToken, LEADCOMMAND_MCP_AUDIT_FILE: path.join(OUT, 'reader-audit.jsonl') } })
reader.on('exit', (c) => log('reader exited', c))

// ── 5. the Action MCP: the real app over the gateway role, bearer = the agent's own credential ───────────────
const actionDb = pgSupabase(env.db.trackPool(gatewayPool(env.url, ORG)))
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeJwt = (p) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(p)}.${crypto.randomBytes(24).toString('base64url')}` // never verified: the database client is injected
const actionApp = await buildActionApp({ env: {
  LEADCOMMAND_ACTION_MCP_ORG_ID: ORG, LEADCOMMAND_ACTION_MCP_SUPABASE_URL: 'http://127.0.0.1:59999',
  LEADCOMMAND_ACTION_MCP_API_KEY_FILE: secret('action-anon', fakeJwt({ role: 'anon', iss: 'supabase', exp: exp(30) })),
  LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: secret('action-gateway.jwt', fakeJwt({ role: 'lc_action_gateway', lc_org: ORG, iss: 'supabase', iat: exp(0), exp: exp(30) })),
  LEADCOMMAND_ACTION_MCP_PEPPER_FILE: secret('action-pepper', 'action-gateway-test-pepper-0123456789abcdef-not-a-secret'),
  LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: '', LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: String(PORTS.action),
  LEADCOMMAND_ACTION_MCP_AUDIT_FILE: path.join(OUT, 'action-audit.jsonl'),
}, db: actionDb, scrub: false })
const actionListener = await startActionHttp({ app: actionApp })
log('action mcp', actionListener.url)

// ── 6. LeadCommand's worker (NO model on the agent path: a provider that refuses every call proves it) + the REAL
//    queue runner, SIMULATED provider; the production receipt sweep (the runtime-tick maintenance task) ───────────
const noModel = fakeProvider(() => { throw new Error('A MODEL WAS CALLED: the agent path composes nothing') })
const w = worker(env, { prov: noModel, legacyComposer: false })
const [receiptSweep] = actionGatewayRuntimeMaintenance({ LC_ACTION_GATEWAY_EXECUTION: '1' }, { execution: w.execution, intervalMs: 0 })
const sim = simProvider()
const sendsFile = path.join(OUT, 'sends.jsonl')
let sentSeen = 0
let stopped_ = false
async function pump() {
  // the runtime tick re-arms the R2 limits; while an operator's emergency stop is engaged it is NOT run (the queue
  // runner below still runs: it is the dispatch-time brake that must cancel what is queued)
  const tk = stopped_ ? { skipped: 'emergency_stop' } : await w.tick()
  const rows = await sel(env.owner, `select id, queue_key from public.send_queue where queue_status = 'queued' and (message_origin = 'ai_generated' or queue_key like 'agent_text:%' or queue_key like 'followup%') order by created_at`)
  for (const r of rows) {
    const d = await dispatchQueued(env, w, r.id, sim, { now: new Date().toISOString() }).catch((e) => ({ error: e.message })) // the REAL clock: the recipient window is judged now
    log('dispatch', r.id, r.queue_key, JSON.stringify(d).slice(0, 200))
  }
  await receiptSweep.run({ now: new Date().toISOString() })
  while (sentSeen < sim.sent.length) { fs.appendFileSync(sendsFile, JSON.stringify({ at: new Date().toISOString(), provider: 'SIMULATED', ...sim.sent[sentSeen] }) + '\n'); sentSeen++ }
  return { tick: tk, dispatched: rows.length, sent_total: sim.sent.length, model_calls: noModel.calls.length }
}
let pumping = false
const pumpTimer = setInterval(() => { if (pumping) return; pumping = true; pump().catch((e) => log('pump error', e.message)).finally(() => { pumping = false }) }, Number(process.env.ACQ_PUMP_MS || 2500))
const pumpNow = async () => { while (pumping) await new Promise((r) => setTimeout(r, 50)); pumping = true; try { return await pump() } finally { pumping = false } }

// ── 7. the control endpoint (loopback) ───────────────────────────────────────────────────────────────────────
const maskPhones = (s) => String(s ?? '').replace(/\+?1?([2-9]\d{2})555(\d{4})/g, '•••-$2')
const mask = (v) => JSON.parse(maskPhones(JSON.stringify(v)))
const leadSb = pgSupabase(env.owner) // LeadCommand's service client (the webhook's writer runs as it)
const control = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)) }
  const body = async () => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  try {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'POST' && u.pathname === '/seller-reply') {
      // the inbound webhook's writes (handle-textgrid-inbound.js): message_events, inbox_thread_state, then the feed
      const { thread_id, body: text } = await body()
      const [t] = await sel(env.owner, 'select id, thread_key, property_id, our_number from public.inbox_thread_state where id = $1', [thread_id])
      if (!t) return send(404, { error: 'thread not found' })
      const id = crypto.randomUUID()
      const at = new Date().toISOString()
      await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
        values ($1, $2, 'inbound', $3::text, $3::text, $4::text, $5, $6, $6, $7, 'en')`, [id, `SMsim${id.slice(0, 8)}`, t.thread_key, t.our_number || HI_SENDER, String(text).slice(0, 600), at, t.property_id])
      await env.owner.query(`update public.inbox_thread_state set last_inbound_at = $2, latest_direction = 'inbound', latest_message_at = $2, inbound_count = coalesce(inbound_count, 0) + 1 where id = $1`, [thread_id, at])
      const stop = isStopRequest(text)
      const ev1 = await appendLeadEvent(leadSb, { kind: 'inbound_message', eventKey: id, threadKey: t.thread_key, payload: { message_id: id, received_at: at, stop_request: stop }, occurredAt: at })
      // a stop: the opt-out marks LeadCommand's stop handling records (thread contactability + the suppression list)
      if (stop) {
        await env.owner.query(`update public.inbox_thread_state set ${OPTED_OUT_MARKS} where id = $1`, [thread_id])
        await env.owner.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [t.thread_key])
      }
      const ev2 = stop ? await appendLeadEvent(leadSb, { kind: 'opt_out', eventKey: id, threadKey: t.thread_key, payload: { message_id: id, received_at: at, source: 'inbound_stop_request' }, occurredAt: at }) : null
      log('seller reply (SIMULATED) on', thread_id, JSON.stringify(String(text).slice(0, 80)), stop ? '(stop request)' : '')
      return send(200, { ok: true, message_id: id, stop_request: stop, events: { inbound_message: ev1, opt_out: ev2 }, simulated: true })
    }
    if (req.method === 'GET' && u.pathname.startsWith('/state/')) {
      const thread_id = u.pathname.slice('/state/'.length)
      const [t] = await sel(env.owner, 'select id, thread_key, property_id, market, lead_temperature, operational_status, lifecycle_stage, last_inbound_at, latest_direction from public.inbox_thread_state where id = $1', [thread_id])
      if (!t) return send(404, { error: 'thread not found' })
      const messages = await sel(env.owner, 'select id, direction, message_body, created_at from public.message_events where thread_key = $1 order by created_at', [t.thread_key])
      const queue = await sel(env.owner, 'select id, queue_key, queue_status, message_origin, template_id, sent_at, failed_reason, paused_reason, created_at, message_body from public.send_queue where thread_key = $1 order by created_at', [t.thread_key])
      const intents = await sel(env.owner, `select i.intent_id, i.agent_id, i.action, i.state, i.result_code, i.created_at, r.state as receipt_state, r.code as receipt_code, r.queue_row_id from action_gateway.action_intents i left join action_gateway.seller_action_receipts r on r.intent_id = i.intent_id where i.params ->> 'thread_id' = $1 order by i.created_at`, [thread_id])
      const assignment = await sel(env.owner, `select agent_id, assigned_at, lease_until, released_at, release_reason from action_gateway.lead_assignments where lead_ref = action_gateway.thread_ref_of($1) order by assigned_at`, [t.thread_key])
      const holds = await sel(env.owner, `select hold_key, hold_type, set_at, released_at from public.automation_holds where thread_key = $1`, [t.thread_key])
      return send(200, mask({ thread: { ...t, thread_key: undefined }, assignment, messages, queue, intents, holds, provider: 'SIMULATED (no external delivery)' }))
    }
    if (req.method === 'GET' && u.pathname.startsWith('/target/')) {
      const ct = u.pathname.slice('/target/'.length)
      const [x] = await sel(env.owner, 'select id, campaign_id, property_id, market, to_phone_number, target_status, routing_status, identity_status, suppression_status from public.campaign_targets where id::text = $1', [ct])
      if (!x) return send(404, { error: 'campaign target not found' })
      const phone = (await sel(env.owner, `select (action_gateway.agent_message_lead(jsonb_build_object('campaign_target_id', $1::text)) ->> 'phone') p`, [ct]))[0]?.p
      const [th] = await sel(env.owner, 'select id from public.inbox_thread_state where thread_key = $1', [phone])
      const assignment = await sel(env.owner, `select agent_id, assigned_at, lease_until, released_at, release_reason from action_gateway.lead_assignments where lead_ref = action_gateway.thread_ref_of($1) order by assigned_at`, [phone])
      const intents = await sel(env.owner, `select i.intent_id, i.agent_id, i.action, i.state, i.result_code, i.params ->> 'purpose' as purpose, i.created_at, r.state as receipt_state, r.code as receipt_code, r.queue_row_id
        from action_gateway.action_intents i left join action_gateway.seller_action_receipts r on r.intent_id = i.intent_id where i.params ->> 'campaign_target_id' = $1 or (i.params ->> 'thread_id') = $2 order by i.created_at`, [ct, th?.id || '-'])
      const queue = await sel(env.owner, `select id, queue_key, queue_status, message_origin, template_id, sent_at, failed_reason, paused_reason, created_at, message_body from public.send_queue where to_phone_number = $1 or metadata ->> 'campaign_target_id' = $2 order by created_at`, [phone, ct])
      const ledger = await sel(env.owner, `select id, queue_key, record_kind, decision_outcome, approval_state, message_body, author_employee, author_attribution, model, authorization_scope ->> 'category' as category, generated_at from public.ai_generated_messages where queue_key = any ($1::text[]) order by generated_at`, [intents.flatMap((i) => [`agent_text:${i.intent_id}`, `agent_message:${i.intent_id}`])])
      return send(200, mask({ target: { ...x, to_phone_number: undefined }, thread_id: th?.id || null, assignment, intents, receipts: intents.filter((i) => i.receipt_state).map((i) => ({ intent_id: i.intent_id, state: i.receipt_state, code: i.receipt_code, queue_row_id: i.queue_row_id })), queue, ledger, provider: 'SIMULATED' }))
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      const after = Number(u.searchParams.get('after') || 0)
      return send(200, { events: await sel(env.owner, `select cursor, event_id, kind, thread_id, thread_ref, intent_id, payload, occurred_at, created_at from action_gateway.lead_events where cursor > $1 order by cursor limit 500`, [after]) })
    }
    if (req.method === 'POST' && u.pathname === '/emergency-stop') {
      const { on } = await body()
      // set exactly as an operator sets it (agent.runtime_emergency_stop, a NAMED operator: anyone may set it); cleared
      // only on the owner path (service role)
      if (on) {
        const [r] = await sel(env.owner, `select agent.runtime_emergency_stop($1, 'certification run') r`, [OPERATOR])
        if (r?.r?.ok !== true) return send(500, { ok: false, error: 'the emergency stop was not engaged', result: r?.r })
        stopped_ = true
      } else { await env.owner.query(`update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1`); stopped_ = false }
      const [l] = await sel(env.owner, 'select emergency_stop, emergency_stop_at from agent.runtime_limits where id = 1')
      if (l.emergency_stop !== Boolean(on)) return send(500, { ok: false, error: 'runtime_limits did not take the change', emergency_stop: l.emergency_stop })
      log('R2 emergency stop', on ? 'ENGAGED' : 'cleared')
      return send(200, { ok: true, emergency_stop: l.emergency_stop, emergency_stop_at: l.emergency_stop_at })
    }
    // a contact made do-not-contact outside the conversation (an operator's DNC entry): the thread marks + the
    // suppression list LeadCommand's eligibility reads, written by LeadCommand's ONE suppression writer
    // (record-phone-suppression.js), which now also puts an opt_out event (source suppression) on the agents' feed
    if (req.method === 'POST' && u.pathname === '/suppress') {
      const b = await body()
      const [t] = await sel(env.owner, 'select id, thread_key from public.inbox_thread_state where id::text = $1', [String(b.thread_id || '')])
      if (!t) return send(404, { error: 'thread not found' })
      await env.owner.query(`update public.inbox_thread_state set contactability_status = 'do_not_contact', is_suppressed = true where id = $1`, [t.id])
      const r = await recordPhoneSuppression({ supabase: leadSb, phone: t.thread_key, reason: 'dnc', source: 'operator_dnc', threadKey: t.thread_key, sourceEventId: `world-${Date.now()}` }, { alert: async () => ({ ok: true }) })
      const listed = await sel(env.owner, `select suppression_type, source from public.sms_suppression_list where phone_e164 = $1`, [t.thread_key])
      log('suppressed (operator DNC through recordPhoneSuppression, SIMULATED world) thread', t.id, JSON.stringify({ ok: r.ok, fallback: r.fallback_block ?? null }))
      return send(200, { ok: true, thread_id: t.id, suppression: 'dnc', writer: 'recordPhoneSuppression', result: { ok: r.ok, fail_closed: r.fail_closed ?? false, fallback_block: r.fallback_block ?? null }, list_rows: listed.length })
    }
    // a PERSON's change to the lead in LeadCommand (stage / temperature), through the canonical lead-state registry
    // (patchUniversalLeadState, change_source operator): the registry itself appends lead_state_changed to the feed
    if (req.method === 'POST' && u.pathname === '/stage') {
      const b = await body()
      const [t] = await sel(env.owner, 'select id, thread_key from public.inbox_thread_state where id::text = $1', [String(b.thread_id || '')])
      if (!t) return send(404, { error: 'thread not found' })
      const patch = { ...(b.stage ? { lifecycle_stage: String(b.stage) } : {}), ...(b.temperature ? { lead_temperature: String(b.temperature) } : {}) }
      const r = await patchUniversalLeadState({ threadKey: t.thread_key, patch, meta: { change_source: 'operator', operator_id: 'world-operator', updated_by: 'world-operator', reason: String(b.reason || 'operator change (certification world)') }, supabase: leadSb })
      const after = (await sel(env.owner, 'select lifecycle_stage, lead_temperature, operational_status from public.inbox_thread_state where id = $1', [t.id]))[0]
      log('operator lead-state change (registry)', t.id, JSON.stringify(patch), r?.ok ? 'ok' : JSON.stringify(r).slice(0, 200))
      return send(r?.ok ? 200 : 500, { ok: r?.ok === true, thread_id: t.id, patch, path: 'patchUniversalLeadState', result: r?.ok ? 'ok' : r, after })
    }
    // LeadCommand's lease on a lead lapses (as if agntei had been down past its end): the live assignment's lease_until
    // moves into the past — nothing else changes (LeadCommand's own automation may resume, by its rules)
    if (req.method === 'POST' && u.pathname === '/expire-lease') {
      const b = await body()
      const [t] = await sel(env.owner, 'select id, thread_key from public.inbox_thread_state where id::text = $1', [String(b.thread_id || '')])
      if (!t) return send(404, { error: 'thread not found' })
      const r = await env.owner.query(`update action_gateway.lead_assignments set assigned_at = clock_timestamp() - interval '2 hours', lease_until = clock_timestamp() - interval '1 second' where lead_ref = action_gateway.thread_ref_of($1) and released_at is null returning agent_id, lease_until`, [t.thread_key])
      log('lease expired (SIMULATED lapse) on thread', t.id, JSON.stringify(r.rows))
      return send(200, { ok: true, thread_id: t.id, expired: r.rows })
    }
    // a PERSON texts the seller from LeadCommand's inbox (a manual send, recorded as the inbox records it)
    if (req.method === 'POST' && u.pathname === '/manual-send') {
      const b = await body()
      const [t] = await sel(env.owner, 'select id, thread_key, property_id, our_number from public.inbox_thread_state where id::text = $1', [String(b.thread_id || '')])
      if (!t) return send(404, { error: 'thread not found' })
      const id = crypto.randomUUID(); const at = new Date().toISOString()
      await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
        values ($1, $2, 'outbound', $3::text, $4::text, $3::text, $5, $6, $6, $7, 'en')`, [id, `SMman${id.slice(0, 8)}`, t.thread_key, t.our_number || HI_SENDER, String(b.body || 'Operator message').slice(0, 600), at, t.property_id])
      log('manual send by a person (SIMULATED, nothing leaves) on', t.id)
      return send(200, { ok: true, message_id: id, at })
    }
    if (req.method === 'POST' && u.pathname === '/tick') return send(200, await pumpNow())
    if (req.method === 'POST' && u.pathname === '/carrier-receipt') {
      // the carrier's verdict on a sent row, through the REAL delivery reconciliation (syncDeliveryEvent): delivered /
      // undelivered reaches the agents' feed as delivery_changed (SIMULATED carrier; nothing leaves this machine)
      const { queue_row_id, status = 'delivered' } = await body()
      const [row] = await sel(env.owner, 'select * from public.send_queue where id::text = $1', [String(queue_row_id)])
      if (!row) return send(404, { error: 'queue row not found' })
      const st = status === 'delivered' ? 'delivered' : 'undelivered'
      const r = await syncDeliveryEvent({ message_id: row.provider_message_id || `SMsim-${row.id}`, status: st }, { supabase: w.sb, reconcileDeliveryReceipt: async () => ({ final_delivery_status: st === 'delivered' ? 'delivered' : 'failed', send_queue_data: [row], message_events_data: [] }),
        updateContactOutreachState: async () => ({ ok: true }) })
      return send(200, { ok: true, final_delivery_status: r.final_delivery_status, simulated: true })
    }
    if (req.method === 'GET' && u.pathname === '/sends') return send(200, { provider: 'SIMULATED', sent: sim.sent.map((s) => ({ ...s, to: maskPhones(s.to), from: maskPhones(s.from) })) })
    if (req.method === 'GET' && u.pathname === '/world') return send(200, world)
    send(404, { error: 'not found' })
  } catch (e) { send(500, { error: String(e?.message || e) }) }
})
await new Promise((r) => control.listen(PORTS.control, '127.0.0.1', r))

// ── 8. world.json: every seed's ids + its expected eligibility NOW (the pool read's own verdict) ─────────────
const { gateway } = makeGateway(env, { legacyComposer: false })
const pool = await gateway.call({ credential: creds.sterling, tool: 'agent_lead_pool', args: { market: MARKET, limit: 100 } })
const verdict = (id) => { const r = (pool.result?.rows || []).find((x) => (x.campaign_target_id || x.thread_id) === id); return r ? { eligible: r.eligible, ineligible_reason: r.ineligible_reason, next_purpose: r.next_purpose, window_open: r.window_open, next_permitted_at: r.next_permitted_at } : null }
const readerEligibility = async (threadId) => {
  if (!threadId) return null
  const c = await env.db.pool.connect()
  try {
    await c.query('begin'); await c.query('set local role lc_mcp_reader')
    const v = (await c.query('select public.lc_mcp_thread_contact_eligibility($1) v', [threadId])).rows[0]?.v
    return v ? { eligible_for_outreach: v.eligible_for_outreach, blocking_reasons: v.blocking_reasons } : null
  } catch (e) { return { error: e.message.slice(0, 120) } } finally { await c.query('rollback').catch(() => {}); c.release() }
}
const READER = {}
for (const [k, id] of [['gold', gold.thread_id], ['soft', soft.thread_id], ['stopped', stoppedThread.thread_id], ['wrong', wrong.thread_id]]) READER[k] = await readerEligibility(id)
const latestInbound = async (threadId) => (threadId ? (await sel(env.owner, `select m.id from public.message_events m join public.inbox_thread_state t on t.thread_key = m.thread_key where t.id = $1 and m.direction = 'inbound' order by m.created_at desc limit 1`, [threadId]))[0]?.id ?? null : null)
const LATEST_IN = { gold: await latestInbound(gold.thread_id), soft: await latestInbound(soft.thread_id), stopped: await latestInbound(stoppedThread.thread_id), wrong: await latestInbound(wrong.thread_id) }
const seed = (k, { thread_id = null, campaign_target_id = null, expect }) => ({ thread_id, campaign_target_id, latest_inbound_message_id: LATEST_IN[k] ?? null, property_id: PID[k], property_ref: `pid_${[...PID[k]].map((d) => 'ghijklmnop'[Number(d)]).join('')}`, market: MARKET, area_code: P[k].slice(2, 5), address: `${STREET[k]}, Honolulu, HI 96816`, expect, pool: verdict(campaign_target_id || thread_id), reader_contact_eligibility: READER[k] ?? null })
const world = {
  started_at: new Date().toISOString(), database: dbName, provider: 'SIMULATED', model: 'NONE on the agent path (agents compose every SMS; a refusing provider proves no call)', ports: PORTS, market: MARKET,
  switches: { ai_agent_text_enabled: 'true (THIS world only)', ai_conversation_send_enabled: 'absent (the reply engine is not on the agent path)' },
  company_identity: { name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null },
  reader: { url: `http://127.0.0.1:${PORTS.reader}/mcp`, token_file: readerToken, mode: 'live (local PostgREST over the disposable database)' },
  action: { url: `${actionListener.url}`, credential_files: Object.fromEntries(Object.keys(creds).map((k) => [k, path.join(OUT, `cred-${k}`)])),
    agents: { sterling: 'agt_sterling', nova: 'agt_nova', equity: 'agt_equity', haven: 'agt_haven' },
    seller_facing: { sterling: 'standing conversation.queue_agent_text (basis: disposable certification world) + leads.transfer_lead', nova: 'standing conversation.queue_agent_text (basis: disposable certification world)', equity: 'none', haven: 'none' },
    tools: { send: 'sms_send_agent_text {client_request_id, thread_id | campaign_target_id, purpose, body, in_reply_to_message_id?, send_permit_id?, attribution {employee, model, provider, route, session_id, turn_id}}', transfer: 'transfer_lead (sterling only)', retired: ['sms_send_agent_message', 'queue_authorized_reply'] } },
  control: { url: `http://127.0.0.1:${PORTS.control}`, endpoints: ['POST /seller-reply {thread_id, body}', 'GET /state/:thread_id', 'GET /target/:campaign_target_id', 'GET /events?after=<cursor>', 'GET /sends', 'POST /tick', 'POST /carrier-receipt {queue_row_id, status: delivered|undelivered}', 'POST /emergency-stop {on}', 'GET /world'] },
  seeds: {
    gold: seed('gold', { thread_id: gold.thread_id, expect: 'reply: eligible (the seller asked a question, unanswered: purpose reply, in_reply_to_message_id = latest_inbound_message_id)' }),
    soft: seed('soft', { thread_id: soft.thread_id, expect: 'reengage: eligible (quiet 21 days after "not now, maybe in the spring")' }),
    ft_a: seed('ft_a', { campaign_target_id: ftA, expect: 'first_touch: eligible' }),
    ft_b: seed('ft_b', { campaign_target_id: ftB, expect: 'first_touch: eligible' }),
    stopped: seed('stopped', { campaign_target_id: stopped, thread_id: stoppedThread.thread_id, expect: 'ineligible STOP_REQUESTED (answered STOP: opt-out marks + suppression list); every send is refused STOP_REQUESTED' }),
    wrong: seed('wrong', { thread_id: wrong.thread_id, expect: 'ineligible CONTACT_NOT_PERMITTED (confirmed wrong number: disposition wrong_number, contactability invalid_number)' }),
    eastern: seed('eastern', { campaign_target_id: eastern, expect: 'eligible, but refused OUTSIDE_RECIPIENT_WINDOW while 08:00–21:00 Eastern is closed (see pool.window_open)' }),
  },
  org: ORG, owner: OWNER, operator: OPERATOR, out_dir: OUT,
}
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world, null, 2))
log('WORLD READY', JSON.stringify({ reader: world.reader.url, action: world.action.url, control: world.control.url, seeds: Object.fromEntries(Object.entries(world.seeds).map(([k, v]) => [k, v.pool])) }))

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
