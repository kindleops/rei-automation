// rc-8.5.21 integration — EVERYTHING NEW IS BORN OFF.
// Enumerates every env flag and system_control key the release (8.5.20-holds + 8.5.21-a/b/c) adds and
// asserts its default (absent env / absent system_control row) is OFF: AI send + R3 switches, the
// follow-up execution mode, the runtime schedules, the negotiation composer, the SFR lane flag,
// valuation refresh + writes, paid research, the manual-offer guard mode, the company identity, the
// sender-continuity hold release mode and the AI send language policy (English only until a row lists 'es').
// A completeness guard fails when a NEW flag / key constant, or a NEW inline system_control read
// (get_system_value('<key>') and its sibling getters), appears in src without being classified here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, ALLOWED_POLICY_LANGUAGES, DEFAULT_AI_SEND_POLICY, languageEnabledFor, parseKillSwitch, normalizeSendPolicy, templateDeferVerdict } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { SENDER_CONTINUITY_RELEASE_MODE_KEY, resolveSenderContinuityReleaseMode } from '../../src/lib/domain/queue/release-sender-continuity-holds.js'
import { FOLLOWUP_EXECUTION_MODE_KEY, FOLLOWUP_EXECUTION_ENV, resolveFollowUpExecutionMode, followUpExecutionRequested } from '../../src/lib/domain/followups/followup-execution.js'
import { followupRuntimeHandlers } from '../../src/lib/ai/followup-runtime-wiring.js'
import { NEGOTIATION_COMPOSER_FLAG, negotiationComposerEnabled } from '../../src/lib/domain/negotiation/negotiation-composer.js'
import { SFR_LANE_FLAG, sfrLaneEnabled } from '../../src/lib/acquisition/sfrLaneCeiling.js'
import { VALUATION_WRITE_FLAG, valuationWriteEnabled } from '../../src/lib/domain/valuation-refresh/dry-run.js'
import { VALUATION_REFRESH_FLAG, valuationRefreshEnabled } from '../../src/lib/agent/missions/valuation-refresh-handler.js'
import { PAID_RESEARCH_FLAG, PAID_RESEARCH_CEILING_ENV, paidResearchGate, paidResearchCeiling } from '../../src/lib/agent/research/research-usage.js'
import { PROPERTY_RESEARCH_FLAG, propertyResearchEnabled } from '../../src/lib/agent/missions/property-research-triggers.js'
import { MANUAL_OFFER_GUARD_MODE_KEY, MANUAL_OFFER_GUARD_MODES, resolveManualOfferGuardMode } from '../../src/lib/domain/inbox/manual-offer-guard.js'
import { COMPANY_IDENTITY_KEY, normalizeCompanyIdentity, loadCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DRAFT_MODEL_ENV } from '../../src/lib/ai/conversation-ai-draft-service.js'
import { AUTO_RECOVERY_ENV, autoRecoveryEnabled } from '../../src/lib/agent/operations/auto-recovery.js'
import { WORKFORCE_FLAG, WORKFORCE_MODEL_INTERPRET_FLAG, workforceEnabled, modelInterpretEnabled } from '../../src/lib/workforce/config.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const REPO = path.resolve(SRC, '../../..')
const ABSENT = [undefined, null, '']

