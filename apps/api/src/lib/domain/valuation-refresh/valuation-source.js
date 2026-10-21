// ─── VALUATION REFRESH — READ-ONLY CANDIDATE SOURCES (8.5.21-b) ──────────────
//   createValuationSqlSource({ query })        a read-only SQL runner (local PG / the live proof
//                                              inside BEGIN READ ONLY)
//   createValuationSupabaseSource({ db })      the guarded GET-only PostgREST read client
// interface: candidates({ limit }) → rows for valuation-queue.classifyValuationCandidate
//   (property_id, opportunity_id, stage, status, asking_price, current_offer, offers_sent, intents[],
//    latest_intent, is_suppressed, disposition, contactability_status, score_computed_at, decision_tier,
//    engine_version, last_activity_at, updated_at)
// Ids and flags only: no names, phones, addresses or message bodies are selected.

export const VALUATION_CANDIDATES_SQL = `
select o.id::text as opportunity_id, o.primary_property_id as property_id, o.acquisition_stage as stage, o.opportunity_status as status,
       o.asking_price, o.current_offer, o.latest_intent, o.updated_at, o.last_activity_at,
       s.computed_at as score_computed_at, s.decision_tier, s.engine_version,
       t.is_suppressed, t.disposition, t.contactability_status,
       (select array_agg(distinct m.detected_intent) from public.message_events m
         where m.thread_key = o.primary_thread_key and m.direction = 'inbound' and m.detected_intent is not null) as intents,
       (select count(*)::int from public.seller_offers so where so.opportunity_id = o.id and so.sent_at is not null) as offers_sent
  from public.acquisition_opportunities o
  left join lateral (select x.computed_at, x.decision_tier, x.evidence->'engine'->>'version' as engine_version
                       from public.property_acquisition_scores x where x.property_id = o.primary_property_id
                      order by x.computed_at desc nulls last limit 1) s on true
  left join public.inbox_thread_state t on t.thread_key = o.primary_thread_key
 where o.primary_property_id is not null and o.opportunity_status in ('active', 'nurture')
 order by o.updated_at desc nulls last
 limit $1`

const clamp = (n, d = 300) => Math.min(Math.max(Math.trunc(Number(n) || d), 1), 2000)

export function createValuationSqlSource({ query }) {
  return Object.freeze({
    kind: 'sql',
    candidates: async ({ limit = 300 } = {}) => query(VALUATION_CANDIDATES_SQL, [clamp(limit)]),
  })
}

/** Production: bounded GET reads through the guarded PostgREST read client (no joins: merged here). */
export function createValuationSupabaseSource({ db }) {
  const read = async (q) => { const { data, error } = await q; if (error) throw Object.assign(new Error('VALUATION_SOURCE_READ_FAILED'), { code: 'SOURCE_UNAVAILABLE' }); return data || [] }
  return Object.freeze({
    kind: 'postgrest',
    async candidates({ limit = 300 } = {}) {
      const opps = await read(db.from('acquisition_opportunities').select('id,primary_property_id,primary_thread_key,acquisition_stage,opportunity_status,asking_price,current_offer,latest_intent,updated_at,last_activity_at').in('opportunity_status', ['active', 'nurture']).not('primary_property_id', 'is', null).order('updated_at', { ascending: false }).limit(clamp(limit)))
      const pids = [...new Set(opps.map((o) => String(o.primary_property_id)))]
      const threads = [...new Set(opps.map((o) => o.primary_thread_key).filter(Boolean))]
      const scores = new Map()
      const states = new Map()
      const intents = new Map()
      const offers = new Map()
      for (let i = 0; i < pids.length; i += 150) {
        for (const r of await read(db.from('property_acquisition_scores').select('property_id,computed_at,decision_tier,engine_version:evidence->engine->>version').in('property_id', pids.slice(i, i + 150)).limit(1500))) {
          const prev = scores.get(String(r.property_id))
          if (!prev || Date.parse(r.computed_at) > Date.parse(prev.computed_at)) scores.set(String(r.property_id), r)
        }
      }
      for (let i = 0; i < threads.length; i += 150) {
        const slice = threads.slice(i, i + 150)
        for (const r of await read(db.from('inbox_thread_state').select('thread_key,is_suppressed,disposition,contactability_status').in('thread_key', slice).limit(1500))) states.set(r.thread_key, r)
        for (const r of await read(db.from('message_events').select('thread_key,detected_intent').in('thread_key', slice).eq('direction', 'inbound').not('detected_intent', 'is', null).limit(5000))) {
          if (!intents.has(r.thread_key)) intents.set(r.thread_key, new Set())
          intents.get(r.thread_key).add(r.detected_intent)
        }
      }
      const oppIds = opps.map((o) => o.id)
      for (let i = 0; i < oppIds.length; i += 150) for (const r of await read(db.from('seller_offers').select('opportunity_id').in('opportunity_id', oppIds.slice(i, i + 150)).not('sent_at', 'is', null).limit(1500))) offers.set(r.opportunity_id, (offers.get(r.opportunity_id) || 0) + 1)
      return opps.map((o) => {
        const s = scores.get(String(o.primary_property_id)) || {}
        const t = states.get(o.primary_thread_key) || {}
        return { opportunity_id: o.id, property_id: String(o.primary_property_id), stage: o.acquisition_stage, status: o.opportunity_status, asking_price: o.asking_price, current_offer: o.current_offer, latest_intent: o.latest_intent, updated_at: o.updated_at, last_activity_at: o.last_activity_at, score_computed_at: s.computed_at || null, decision_tier: s.decision_tier || null, engine_version: s.engine_version || null, is_suppressed: t.is_suppressed ?? null, disposition: t.disposition ?? null, contactability_status: t.contactability_status ?? null, intents: [...(intents.get(o.primary_thread_key) || [])], offers_sent: offers.get(o.id) || 0 }
      })
    },
  })
}
