// 8.5.21-b LIVE READ-ONLY PROOF — property.research end to end on N real properties.
// Production is read inside ONE BEGIN READ ONLY transaction; the R2 runtime is the in-memory twin
// (same rules, real 25 s ticks, real wall clock); findings stay in memory and are summarized to a
// local file, anonymized (P1..Pn, amounts rounded to $5,000, no address / zip / owner / phone).
// The web step runs on at most ONE property, only when ANTHROPIC_API_KEY is in the process env, with
// a $0.30 job cap and a $0.40 day cap on the memory spend guard.
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads, PROPERTY_RESEARCH_KIND } from '../../src/lib/agent/missions/index.js'
import { createPropertyResearchHandler } from '../../src/lib/agent/missions/property-research-handler.js'
import { enqueuePropertyResearch } from '../../src/lib/agent/missions/property-research-triggers.js'
import { createResearchSqlSource } from '../../src/lib/domain/property-research/research-source.js'
import { createValuationSqlSource } from '../../src/lib/domain/valuation-refresh/valuation-source.js'
import { buildValuationQueue } from '../../src/lib/domain/valuation-refresh/valuation-queue.js'
import { createZipModelBuilder, createZipSqlSource, createZipMemoryStore } from '../../src/lib/domain/zip-intelligence/zip-builder.js'
import { resolveZipPrior, zipTypeOfLane, subjectBands } from '../../src/lib/domain/zip-intelligence/zip-prior.js'
import { buildNegotiationPathway } from '../../src/lib/domain/negotiation/negotiation-pathway.js'
import { decodeFromStore } from '../../src/lib/agent/research/pii.js'

