// E2E-REPORT.md for the Workforce × Agntei milestone (rendered from the runs; every number and id comes from a run).
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const cut = (s, n = 260) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? `${t.slice(0, n)}…` : t ?? '' }
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim() } catch { return null } }

export const REAL_VS_SCRIPTED = [
  ['PostgreSQL', 'REAL', 'PostgreSQL 17 (its own cluster, initdb in a temp dir, a free loopback port; stopped at the end)'],
  ['Schema', 'REAL', 'the PROPOSED migration chain in the PG proofs\' order: shim → S3 (+opaque ids) → research_ro → R2 runtime (+kind limits) → capabilities / shadow / missions / operations / holds / reply turns / negotiation → Action Gateway #26 → follow-up lifecycle → #27 → #28 → workforce_foundation → the Workforce seed (psql) → workforce_agntei. TEST stand-ins: supabase-shim.sql (roles, auth.uid) and the *_baseline.sql / small public fixtures for production public tables'],
  ['PostgREST', 'REAL', 'the PostgREST binary, as `authenticator`, JWT-switched to lc_action_gateway with the lc_org claim'],
  ['/rest/v1 path', 'SYNTHETIC (infrastructure)', 'a ~20-line loopback proxy that only strips /rest/v1 (Supabase\'s API gateway / Kong is not part of this stack)'],
  ['Owner credentials', 'REAL scripts', 'mint-agent-credential.mjs and mint-gateway-token.mjs (0600 files outside the repo); the owner SQL is the exact text the register_agntei response returned; employee_bind_principal / employee_unbind are the real definer functions'],
  ['Action MCP', 'REAL', 'bin/leadcommand-action-mcp.mjs, streamable-http on 127.0.0.1, per-agent Bearer, boot self-check of lc_action_gateway, LEADCOMMAND_ACTION_MCP_WORKFORCE_ENABLED=true'],
  ['Action Gateway + Workforce writers', 'REAL', 'the gateway pipeline and the SECURITY DEFINER writers / reads of workforce_agntei (no in-process shortcut)'],
  ['Workforce API', 'REAL route handlers', 'routes.js handlers (POST /employees register_agntei, GET /missions/[id], /command, /employees/[id] …) called in-process with a fake Request; dashboard auth (session + allowlist) stubbed to a named owner (the CEO user)'],
  ['Workforce engine + R2 runtime', 'REAL', 'runRuntimeTick + createRuntimePgStore (agent_api), the coo_plan / dispatch / mission_review handlers, the authority engine, leases and the reaper. The 60 s workforce-dispatch schedule is stood in for by an operator "run now" enqueue when the runtime is idle'],
  ['Opportunity book (Workforce read services)', 'SYNTHETIC', 'production-shaped Dallas/Minneapolis rows through the injected read-only `services` seam (the Phase A demo\'s spy); 555 numbers'],
  ['property.research', 'REAL handler, SYNTHETIC data, $0', 'createPropertyResearchHandler (the real handler) with buildAsk = null and the job input web:false → zero model calls, no network; its data source is an in-memory source of the production interface over fixture rows'],
  ['Conversation context rows', 'SYNTHETIC', 'public.properties / inbox_thread_state / message_events rows for the candidates (read by the real read_conversation_context through the gateway); no send_queue row'],
  ['Agntei server', 'REAL', 'apps/server/src/main.ts, headless, its own temp AGENT_COMMAND_HOME, AGNTEI_ISOLATED=1 (isolated keychain service), AGNTAU_DISPOSABLE=1, a session token'],
  ['Agntei bridge / connections / chat tool executor / MCP client', 'REAL', 'WorkforceBridge (link, relay, launch, resume, check), Connections (one-agent grant, policy, callTool, Agntei\'s MCP client), ChatService + ChatTools + the per-turn loopback MCP bridge'],
  ['The agent', 'SCRIPTED AGENT (not Claude Code, no model)', 'agntei scripts/leadcommand-e2e/scripted-agent.mjs, started by Agntei exactly where it starts `claude` (AGENT_COMMAND_CLAUDE_BIN), with Claude Code\'s CLI contract (stream-json, --mcp-config, --session-id); a fixed script of MCP calls per scenario'],
  ['Path of the agent\'s calls', 'REAL', 'scripted agent → Agntei\'s per-turn MCP bridge (chat/tool-bridge.ts) → ChatTools.execute (policy, preapproval) → Connections.callTool → Agntei\'s MCP client → the Action MCP. (A conversation turn uses the bridge; the per-run McpProxy carries task runs, which LeadCommand work never is.)'],
  ['Direct MCP client', 'REAL SDK, used only where Agntei refuses first', 'the official MCP SDK client for: another principal presenting Scout\'s ref (Agntei refuses to send it), and tenant isolation (an org-B principal, a second Action MCP serving org B)'],
  ['Screenshots: Agntei', 'REAL UI, live state', 'Agntei\'s own web UI (apps/web/dist, rebuilt from the branch) served by the headless server of the run, on the live E2E state'],
  ['Screenshots: LeadCommand', 'RECORDED from local E2E', 'the dashboard (vite dev) with every /api/cockpit/workforce GET answered from the responses recorded from the real route handlers during the run; no live API'],
]

