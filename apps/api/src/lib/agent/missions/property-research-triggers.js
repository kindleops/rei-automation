// property.research triggers (8.5.20-b) — event + sweep enqueue. OFF BY DEFAULT, twice:
//   • code gate  PROPERTY_RESEARCH_ENABLED=1 (absent ⇒ every call returns disabled, nothing enqueued)
//   • DB gate    agent.runtime_limits.kind_limits['property.research'] must be armed by a named
//                operator (runtime_enqueue_event refuses 'kind_not_armed') and enabled to be claimed.
//
// Triggers (owner directive):
//   opportunity_entered        a property entered the opportunity pipeline
//   asking_price_revealed      the seller stated (or changed) an asking price
//   valuation_stale_or_missing no / stale / non-offer-ready Decision Engine row
//   new_comp_evidence          new sold evidence near the property
//   market_shift               the ZIP model / market aggregates moved
//   recovery_finding           a recovery pass surfaced the property
// The event key dedupes: one job per (trigger, property, discriminator) — the discriminator is
// the ask amount, the score computed_at, the comp batch id, or a day bucket.
import { runtimeIdempotencyKey } from '../runtime/job-runtime.js'
import { encodePropertyRef } from './mission-codec.js'
import { PROPERTY_RESEARCH_KIND } from './property-research-handler.js'

export const PROPERTY_RESEARCH_FLAG = 'PROPERTY_RESEARCH_ENABLED'
export const PROPERTY_RESEARCH_TRIGGERS = Object.freeze(['opportunity_entered', 'asking_price_revealed', 'valuation_stale_or_missing', 'new_comp_evidence', 'market_shift', 'recovery_finding'])
export const PROPERTY_RESEARCH_SWEEP = Object.freeze({ name: 'property-research-sweep', kind: 'property.research_sweep', interval_seconds: 6 * 3600, max_per_sweep: 25, stale_days: 30 })

export function propertyResearchEnabled(env = process.env) {
  return String(env?.[PROPERTY_RESEARCH_FLAG] ?? '').trim() === '1'
}

/** Deterministic, PII-free event key (sha256 hex; the runtime hashes again with the kind). */
export function propertyResearchEventKey({ trigger, property_id, discriminator = null, now = Date.now() }) {
  const day = new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString().slice(0, 10)
  return runtimeIdempotencyKey('property.research', trigger, encodePropertyRef(String(property_id)), discriminator == null ? `day:${day}` : String(discriminator).slice(0, 80))
}

/**
 * Enqueue one property.research job for an event.
 * @param {{ store: { enqueueEvent: Function }, env?: object, trigger: string, property_id: string, discriminator?: string|number|null, web?: boolean, priority?: number, now?: number }} o
 */
export async function enqueuePropertyResearch({ store, env = process.env, trigger, property_id, discriminator = null, web = true, priority = 120, now = Date.now() }) {
  if (!propertyResearchEnabled(env)) return { ok: false, reason: 'PROPERTY_RESEARCH_DISABLED' }
  if (!PROPERTY_RESEARCH_TRIGGERS.includes(trigger)) return { ok: false, reason: 'TRIGGER_INVALID' }
  const id = String(property_id ?? '').trim()
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) return { ok: false, reason: 'PROPERTY_ID_INVALID' }
  const event_key = propertyResearchEventKey({ trigger, property_id: id, discriminator, now })
  const r = await store.enqueueEvent({ kind: PROPERTY_RESEARCH_KIND, event_key, input: { property_ref: encodePropertyRef(id), trigger, web: web !== false }, priority })
  return r?.ok ? { ok: true, job_id: r.job_id, deduped: Boolean(r.deduped) } : { ok: false, reason: String(r?.reason || 'ENQUEUE_REFUSED') }
}

/**
 * Sweep: properties in the opportunity pipeline whose valuation is missing / stale, or whose
 * recorded ask is newer than the score. Bounded; each candidate is one event enqueue (deduped).
 * @param {{ store: object, sweepSource: { candidates: Function }, env?: object, now?: number, limit?: number }} o
 */
export async function sweepPropertyResearch({ store, sweepSource, env = process.env, now = Date.now(), limit = PROPERTY_RESEARCH_SWEEP.max_per_sweep }) {
  if (!propertyResearchEnabled(env)) return { ok: true, skipped: 'PROPERTY_RESEARCH_DISABLED', enqueued: 0 }
  const cands = await sweepSource.candidates({ limit: Math.min(Math.max(Number(limit) || 1, 1), 100), stale_days: PROPERTY_RESEARCH_SWEEP.stale_days, now })
  const out = { ok: true, scanned: cands.length, enqueued: 0, deduped: 0, refused: {} }
  for (const c of cands) {
    const r = await enqueuePropertyResearch({ store, env, trigger: c.trigger, property_id: c.property_id, discriminator: c.discriminator ?? null, now })
    if (r.ok && r.deduped) out.deduped += 1
    else if (r.ok) out.enqueued += 1
    else out.refused[r.reason] = (out.refused[r.reason] || 0) + 1
  }
  return out
}