const OP = '11111111-1111-4111-8111-111111111111'
const r5 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) / 5000) * 5000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run({ withRo, write, arg }) {
  const n = Number(arg('--n', 5))
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  return withRo(async ({ query }) => {
    // 1 the properties: the head of the valuation refresh queue (active negotiation → offer request → …)
    const rows = await createValuationSqlSource({ query }).candidates({ limit: 2000 })
    const queue = buildValuationQueue(rows, { now: Date.now(), limit: 50 })
    const picks = queue.entries.slice(0, n)
    const meta = await query(`select property_id, canonical_market_id from public.properties where property_id = any($1::text[])`, [picks.map((p) => p.property_id)])
    const marketOf = Object.fromEntries(meta.map((m) => [String(m.property_id), m.canonical_market_id]))
    // 2 the ZIP model for those markets (read-only build into memory; the table is PROPOSED)
    const zstore = createZipMemoryStore()
    const zsource = createZipSqlSource({ query })
    const markets = [...new Set(picks.map((p) => marketOf[p.property_id]).filter(Boolean))].slice(0, 3)
    const t0 = Date.now()
    const zrun = markets.length ? await createZipModelBuilder({ source: zsource, store: zstore, env: { ZIP_INTEL_BUILDER_ENABLED: '1' } }).run({ markets }) : { markets: [] }
    const zipBuildMs = Date.now() - t0
    const cells = [...zstore.cells.values()]
    const subjectZips = (await query('select property_address_zip z from public.properties where property_id = any($1::text[])', [picks.map((p) => p.property_id)])).map((r) => String(r.z || '').slice(0, 5)).filter(Boolean)
    const geo = await zsource.geoForZips([...new Set([...cells.map((c) => c.zip5), ...subjectZips])])
    const zipPriorFor = async ({ zip5, lane, property, valuation }) => resolveZipPrior({ cells, zip5, property_type: zipTypeOfLane(lane, property), ...subjectBands({ value: valuation?.valuation_mid ?? property?.estimated_value, repairs: property?.estimated_repair_cost, condition: property?.building_condition }), geo })

    // 3 the runtime twin: property.research armed with a $0.30 event budget (the PROPOSED ceiling)
    const store = createRuntimeMemoryStore({ limits: { runtime_enabled: true, max_concurrency_global: 1, tick_max_jobs: 1, lease_seconds: 120, backoff_base_seconds: 1, event_budget_ceilings: { [PROPERTY_RESEARCH_KIND]: 0.30 }, kind_limits: { [PROPERTY_RESEARCH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP, event_budget_cap_usd: 0.30 } } }, research: { enabled: true, day_usd: 0.40, run_usd: 0.30 } })
    const reads = createMissionMemoryReads(store, { members: [{ org_id: 'org', user_id: OP, role: 'owner' }] })
    let buildAsk = null
    let env = { PROPERTY_RESEARCH_ENABLED: '1' }
    if (key) {
      const { createAskService } = await import('../../src/lib/agent/research/ask-service.js')
      const { createToolRegistry } = await import('../../src/lib/agent/tools/registry.js')
      const { createModelResolver } = await import('../../src/lib/agent/research/models.js')
      const { createAnthropicProvider } = await import('../../src/lib/ai/anthropic-provider.js')
      env = { ...env, NODE_ENV: 'development', ANTHROPIC_API_KEY: key, AGENT_ENABLED: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_WEB_RESEARCH_ENABLED: '1', AGENT_SPEND_GLOBAL_DAILY_USD: '0.4', AGENT_SPEND_USER_DAILY_USD: '0.4', AGENT_SPEND_CYCLE_USD: '0.4' }
      const provider = createAnthropicProvider({ env })
      const resolver = createModelResolver({ provider, env })
      const registry = createToolRegistry({ readOnly: true }).seal()
      buildAsk = ({ store: s }) => createAskService({ store: s, registry, provider, resolver, createServices: () => ({}), env })
    }
    const handler = createPropertyResearchHandler({ source: createResearchSqlSource({ query }), reads, buildAsk, env, zipPriorFor })
    const out = []
    for (let i = 0; i < picks.length; i += 1) {
      const p = picks[i]
      const trigger = p.class === 'offer_request' ? 'offer_request' : p.class === 'recoverable_conversation' ? 'recovery_finding' : 'valuation_stale_or_missing'
      const web = Boolean(key) && i === 0
      const { job_id } = await enqueuePropertyResearch({ store, env, trigger, property_id: p.property_id, discriminator: `proof:${i}`, web })
      const ticks = []
      for (let k = 0; k < 8; k += 1) {
        const ts = Date.now()
        const s = await runRuntimeTick({ store, handlers: { [PROPERTY_RESEARCH_KIND]: handler }, workerId: 'proof', budgetMs: 25_000 })
        ticks.push({ outcome: s.jobs[0]?.outcome || s.blocked || 'none', ms: Date.now() - ts })
        const j = store._state.jobs.get(job_id)
        if (['completed', 'failed', 'dead_letter', 'budget_blocked', 'cancelled'].includes(j.state)) break
        await sleep(1_100)
      }
      const j = store._state.jobs.get(job_id)
      const fs = [...store._state.findings.values()].filter((f) => f.job_id === job_id)
      const dec = (t) => { const f = fs.find((x) => x.finding_type === t); return f?.value?.payload_v1 ? JSON.parse(decodeFromStore(f.value.payload_v1)) : null }
      const econ = dec('property.economics')
      const plan = dec('property.offer_plan')
      const pathway = econ ? buildNegotiationPathway({ economics: econ, offer_plan: plan }) : null
      const spent = store._state.ledger.filter((l) => l.job_id === job_id).reduce((a, l) => a + Number(l.state === 'settled' ? l.actual_usd : l.state === 'released' ? 0 : l.reserved_usd), 0)
      out.push({
        property: `P${i + 1}`, queue_class: p.class, trigger, state: j.state, error: j.last_error?.code || null,
        ticks, max_tick_ms: Math.max(...ticks.map((t) => t.ms)), all_ticks_within_25s: ticks.every((t) => t.ms <= 26_000),
        result: j.result ? { lane: j.result.lane, economics_class: j.result.economics_class, judgment_path: j.result.judgment_path, offer_plan: j.result.offer_plan, coverage_share: j.result.coverage_share, gaps: j.result.gaps, web: j.result.web, yields: j.result.yields, findings: j.result.findings } : null,
        findings: fs.map((f) => f.finding_type).sort(),
        provenance: [...new Set(fs.map((f) => f.source_id))].sort(),
        plan: plan ? { available: plan.available, reason: plan.reason, mao: r5(plan.mao?.amount), opening: plan.opening ? r5(plan.opening.recommended) : null, opening_below_mao: plan.opening ? plan.opening.recommended < plan.mao.amount : null, market_prior: plan.market_prior?.available ? { label: plan.market_prior.label, precision: plan.market_prior.precision, band: plan.market_prior.investor_discount_band, sample: plan.market_prior.sample_size } : { available: false, reason: plan.market_prior?.reason }, notes: plan.notes } : null,
        pathway: pathway ? { class: pathway.class, next_action: pathway.next_action, land_zoning_first: pathway.land_zoning_first?.path || null, concessions: pathway.concessions.length } : null,
        cost_usd: Math.round(spent * 10000) / 10000, sends: j.result?.sends ?? 0,
      })
      process.stdout.write(`research P${i + 1}: ${j.state} ticks=${ticks.length}\n`)
    }
    const total = out.reduce((a, r) => a + r.cost_usd, 0)
    const summary = { at: new Date().toISOString(), read_only: true, properties: out.length, web_enabled: Boolean(key), zip_model: { markets: markets.length, cells: cells.length, build_ms: zipBuildMs, statuses: (zrun.markets || []).map((m) => m.status) }, completed: out.filter((r) => r.state === 'completed').length, all_ticks_within_25s: out.every((r) => r.all_ticks_within_25s), total_cost_usd: Math.round(total * 10000) / 10000, sends: out.reduce((a, r) => a + r.sends, 0), results: out }
    write('research-proof.json', summary)
    console.log(JSON.stringify({ ...summary, results: out.map((r) => ({ property: r.property, state: r.state, ticks: r.ticks, web: r.result?.web, class: r.result?.economics_class, plan: r.plan && { available: r.plan.available, reason: r.plan.reason, market_prior: r.plan.market_prior.label || r.plan.market_prior.reason }, cost: r.cost_usd })) }, null, 1))
    return summary
  }, { timeoutMs: 120_000 })
}