export const FINDINGS = [
  { side: 'Agntei', what: 'workforce_link_self / workforce_open_mission sent no client_request_id (LeadCommand requires one on every write): Link failed', fix: 'the bridge sends one when the tool\'s schema has it: a stable id per identity (a re-press replays LeadCommand\'s answer) / per directive within ten minutes (a double press is one mission); the composer may pass its own' },
  { side: 'Agntei', what: 'whoami / list_assignments mapping: role_key, department_key, manager.display_name, grants `suspended` (no status word), open_assignments is an array, no binding status word (revocation stamp + validity), lease_owner `gw:<principal>` / lease_until / claimed_at, research job in output.research and runtime_job_id', fix: 'normalizeIdentity / normalizeAssignment read LeadCommand\'s real fields; the link keeps the principal id so a `gw:<principal>` lease is "mine" on resume (it was "held by someone else")' },
  { side: 'Agntei', what: 'a large LeadCommand answer (get_mission with its plan + report) was cut at 8,000 characters before parsing: the mission read failed', fix: 'Connections.callTool returns the whole answer to in-process callers (resultFull, never persisted); the evidence record still keeps 8,000 characters' },
  { side: 'Agntei', what: 'Agntei agent ids (agent_ + 16 random hex) carry a 10+ digit run ~6% of the time; LeadCommand\'s payload guard refuses it as phone-shaped (PARAMS_NOT_STORABLE): Link failed at random', fix: 'newId never draws an id with a 10-digit run; the bridge refuses an older such id with a plain explanation' },
  { side: 'LeadCommand', what: 'the Action MCP\'s second-net mask rewrote a digit run inside an Agntei install id (agntei_inst_<32 hex>, ~17% of ids) in every answer, so whoami no longer matched the link and Agntei (rightly) refused', fix: 'the mask keeps prefixed hex tokens with a letter (the database\'s own opaque-id rule, PROPOSED_20261019120000); a phone beside one is still masked (test). Agntei also stopped drawing such install ids' },
  { side: 'LeadCommand', what: 'GET /missions/[id] dropped how evidence resolved (resolved / via) and every gateway-intent ref, so the API could not show why an outcome is verified', fix: 'presentRef keeps resolved / via (an agent-reported ref reads "reported") and the intent type (test)' },
  { side: 'Agntei', what: 'a LeadCommand policy refusal (LINK_WINDOW_CLOSED, EMERGENCY_STOP …) reached the operator as "LeadCommand refused." with no code', fix: 'the refusal message and the API error body carry LeadCommand\'s code; a refused link check says "LeadCommand refused the check (CODE)" instead of "didn\'t answer"' },
  { side: 'Agntei', what: 'Completed outputs showed only evidence with an ops.leadcommand.ai page (a research job or a gateway intent was invisible) and the same thread twice', fix: 'the panel lists every evidence ref with LeadCommand\'s resolution (resolved · mission job / principal intent / logged read, or reported); links are de-duplicated' },
]

