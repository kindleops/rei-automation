// Disposable-PostgreSQL world for the Action Gateway TIER-2 proofs: the phase-1 world (helpers/action-gateway-pg.mjs:
// the real prerequisite migrations + link #26) PLUS the real follow-up lifecycle migration, the T2 baseline (the
// live campaign lifecycle writer, verbatim) and link #27. The human side is the PRODUCTION capability registry
// (createDefaultCapabilityRegistry: D1 + the T2 request capabilities) deciding through capabilities/approvals.js
// as agent_api, with domain services bound to the disposable database. The provider is simulated; no network.
import path from 'node:path'
import crypto from 'node:crypto'

import { runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { pgSupabase, isoPool } from './pg-supabase.mjs'
import { gatewayDb, seedWorld, registerAgent, ORG, OWNER, OPERATOR } from './action-gateway-pg.mjs'
import { createDefaultCapabilityRegistry, withActionGatewayServices } from '../../src/lib/agent/capabilities/index.js'
import { createCapabilityApprovals } from '../../src/lib/agent/capabilities/approvals.js'
import { createPgCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { loadThreadRow, loadHoldRow, loadCampaignRow, loadOpportunityRow, normalizedStageRow } from '../../src/lib/domain/action-gateway/actions/t2/requests.js'
import { checkAutomationHold } from '../../src/lib/domain/holds/automation-hold.js'
import { releaseAutomationHoldByOperator } from '../../src/lib/domain/holds/automation-hold-release.js'
import { loadPropertyContactBlock } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { validateStageTransition } from '../../src/lib/domain/opportunity/universal-pipeline-registry.js'

const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
export const T2_MIGRATION = MIG('PROPOSED_20261020100000_action_gateway_t2.sql')
export const T2_BASELINE = path.join(REPO_DIR, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t2_baseline.sql')

/** Every T2 capability at tier 2 (standing grants), plus the T1 task capability. */
export const T2_GRANTS = [['leads.update_disposition', 2], ['leads.update_temperature', 2], ['leads.update_stage', 2], ['deals.create_action', 2], ['holds.request_release', 2], ['followups.schedule', 2],
  ['followups.cancel', 2], ['campaigns.pause', 2], ['campaigns.request_resume', 2], ['campaigns.adjust_plan', 2], ['holds.set_thread_hold', 2]]

export async function t2Db() {
  const env = await gatewayDb()
  await runSqlFile(env.db.pool, MIG('PROPOSED_20261017120000_followup_intent_lifecycle.sql'))
  await runSqlFile(env.db.pool, T2_BASELINE)
  const c = await env.db.pool.connect()
  try { await c.query('begin'); await c.query((await import('node:fs')).readFileSync(T2_MIGRATION, 'utf8')); await c.query('commit') } catch (e) { await c.query('rollback').catch(() => {}); throw e } finally { c.release() }
  return env
}

/** A T2 world: the org, controls ON for T1+T2, agent alpha (all T2 grants) and, optionally, more agents. */
export async function t2World({ grants = T2_GRANTS, agents = ['agt_alpha'] } = {}) {
  const env = await t2Db()
  await seedWorld(env.owner)
  const creds = {}
  for (const a of agents) creds[a] = await registerAgent(env.owner, { agent_id: a, grants, tier_ceiling: 2 })
  return { env, cred: creds.agt_alpha, creds }
}

export async function seedOpportunity(owner, { id = crypto.randomUUID(), property = 'p100', thread_key = null, stage = 'asking_price', status = 'active', market = null } = {}) {
  await owner.query(`insert into public.acquisition_opportunities (id, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, stage_entered_at, market)
                     values ($1, $2, $3, $4, $5, now() - interval '2 days', $6)`, [id, property, thread_key, stage, status, market])
  return id
}

export async function seedCampaign(owner, { id = crypto.randomUUID(), status = 'active', daily_cap = 200, send_interval_seconds = 60, start = '09:00', end = '20:00' } = {}) {
  await owner.query(`insert into public.campaigns (id, name, status, daily_cap, total_cap, send_interval_seconds, contact_window_start, contact_window_end)
                     values ($1, 'T2 test campaign', $2, $3, 5000, $4, $5, $6)`, [id, status, daily_cap, send_interval_seconds, start, end])
  return id
}

/**
 * The HUMAN decide path exactly as production wires it: the default (sealed) capability registry, the agent_api
 * capability store, withActionGatewayServices (D1) and domain services bound to the disposable database. The
 * stage transition and the campaign lifecycle / editor are recorded through spies wrapping a minimal real
 * write (their full services need the whole production schema); every read the snapshot uses is the real one.
 */
export function humanPlane(env, { transition = null, lifecycle = null, update = null } = {}) {
  const sb = pgSupabase(env.db.trackPool(isoPool(env.url, 4)))
  const calls = { transition: [], lifecycle: [], update: [], patch: [], release: [] }
  const services = withActionGatewayServices({
    pipeline: {
      // production: opportunity-service#getOpportunityById (its hydration needs the full schema); the snapshot fields are
      // the same normalization (pinned by action-gateway-t2-unit: normalizeOpportunityRow ≡ normalizedStageRow)
      get: async (id) => normalizedStageRow(await loadOpportunityRow(sb, id)),
      validate: validateStageTransition,
      async transition(id, input) {
        calls.transition.push({ id, ...input })
        if (transition) return transition(id, input, sb)
        await env.owner.query(`update public.acquisition_opportunities set acquisition_stage = $2, stage_entered_at = now() where id = $1`, [id, input.to_stage])
        return { ok: true }
      },
    },
    leadState: {
      threadRow: (id) => loadThreadRow(sb, id),
      async messages(tk) { return (await env.owner.query(`select * from public.message_events where thread_key = $1 order by created_at desc limit 20`, [tk])).rows },
      contactBlock: (args) => loadPropertyContactBlock({ supabase: sb, ...args }),
      async patch(args) {
        calls.patch.push(args)
        if (args.dryRun) return { ok: true, dry_run: true }
        await env.owner.query(`update public.inbox_thread_state set disposition = $2 where thread_key = $1`, [args.threadKey, args.patch.disposition])
        return { ok: true }
      },
    },
    holds: {
      row: (id) => loadHoldRow(sb, id),
      check: (args) => checkAutomationHold(args, { supabase: sb }),
      async release(args) { calls.release.push(args); return releaseAutomationHoldByOperator(args, { supabase: sb }) },
    },
    campaigns: {
      row: (id) => loadCampaignRow(sb, id),
      async lifecycle(id, input) {
        calls.lifecycle.push({ id, ...input })
        if (lifecycle) return lifecycle(id, input, sb)
        await env.owner.query(`select * from public.campaign_transition_status($1, 'active', $2)`, [id, input.reason])
        return { ok: true, to: 'active' }
      },
      async update(id, patch) {
        calls.update.push({ id, ...patch })
        if (update) return update(id, patch, sb)
        const cols = Object.keys(patch)
        await env.owner.query(`update public.campaigns set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [id, ...cols.map((c) => patch[c])])
        return { ok: true }
      },
    },
  }, env.db.api)
  const registry = createDefaultCapabilityRegistry()
  const store = createPgCapabilityStore({ pool: env.db.api })
  const approvals = createCapabilityApprovals({ store, registry, services })
  return {
    approvals, store, registry, calls, sb,
    async decide(approval_id, { by = OWNER, decision = 'approve', payload_hash = null } = {}) {
      const a = await store.getApproval(ORG, approval_id)
      return approvals.decide({ org_id: ORG, identity: { verified: true, named: true, user_id: by, method: 'test' }, approval_id, decision, payload_hash: payload_hash ?? a?.payload_hash })
    },
  }
}

export { ORG, OWNER, OPERATOR }