// ── the registry of NEW (rc-8.5.21) switches ────────────────────────────────
const NEW_ENV_FLAGS = Object.freeze({
  [FOLLOWUP_EXECUTION_ENV]: (env) => followUpExecutionRequested(env),
  [NEGOTIATION_COMPOSER_FLAG]: (env) => negotiationComposerEnabled(env),
  [SFR_LANE_FLAG]: (env) => sfrLaneEnabled(env),
  [VALUATION_WRITE_FLAG]: (env) => valuationWriteEnabled(env),
  [VALUATION_REFRESH_FLAG]: (env) => valuationRefreshEnabled(env),
  [PAID_RESEARCH_FLAG]: (env) => paidResearchGate({ env, committed_paid_usd: 0, estimate_usd: 0.01 }).ok === true,
  [PROPERTY_RESEARCH_FLAG]: (env) => propertyResearchEnabled(env),
  // read inline by the review-draft service: only the literal 'true' arms the model
  [DRAFT_MODEL_ENV]: (env) => String(env?.[DRAFT_MODEL_ENV] ?? '').trim() === 'true',
  // rc-8.5.21 v3: the ops supervisor's auto-recovery sweeps (only the literal 'true' wires them)
  [AUTO_RECOVERY_ENV]: (env) => autoRecoveryEnabled(env),
  // Workforce Phase A (docs/WORKFORCE.md §9): routes 404 and handlers unregistered unless the literal '1';
  // the model interpreter additionally needs Workforce itself on (tests/critical/workforce-born-off.test.mjs)
  [WORKFORCE_FLAG]: (env) => workforceEnabled(env),
  [WORKFORCE_MODEL_INTERPRET_FLAG]: (env) => modelInterpretEnabled({ ...env, [WORKFORCE_FLAG]: '1' }),
})
const NEW_SYSTEM_CONTROL_KEYS = Object.freeze({
  [AI_SEND_KILL_SWITCH_KEY]: (raw) => parseKillSwitch(raw) === true,
  [AI_SEND_POLICY_KEY]: (raw) => normalizeSendPolicy(raw).enabled === true,
  [FOLLOWUP_EXECUTION_MODE_KEY]: (raw) => resolveFollowUpExecutionMode(raw) !== 'off',
  [MANUAL_OFFER_GUARD_MODE_KEY]: (raw) => resolveManualOfferGuardMode(raw) !== MANUAL_OFFER_GUARD_MODES.OFF,
  [COMPANY_IDENTITY_KEY]: (raw) => normalizeCompanyIdentity(raw).configured === true,
  // the sender-continuity hold release writes only on 'live'; anything else is a dry run
  [SENDER_CONTINUITY_RELEASE_MODE_KEY]: (raw) => resolveSenderContinuityReleaseMode(raw) === 'live',
})
// a brake, not a feature: absent = not stopped (every feature it brakes is itself off above)
const BRAKES = Object.freeze(['queue_emergency_stop_at'])
// limits that are not switches (a ceiling cannot turn anything on by itself)
const LIMITS = Object.freeze([PAID_RESEARCH_CEILING_ENV])
// literal-key reads of system_control (the getters in src/lib/system-control.js and their local aliases)
const INLINE_READ_RE = /\b(?:get_?[sS]ystem_?(?:[vV]alue|[fF]lag)(?:Fresh|Value|Fn)?|readSystemValue(?:Fresh)?|loadSystemValue|requireSystemFlag|readSwitch|readRoutingSwitch)\(\s*['"]([a-z][a-z0-9_]+)['"]/g
// inline keys already read at rc-8.5.20 (2cb96db3): owned by earlier releases (derived with the same pattern)
const PRE_8521_INLINE_KEYS = new Set([
  'agent_mode', 'allow_regional_fallback_for_first_touch', 'allow_weak_identity_outbound', 'auto_reply_live_enabled', 'auto_reply_mode', 'auto_reply_thread_allowlist', 'buyer_sms_blast_enabled', 'campaign_feeder_heartbeat_at', 'campaign_feeder_last_batch_at', 'campaign_mode', 'dashboard_live_enabled', 'discord_actions_enabled', 'discord_alerts_enabled', 'email_enabled', 'feeder_enabled', 'identity_blocked_markets', 'intelligence_autonomy_paused', 'outbound_sms_enabled', 'podio_sync_enabled', 'queue_all_market_ack', 'queue_auto_enqueue_enabled', 'queue_daily_send_cap', 'queue_emergency_stop_at', 'queue_engine_shared_secret', 'queue_execution_mode', 'queue_hard_cap', 'queue_market_cap', 'queue_market_filter', 'queue_market_throttle', 'queue_max_batch_size', 'queue_per_number_cap', 'queue_processor_heartbeat_at', 'queue_processor_last_claimed_at', 'queue_processor_mode', 'queue_reconcile_heartbeat_at', 'queue_run_limit', 'queue_runner_enabled', 'queue_scan_limit', 'queue_sender_throttle', 'queue_state_filter', 'reconcile_enabled', 'require_local_routing', 'retry_enabled', 'sms_blocked_sender_numbers', 'sms_blocked_template_ids', 'verification_textgrid_allowed_recipients', 'verification_textgrid_send_enabled', 'webhook_delivery_recovery_last_at', 'webhook_delivery_recovery_throughput_per_min', 'webhook_live_delivery_last_at', 'webhook_live_inbound_last_at', 'workflow_event_bridge_mode'
])

test('every NEW env flag is OFF when the variable is absent, empty or not the arming literal', () => {
  for (const [flag, on] of Object.entries(NEW_ENV_FLAGS)) {
    assert.equal(on({}), false, `${flag}: absent`)
    for (const v of ['', '0', 'false', 'off', 'no', ' ']) assert.equal(on({ [flag]: v }), false, `${flag}=${JSON.stringify(v)}`)
  }
  // the arming literal really arms (the predicate is not vacuously false)
  assert.equal(negotiationComposerEnabled({ [NEGOTIATION_COMPOSER_FLAG]: '1' }), true)
  assert.equal(followUpExecutionRequested({ [FOLLOWUP_EXECUTION_ENV]: '1' }), true)
  assert.equal(sfrLaneEnabled({ [SFR_LANE_FLAG]: '1' }), true)
  assert.equal(valuationWriteEnabled({ [VALUATION_WRITE_FLAG]: '1' }), true)
  assert.equal(workforceEnabled({ [WORKFORCE_FLAG]: '1' }), true)
  assert.equal(modelInterpretEnabled({ [WORKFORCE_FLAG]: '1', [WORKFORCE_MODEL_INTERPRET_FLAG]: '1' }), true)
  assert.equal(modelInterpretEnabled({ [WORKFORCE_MODEL_INTERPRET_FLAG]: '1' }), false, 'the interpreter never arms without Workforce')
  // paid research: even with no flag the ceiling is the $10 testing ceiling, never more
  assert.ok(paidResearchCeiling({}) <= 10)
  assert.ok(paidResearchCeiling({ [PAID_RESEARCH_CEILING_ENV]: '9999' }) <= 10)
})

test('every NEW system_control key is OFF when the row is absent, empty or invalid', () => {
  for (const [key, on] of Object.entries(NEW_SYSTEM_CONTROL_KEYS)) {
    for (const raw of [...ABSENT, 'garbage', '{}', '{"enabled":"true"}']) assert.equal(on(raw), false, `${key}=${JSON.stringify(raw)}`)
  }
  assert.equal(DEFAULT_AI_SEND_POLICY.enabled, false)
  // AI send ⇒ the template engine is never deferred while the switch / policy are off
  assert.equal(templateDeferVerdict({ killSwitchOn: parseKillSwitch(null), policy: normalizeSendPolicy(null), inScope: true }).defer, false)
})

test('sender_continuity_release_mode: off unless the value is exactly live (trimmed, any case)', () => {
  assert.equal(SENDER_CONTINUITY_RELEASE_MODE_KEY, 'sender_continuity_release_mode')
  for (const raw of [...ABSENT, 'off', 'dry_run', 'shadow', 'on', 'true', '1', 'enabled', 'lives', 'live_limited', '{"mode":"live"}']) {
    assert.equal(resolveSenderContinuityReleaseMode(raw), 'off', `release mode ${JSON.stringify(raw)}`)
  }
  // the arming literal really arms (the predicate is not vacuously false)
  for (const raw of ['live', ' LIVE ', 'Live']) assert.equal(resolveSenderContinuityReleaseMode(raw), 'live')
})

test('language policy: born English-only; Spanish only through an explicit policy row; never another language', () => {
  assert.deepEqual([...DEFAULT_AI_SEND_POLICY.languages], ['en'])
  assert.deepEqual([...ALLOWED_POLICY_LANGUAGES], ['en', 'es'])
  for (const raw of [...ABSENT, 'garbage', '{}', '{"enabled":"true"}', '{"enabled":true}', '{"languages":"es"}', '{"languages":[]}', '{"languages":["ht","pt","fr"]}']) {
    assert.deepEqual([...normalizeSendPolicy(raw).languages], ['en'], `languages for ${JSON.stringify(raw)}`)
  }
  // Spanish is reachable ONLY when a row lists it explicitly (and the policy is still separately born disabled)
  const es = normalizeSendPolicy({ languages: ['es'] })
  assert.deepEqual([...es.languages], ['en', 'es'])
  assert.equal(es.enabled, false)
  // a Spanish seller is never enabled by default, and never answered in English
  assert.equal(languageEnabledFor({ inboundText: 'Hola, sí es mía' }).enabled, false)
  assert.equal(languageEnabledFor({ inboundText: 'Hola, sí es mía', languages: DEFAULT_AI_SEND_POLICY.languages }).language, 'es')
  assert.equal(languageEnabledFor({ inboundText: 'Hola, sí es mía', languages: es.languages }).enabled, true)
  // unknown language: never enabled, whatever the policy lists
  assert.equal(languageEnabledFor({ inboundText: 'Wi, se pou mwen', languages: ['en', 'es'] }).enabled, false)
})

test('wiring: no follow-up handler registers and no company identity loads by default', async () => {
  assert.deepEqual(Object.keys(followupRuntimeHandlers({}) || {}), [], 'follow-up execution handlers need LC_FOLLOWUP_EXECUTION=1 + the runtime gate')
  const identity = await loadCompanyIdentity({ readSwitch: async () => null })
  assert.equal(identity.configured, false)
})

test('every runtime schedule seed in the chain is born DISABLED', () => {
  const dir = path.join(REPO, 'supabase/migrations')
  const seeds = fs.readdirSync(dir).filter((f) => /^PROPOSED_.*_schedules\.sql$/.test(f))
  assert.ok(seeds.includes('PROPOSED_20261016163000_followup_execution_schedules.sql'))
  let calls = 0
  for (const f of seeds) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '')
    for (const m of sql.matchAll(/runtime_upsert_schedule\(([\s\S]*?)\);/g)) {
      calls += 1
      assert.match(m[1], /::jsonb\s*,\s*false\s*,/, `${f}: a schedule created enabled: ${m[1].slice(0, 80)}`)
    }
  }
  assert.ok(calls >= 10, `${calls} schedule seeds`)
})

