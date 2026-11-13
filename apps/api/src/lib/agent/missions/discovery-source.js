// Acquisition discovery — the bounded, incremental, READ-ONLY source.
//
// Watermark: eg_property_facts is rebuilt as a whole (refreshed_at is one
// timestamp per build — prod 10-14: 176,702 rows, one refreshed_at), so "changed"
// means "in a build newer than the last finished pass". A pass walks the build by
// property_id (the primary key: an index-only range scan, `property_id > $after
// ORDER BY property_id LIMIT n`); the cursor is stored in the schedule watermark.
// A new build (max(refreshed_at), egpf_refreshed_at index) restarts the pass.
//
// Columns are an explicit whitelist: no names, phones, e-mails, addresses, or
// protected-class fields. Two implementations of one interface:
//   createDiscoverySupabaseSource({ db })  production: the guarded GET-only PostgREST
//                                          read client (quick-scan/read-client.js)
//   createDiscoverySqlSource({ query })    a read-only SQL runner (local PG / the
//                                          read-only proof over the pooler)
export const FACT_COLUMNS = Object.freeze(['property_id', 'market', 'property_address_state', 'zip_code', 'asset_type', 'property_type', 'units_count', 'estimated_value', 'equity_known_pct', 'equity_percent', 'ownership_years', 'is_corporate_owner', 'out_of_state_owner', 'tax_delinquent', 'tax_delinquent_year', 'active_lien', 'is_hot_preforeclosure', 'rec_has_probate', 'rec_has_lis_pendens', 'rec_has_default_notice', 'rec_has_tax_lien', 'rec_has_judgment', 'rec_foreclosure_stage', 'rec_has_death_record', 'distress_signal_count', 'signal_labels', 'sms_status', 'contact_identity', 'contact_candidate_phones', 'last_contact_at', 'campaign_count', 'pipeline_stage', 'conversation_stage', 'scores_aos_score', 'refreshed_at'])
export const CONTACT_COLUMNS = Object.freeze(['property_id', 'identity_alignment', 'sms_eligible', 'wrong_number', 'true_post_contact_suppression', 'pending_prior_touch', 'active_queue_item', 'last_outbound_at', 'latest_contact_at', 'touch_count'])
export const PROBATE_COLUMNS = Object.freeze(['property_id', 'has_death_record', 'only_deceased_reachable', 'exclude_targeting', 'reachable_living_dm'])

const CHUNK = 150
const chunks = (ids) => { const out = []; for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK)); return out }
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const unavailable = (what, error) => Object.assign(new Error(`${what} read failed`), { code: String(error?.code || '') === 'PGRST205' || String(error?.code || '') === '42P01' ? 'SOURCE_NOT_APPLIED' : 'SOURCE_UNAVAILABLE', source: what })

export function createDiscoverySupabaseSource({ db }) {
  const read = async (q, what) => {
    const { data, error } = await q
    if (error) throw unavailable(what, error)
    return Array.isArray(data) ? data : data ? [data] : []
  }
  return Object.freeze({
    kind: 'postgrest',
    async generation() {
      const rows = await read(db.from('eg_property_facts').select('refreshed_at').order('refreshed_at', { ascending: false }).limit(1), 'eg_property_facts')
      return iso(rows[0]?.refreshed_at)
    },
    async scan({ after = '', limit = 200 }) {
      let q = db.from('eg_property_facts').select(FACT_COLUMNS.join(','))
      if (after) q = q.gt('property_id', after)
      return read(q.order('property_id', { ascending: true }).limit(Math.min(Math.max(limit, 1), 1000)), 'eg_property_facts')
    },
    async contacts(ids) {
      const out = []
      for (const c of chunks(ids)) out.push(...(await read(db.from('campaign_target_graph').select(CONTACT_COLUMNS.join(',')).in('property_id', c).limit(c.length * 20), 'campaign_target_graph')))
      return out
    },
    async probate(ids) {
      const out = []
      for (const c of chunks(ids)) out.push(...(await read(db.from('probate_status').select(PROBATE_COLUMNS.join(',')).in('property_id', c).limit(c.length), 'probate_status').catch((e) => { if (e.code === 'SOURCE_NOT_APPLIED') return []; throw e })))
      return out
    },
    async campaignMembers(ids) {
      const out = new Set()
      for (const c of chunks(ids)) for (const r of await read(db.from('campaign_targets').select('property_id').in('property_id', c).limit(c.length * 50), 'campaign_targets')) out.add(String(r.property_id))
      return out
    },
  })
}

/** @param {{ query: (sql: string, params: any[]) => Promise<Array<object>> }} o  query MUST run read-only */
export function createDiscoverySqlSource({ query }) {
  const cols = (list) => list.map((c) => `"${c}"`).join(', ')
  return Object.freeze({
    kind: 'sql',
    async generation() {
      const r = await query('select max(refreshed_at) g from public.eg_property_facts', [])
      return iso(r[0]?.g)
    },
    async scan({ after = '', limit = 200 }) {
      return query(`select ${cols(FACT_COLUMNS)} from public.eg_property_facts where property_id > $1 order by property_id limit $2`, [after || '', Math.min(Math.max(limit, 1), 1000)])
    },
    async contacts(ids) {
      const out = []
      for (const c of chunks(ids)) out.push(...(await query(`select ${cols(CONTACT_COLUMNS)} from public.campaign_target_graph where property_id = any($1::text[]) limit $2`, [c, c.length * 20])))
      return out
    },
    async probate(ids) {
      const out = []
      for (const c of chunks(ids)) out.push(...(await query(`select ${cols(PROBATE_COLUMNS)} from public.probate_status where property_id = any($1::text[])`, [c])))
      return out
    },
    async campaignMembers(ids) {
      const out = new Set()
      for (const c of chunks(ids)) for (const r of await query('select distinct property_id from public.campaign_targets where property_id = any($1::text[])', [c])) out.add(String(r.property_id))
      return out
    },
  })
}