/** Read-only SQL sweep source: pipeline properties with a missing / stale score or an ask newer than it. */
export function createPropertyResearchSweepSqlSource({ query }) {
  return Object.freeze({
    async candidates({ limit = 25, stale_days = 30 } = {}) {
      const rows = await query(`
        select o.primary_property_id as property_id, o.asking_price, o.updated_at, s.computed_at
          from public.acquisition_opportunities o
          left join lateral (select computed_at from public.property_acquisition_scores p where p.property_id = o.primary_property_id order by computed_at desc limit 1) s on true
         where o.primary_property_id is not null
           and coalesce(o.opportunity_status, 'open') not in ('closed', 'dead', 'archived')
           and (s.computed_at is null or s.computed_at < now() - make_interval(days => $1) or (o.asking_price > 0 and o.updated_at > s.computed_at))
         order by o.updated_at desc
         limit $2`, [stale_days, limit])
      return rows.map((r) => ({
        property_id: String(r.property_id),
        trigger: Number(r.asking_price) > 0 && r.computed_at && Date.parse(r.updated_at) > Date.parse(r.computed_at) ? 'asking_price_revealed' : 'valuation_stale_or_missing',
        discriminator: Number(r.asking_price) > 0 ? `ask:${Math.round(Number(r.asking_price))}` : `score:${r.computed_at ? new Date(r.computed_at).toISOString().slice(0, 10) : 'none'}`,
      }))
    },
  })
}

/** Production sweep source: two bounded GET reads through the guarded PostgREST read client. */
export function createPropertyResearchSweepSupabaseSource({ db }) {
  const read = async (q) => { const { data, error } = await q; if (error) throw Object.assign(new Error('SWEEP_READ_FAILED'), { code: 'SOURCE_UNAVAILABLE' }); return data || [] }
  return Object.freeze({
    async candidates({ limit = 25, stale_days = 30, now = Date.now() } = {}) {
      const opps = await read(db.from('acquisition_opportunities').select('primary_property_id,asking_price,updated_at,opportunity_status').not('primary_property_id', 'is', null).order('updated_at', { ascending: false }).limit(Math.min(limit * 4, 400)))
      const open = opps.filter((o) => !['closed', 'dead', 'archived'].includes(String(o.opportunity_status || 'open')))
      const ids = [...new Set(open.map((o) => String(o.primary_property_id)))]
      const scores = new Map()
      for (let i = 0; i < ids.length; i += 150) for (const r of await read(db.from('property_acquisition_scores').select('property_id,computed_at').in('property_id', ids.slice(i, i + 150)).limit(1500))) {
        const prev = scores.get(String(r.property_id))
        if (!prev || Date.parse(r.computed_at) > Date.parse(prev)) scores.set(String(r.property_id), r.computed_at)
      }
      const staleBefore = now - stale_days * 864e5
      const out = []
      for (const o of open) {
        const id = String(o.primary_property_id)
        if (out.some((x) => x.property_id === id)) continue
        const at = scores.get(id) || null
        const askNewer = Number(o.asking_price) > 0 && at && Date.parse(o.updated_at) > Date.parse(at)
        if (at && Date.parse(at) >= staleBefore && !askNewer) continue
        out.push({ property_id: id, trigger: askNewer ? 'asking_price_revealed' : 'valuation_stale_or_missing', discriminator: Number(o.asking_price) > 0 ? `ask:${Math.round(Number(o.asking_price))}` : `score:${at ? new Date(at).toISOString().slice(0, 10) : 'none'}` })
        if (out.length >= limit) break
      }
      return out
    },
  })
}

/** Runtime handler for the sweep kind (a schedule may run it; born disabled like every schedule). */
export function createPropertyResearchSweepHandler({ runtimeStore, sweepSource, env = process.env, now = () => Date.now() }) {
  return Object.freeze({
    kind: PROPERTY_RESEARCH_SWEEP.kind,
    async run(ctx) {
      await ctx.step('sweep', { progress: { step: 'sweep', steps_done: 0, steps_total: 1, pct: 10 }, checkpoint: {} })
      const r = await sweepPropertyResearch({ store: runtimeStore, sweepSource, env, now: now(), limit: Number(ctx.job.input?.limit) || PROPERTY_RESEARCH_SWEEP.max_per_sweep })
      return { result: { mission: 'property_research_sweep', ...r } }
    },
  })
}