test('completeness: every flag / system_control key constant in src is classified (new = registered above, or pre-rc-8.5.21)', () => {
  // pre-existing at rc-8.5.20 (2cb96db3): owned by earlier releases, not part of this RC's born-off contract
  const PRE_8521 = new Set([
    'seller_state_reconcile_enabled', 'AGENT_RESEARCH_ENABLED', 'AGENT_WEB_RESEARCH_ENABLED', 'AGENT_WEB_FETCH_ENABLED',
    'AGENT_CAPABILITIES_ENABLED', 'AGENT_CAPABILITIES_WRITES_ENABLED', 'AGENT_CAPABILITY_SECRET', 'AGENT_MISSIONS_ENABLED',
    'AGENT_ENABLED', 'AGENT_READ_ONLY', 'AGENT_RUNTIME_ENABLED', 'AGENT_OPERATIONS_ENABLED', 'AGENT_LIVE_ROUTES',
    'AGENT_LIVE_PRODUCTION_PILOT', 'AI_CONVERSATION_SHADOW_ENABLED', 'AGENT_ANTHROPIC_API_KEY', 'ai_conversation_delay_policy',
    'SELLER_CONVERSATION_V3', 'followup_automation_mode', 'followup_no_response_mode', 'SELLER_AUTOPILOT_V2',
    'queue_execution_mode', 'acquisition_brain_mode', 'lead_visibility_sync_enabled', 'INTELLIGENCE_LOGGING_ENABLED',
    'AI_CONVERSATION_TURNS_ENABLED', 'ZIP_INTEL_BUILDER_ENABLED', 'ENTITY_CONTACT_ROLE_V2',
  ])
  const classified = new Set([...Object.keys(NEW_ENV_FLAGS), ...Object.keys(NEW_SYSTEM_CONTROL_KEYS), ...BRAKES, ...LIMITS, ...PRE_8521])
  const files = (function list(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)) : /\.m?js$/.test(e.name) ? [path.join(d, e.name)] : [])) })(SRC)
  const found = new Map()
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/export const [A-Z0-9_]+_(?:FLAG|ENV|MODE_KEY|SWITCH_KEY|POLICY_KEY|ENABLED_KEY|IDENTITY_KEY|STOP_KEY) = ['"]([A-Za-z0-9_]+)['"]/g)) found.set(m[1], path.relative(SRC, f))
  }
  const unclassified = [...found.entries()].filter(([v]) => !classified.has(v))
  assert.deepEqual(unclassified, [], 'a new flag / key must be registered in this born-off test')
  // INLINE system_control reads: a key read by literal (get_system_value('<key>'), getSystemValue,
  // getSystemFlag, readSwitch, …) is a switch even without an exported constant
  const inline = new Map()
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(INLINE_READ_RE)) if (!inline.has(m[1])) inline.set(m[1], path.relative(SRC, f))
  }
  const inlineUnclassified = [...inline.entries()].filter(([k]) => !classified.has(k) && !PRE_8521_INLINE_KEYS.has(k))
  assert.deepEqual(inlineUnclassified, [], 'a new inline system_control read must be registered in this born-off test')
  assert.ok(inline.has(SENDER_CONTINUITY_RELEASE_MODE_KEY) || found.has(SENDER_CONTINUITY_RELEASE_MODE_KEY), 'the release-mode key is still read in src')
  for (const k of [...Object.keys(NEW_ENV_FLAGS), ...Object.keys(NEW_SYSTEM_CONTROL_KEYS)]) assert.ok(found.has(k) || inline.has(k), `${k} is still defined in src`)
})

test('completeness guard self-check: the inline-read detector sees literal reads and a would-be new key', () => {
  const sample = "await get_system_value('brand_new_mode'); getSystemValue(\"x_key\"); getSystemFlag('y_enabled'); readSwitch('z_mode')"
  assert.deepEqual([...sample.matchAll(INLINE_READ_RE)].map((m) => m[1]), ['brand_new_mode', 'x_key', 'y_enabled', 'z_mode'])
  assert.equal(PRE_8521_INLINE_KEYS.has('brand_new_mode'), false)
})