export const BLOCKERS = [
  'Claude Code profile identity in Agntei: a real run needs a signed-in, VERIFIED Claude Code profile (claude.ai login: email + org) bound to the agent; the scripted CLI reports an OAuth-token login without identity, which Agntei rates "partially verified". Someone must sign the profile in (Agntei → Models & profiles) and confirm the identity; in isolated mode the default ~/.claude login is refused unless AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1.',
  'The MCP config handoff to Claude Code: a LeadCommand assignment runs as an Agntei CONVERSATION, so Claude Code receives only Agntei\'s per-turn bridge (`--mcp-config {"mcpServers":{"agntei":{"type":"http","url":"http://127.0.0.1:<port>/chat-mcp/<capability>"}}} --allowedTools mcp__agntei --strict-mcp-config --tools ""`). Proven here with the scripted CLI only: the real `claude` binary must accept that inline config and call `mcp__agntei__leadcommand-workforce__leadcommand_workforce_*` through it (the bridge names are capped at 64 characters; complete_assignment is exactly 64), with MCP_TOOL_TIMEOUT for approvals.',
  'Approvals in a real conversation: here every Workforce write was PREAPPROVED (connection policy, agent chat). Without that each claim / progress / research / complete waits for the person in the thread (15-minute limit), so a real run either preapproves the Workforce writes or has a person approving.',
  'Model-facing result size: the agent receives at most 8,000 characters per tool result (Agntei\'s evidence cap); list_assignments with include_mission_peers on a large mission is cut mid-JSON for a real model.',
  'The live LeadCommand stack: workforce_agntei (and #26–#28, the Workforce foundation + seed) are PROPOSED and unapplied in production; the Action MCP host, its PostgREST origin + lc_action_gateway JWT + pepper, owner-minted principal / grants / bind, the runtime armed for workforce.* + property.research, Workforce enabled, and a running runtime tick (the workforce-dispatch schedule, here stood in for by enqueues) are all owner steps, each separately authorized.',
  'property.research with web on: here buildAsk was null and the job input web:false ($0). A real run with web research needs the ask service, AGENT_WEB_RESEARCH_ENABLED, a budget, and real property data behind createResearchSupabaseSource.',
  'LeadCommand\'s payload guard still refuses an OLD Agntei agent id with a 10-digit run (the database function is production code): such agents must be re-created, or the owner extends the opaque-id rule to agent_<hex> ids.',
  'The Agntei keychain: the connection Bearer is written to the macOS Keychain (service agent-command.isolated in isolated mode). This run removed its own entries at the end; a real run keeps the credential there.',
]

export function renderReport(runs, { opts = {}, outDir = '.' } = {}) {
  const L = []
  const last = runs[runs.length - 1]
  const lcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..')
  const agDir = opts.agnteiDir
  const sha = { lc: git(lcDir, ['rev-parse', 'HEAD']), lcBranch: git(lcDir, ['rev-parse', '--abbrev-ref', 'HEAD']), lcDirty: git(lcDir, ['status', '--porcelain', '--', 'apps/api/src', 'apps/api/scripts/workforce', 'apps/api/tests/critical', 'mcp/leadcommand-action-mcp/src', 'mcp/leadcommand-action-mcp/test', 'supabase/migrations']) || '',
    ag: agDir ? git(agDir, ['rev-parse', 'HEAD']) : null, agBranch: agDir ? git(agDir, ['rev-parse', '--abbrev-ref', 'HEAD']) : null, agDirty: agDir ? git(agDir, ['status', '--porcelain', '--', 'packages', 'apps/server/src', 'apps/web/src', 'scripts']) || '' : '' }
  const passed = (r) => r.checks.filter((c) => c.ok).length
  const fps = runs.map((r) => r.fingerprint)
  const same = new Set(fps).size === 1
  L.push('# Workforce × Agntei — first cross-platform milestone (local E2E)', '')
  L.push(`Generated ${new Date().toISOString()} · ${runs.length} run(s) · each on a fresh PostgreSQL 17 cluster, PostgREST, Action MCP and headless Agntei, all on 127.0.0.1 and all stopped afterwards. The agent is a SCRIPTED AGENT (not Claude Code); no model was called.`, '')
  L.push('## Result', '')
  L.push('| run | checks | adversarial | mission | wall | fingerprint | processes left |', '|---|---|---|---|---|---|---|')
  for (const r of runs) L.push(`| ${r.run} | ${passed(r)}/${r.checks.length} | ${(r.adversarial || []).filter((x) => x.ok).length}/${(r.adversarial || []).length} | ${r.missionRow?.status ?? '?'} | ${sec(r.wallMs)} | \`${r.fingerprint}\` | ${(r.stopped?.remaining || []).length} |`)
  L.push('', `Structure (no ids, no times) across runs: **${same ? 'IDENTICAL' : 'DIFFERENT'}**. All checks: **${runs.every((r) => passed(r) === r.checks.length) ? 'PASS' : 'FAIL'}**.`, '')
  L.push('## Code under test', '')
  L.push('| repo | branch | commit | uncommitted changes in the tested paths |', '|---|---|---|---|')
  L.push(`| LeadCommand | ${sha.lcBranch} | \`${sha.lc}\` | ${sha.lcDirty ? `YES: ${esc(sha.lcDirty.split('\n').slice(0, 6).join('; '))}` : 'none'} |`)
  L.push(`| Agntei | ${sha.agBranch} | \`${sha.ag}\` | ${sha.agDirty ? `YES: ${esc(sha.agDirty.split('\n').slice(0, 6).join('; '))}` : 'none'} |`, '')
  L.push(`Bases: LeadCommand feat/workforce @ 6231a2e2, Agntei agntei-4.9-leadcommand-workforce @ fa43352. ${esc(last.steps.find((s) => s.id === '1a')?.evidence?.version)} · ${esc(last.main?.rest?.version)} · Node ${process.version} (LeadCommand side) · Agntei on Node 22.`, '')
  L.push('## What was REAL and what was SCRIPTED / SYNTHETIC', '', '| layer | status | detail |', '|---|---|---|')
  for (const [a, b, c] of REAL_VS_SCRIPTED) L.push(`| ${esc(a)} | **${esc(b)}** | ${esc(c)} |`)
  L.push('')
  L.push('## The directive', '', `> ${last.missionRow?.directive ?? ''}`, '')
  L.push(`Relayed from Agntei's composer route (\`POST /api/leadcommand/:id/missions\`, assignToSelf) → \`leadcommand_workforce_open_mission\` → mission \`${last.ids.mission}\` ("${esc(last.missionRow?.title)}"), origin **${last.missionRow?.origin}**, requested by the CEO user, owned by the COO.`, '')
  L.push(`assign_to_self: \`${esc(JSON.stringify(last.main?.planned?.assign_to_self))}\` — the FIRST step of opportunity_triage (intel.active_opportunities) is outside a research analyst's charter, so the COO recorded the skip and staffed it normally; when the plan expanded, the research step of candidate c02 was staffed to the Agntei employee, execution_mode **external**.`, '')
  L.push('## Steps (last run): evidence and timings', '')
  L.push('| step | what | ms | evidence |', '|---|---|---|---|')
  for (const s of last.steps) L.push(`| ${s.id} | ${esc(s.title)} | ${s.ms} | ${esc(cut(stepEvidence(s), 700))} |`)
  L.push('')
  L.push('### The scripted agent\'s LeadCommand calls on the main assignment (through Agntei)', '')
  const main = (last.transcript || []).filter((t) => t.type === 'call' && t.aid === last.ids.assignment)
  L.push('| # | tool (as Agntei\'s bridge names it) | LeadCommand code | ms |', '|---|---|---|---|')
  main.forEach((c, i) => L.push(`| ${i + 1} | \`${esc(c.tool)}\` | ${esc(c.code ?? (c.isError ? 'error' : 'ok (read)'))}${c.note ? ` (${esc(c.note)})` : ''} | ${c.ms} |`))
  const cc = (last.transcript || []).filter((t) => t.type === 'credential_check')
  L.push('', `Credential check inside every scripted-agent process (${cc.length}): a LeadCommand credential in its env / argv / MCP config / prompt: **${cc.some((x) => x.found_lcag) ? 'YES' : 'no'}**; an Authorization header in its MCP config: **${cc.some((x) => x.found_bearer_header) ? 'YES' : 'no'}**. MCP URL it was handed: \`${esc(cc[0]?.servers?.[0]?.url_shape)}\`.`, '')
  L.push('### The outcome from both sides', '')
  const both = last.steps.find((s) => s.id === '10')?.evidence
  if (both) {
    L.push('| | LeadCommand Workforce API (route handlers) | Agntei (its MCP client: get_mission + the panel) |', '|---|---|---|')
    L.push(`| mission id | \`${both.leadcommand.mission_id}\` | \`${both.agntei.mission_id}\` |`)
    L.push(`| mission status | ${both.leadcommand.status} | ${both.agntei.status} |`)
    L.push(`| origin | ${both.leadcommand.origin} | ${both.agntei.origin} (visible because: ${both.agntei.visible_because}) |`)
    L.push(`| research assignment | ${both.leadcommand.assignment?.status} · ${both.leadcommand.assignment?.outcome_class} | ${both.agntei.assignment_via_mission?.status} · ${both.agntei.assignment_via_mission?.outcome_class}; panel state **${both.agntei.panel_assignment?.state}** |`)
    L.push(`| evidence refs (type:id:resolution) | ${esc((both.leadcommand.assignment?.evidence || []).join('<br>'))} | ${esc((both.agntei.assignment_via_mission?.evidence || []).join('<br>'))} |`, '')
  }
  const rv = last.steps.find((s) => s.id === '9')?.evidence
  if (rv) { L.push('The COO (Atlas), verbatim:', ''); for (const m of rv.coo_messages || []) L.push(`> ${esc(m)}`, '>'); L.push('') }
  L.push('## Assertions (last run)', '', '| id | assertion | result | detail |', '|---|---|---|---|')
  for (const c of last.checks) L.push(`| ${c.id} | ${esc(c.name)} | ${c.ok ? 'PASS' : '**FAIL**'} | ${esc(cut(c.detail, 420))} |`)
  L.push('')
  L.push('## Adversarial segment (last run)', '', '| id | case | path | expected | got | result |', '|---|---|---|---|---|---|')
  for (const x of last.adversarial || []) L.push(`| ${x.id} | ${esc(x.title)} | ${esc(x.via)} | ${esc(x.expected)} | ${esc(x.code)} | ${x.ok ? 'PASS' : '**FAIL**'} |`)
  L.push('', 'Paths: agntei-agent = the scripted agent launched / resumed by Agntei, through its per-turn bridge and MCP client; agntei-api = Agntei\'s own API (link, check, relay, access); direct-mcp = the official MCP SDK client (only where Agntei refuses first, or for another tenant); owner-sql = the owner\'s definer functions.', '')
  L.push('<details><summary>Adversarial evidence (last run)</summary>', '', '```json', JSON.stringify((last.adversarial || []).map((x) => ({ id: x.id, code: x.code, evidence: x.evidence })), null, 1).slice(0, 14000), '```', '</details>', '')
  L.push('## Integration bugs found and fixed', '', '| side | found | fix |', '|---|---|---|')
  for (const f of FINDINGS) L.push(`| ${f.side} | ${esc(f.what)} | ${esc(f.fix)} |`)
  L.push('')
  L.push('## Timings', '', `| step | ${runs.map((r) => `run ${r.run}`).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`)
  for (const s of last.steps) L.push(`| ${s.id} ${esc(s.title.slice(0, 80))} | ${runs.map((r) => (r.timings?.[s.id] != null ? `${r.timings[s.id]} ms` : '–')).join(' | ')} |`)
  L.push(`| adversarial segment (after step 11) | ${runs.map((r) => (r.adversarialMs != null ? sec(r.adversarialMs) : '–')).join(' | ')} |`)
  L.push(`| total wall | ${runs.map((r) => sec(r.wallMs)).join(' | ')} |`, '')
  L.push(`Runtime ticks (last run): ${last.tick?.ticks ?? '?'}; idle "run now" enqueues: ${last.tick?.nudges ?? '?'}.`, '')
  L.push('## Safety', '')
  L.push(`- send_queue / seller_offers / follow-up intents / agent-set holds: \`${esc(JSON.stringify(last.safety?.counts))}\``)
  L.push(`- public.* writes during the main flow (pg_stat after the synthetic seed): \`${esc(JSON.stringify(last.safety?.table_writes))}\``)
  L.push(`- agent.spend_ledger: \`${esc(JSON.stringify(last.safety?.spend))}\`; property.research web step: ${esc((last.safety?.research_web || []).join(', '))}; the scripted agent reported cost 0 and made no model call`)
  L.push(`- read services called (the spy refuses anything but reads): \`${esc(JSON.stringify(last.safety?.service_calls))}\``, '')
  L.push('## Determinism', '')
  L.push(`Fingerprints: ${fps.map((f) => `\`${f}\``).join(', ')} → ${same ? 'identical' : 'DIFFERENT'}.`, '')
  L.push('<details><summary>The fingerprinted structure (last run)</summary>', '', '```json', JSON.stringify(last.structure, null, 1), '```', '</details>', '')
  L.push('## Screenshots', '')
  const shots = [...(last.screens || []).flatMap((s) => s.files.map((f) => [s.id, f])), ...((last.dashboard?.completed?.files) || []).map((f) => ['leadcommand (recorded from local E2E)', f]), ...((last.dashboard?.after_revoke?.files) || []).map((f) => ['leadcommand after revoke (recorded from local E2E)', f])]
  for (const [k, f] of shots) L.push(`- ${k}: \`${path.relative(outDir, f)}\``)
  if (last.dashboard?.completed?.served) L.push('', `Dashboard requests answered from the recording: ${esc(last.dashboard.completed.served.hits.join(', '))}; not recorded: ${esc(last.dashboard.completed.served.misses.join(', ') || 'none')}; other local /api (empty 200): ${esc(last.dashboard.completed.served.other.join(', '))}. Every non-loopback request was aborted.`)
  if (last.dashboard?.error) L.push('', `Dashboard capture error: ${esc(last.dashboard.error)}`)
  L.push('')
  L.push('## Remaining blockers for a REAL Claude Code run', '')
  for (const b of BLOCKERS) L.push(`- ${b}`)
  L.push('')
  return L.join('\n')
}

function stepEvidence(s) {
  const e = s.evidence
  if (!e) return s.error ? `ERROR ${s.error}` : ''
  switch (s.id) {
    case '1b': return { database: e.database, files: e.files?.length }
    case '2': return { status: e.status, employee: e.employee, executed: e.executed, principal: e.agent_id, owner_steps: e.steps }
    case '3': return { gateway_token: e.gateway_token, credential: e.credential, bind: e.bind, employee: e.employee, grants: e.grants?.length }
    case '5b': return { profile: e.profile, agent: e.agent, connection: e.connection, preapproved: e.preapproved?.length, bearer_in_agntei_db: e.token_in_db }
    case '5c': return { leadcommand: e.leadcommand, agntei_check: e.agntei?.check?.state, agntei_link: e.agntei?.link ? { employee: e.agntei.link.lc_employee_id, principal: e.agntei.link.lc_principal_id, valid_until: e.agntei.link.valid_until } : null }
    case '7': return { mission: e.mission, research: e.research, assignments: e.assignments?.length }
    case '8': return { conversation: e.conversation, assignment: e.assignment && { status: e.assignment.status, outcome_class: e.assignment.outcome_class, attempt: e.assignment.attempt }, calls: e.calls }
    case '9': return { status: e.status, report_counts: e.report_counts, coo_messages: e.coo_messages?.length }
    case '10': return { lc: e.leadcommand?.status, agntei: e.agntei?.status }
    case '11': return { counts: e.counts, spend: e.spend, web: e.research_web }
    default: return e
  }
}
