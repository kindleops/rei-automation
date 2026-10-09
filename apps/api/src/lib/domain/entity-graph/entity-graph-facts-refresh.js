/**
 * ENTITY GRAPH · eg_property_facts REFRESH JOB (PROPOSED — inert until the
 * owner applies the migration AND sets EG_FACTS_REFRESH_ENABLED=true).
 *
 * Computes every fact column with the registry (entity-graph-facts.js — the
 * same functions the grid cells render from) and upserts it into
 * public.eg_property_facts. Two modes:
 *
 *   full         every property, in property_id chunks; source tables read
 *                with one sequential scan per chunk (random index reads are
 *                the slow path on prod). Rows not touched by a full run (a
 *                property deleted since) are removed. Proposed cadence: daily
 *                at 09:30 UTC, after refresh_entity_graph_read_model (09:17).
 *   incremental  only properties whose inputs changed since the last
 *                successful run's start (properties.updated_at, campaign graph
 *                built_at / generated_at, inbox_thread_state.updated_at,
 *                acquisition_opportunities.updated_at, campaign_targets.updated_at,
 *                property_record_summary.refreshed_at, property_acquisition_scores.computed_at,
 *                master_owners.updated_at, seller.property_entity_contact_v1.built_at),
 *                keyed reads. Proposed cadence: every 5 minutes.
 *
 * Every run writes one public.eg_refresh_log row (running → ok | failed); only
 * an ok row advances the "as of" the grid shows. One run at a time
 * (pg_try_advisory_lock). Nothing here sends, mutates seller state, or touches
 * a source table.
 */
import { getPgPool } from '@/lib/postgres/client.js'
import { COMPUTED_FACTS, baseColumnsFor, computeFacts, plainColumnType } from './entity-graph-facts.js'
import { FACTS_TABLE_NAME, factsTableColumns } from './entity-graph-facts-ddl.js'

const LOCK_KEY = 917_200_9 // eg_property_facts refresh
const FULL_CHUNK = 25_000
const UPSERT_BATCH = 2_000
const INCREMENTAL_CAP = 20_000
const q = (c) => `"${c}"`

export function refreshEnabled(env = process.env) {
  return String(env?.EG_FACTS_REFRESH_ENABLED ?? '').toLowerCase() === 'true'
}

/** Changed property ids since `since` (one statement per source, keyed by their own indexes). */
export const CHANGED_IDS_SQL = `
  select property_id from public.properties where updated_at > $1
  union select property_id from public.campaign_target_graph where coalesce(built_at, generated_at) > $1
  union select property_id from public.inbox_thread_state where updated_at > $1 and property_id is not null
  union select primary_property_id from public.acquisition_opportunities where updated_at > $1 and primary_property_id is not null
  union select property_id from public.campaign_targets where updated_at > $1 and property_id is not null
  union select property_id from public.property_record_summary where refreshed_at > $1
  union select property_id from public.property_acquisition_scores where computed_at > $1
  union select p.property_id from public.properties p join public.master_owners m on m.master_owner_id = p.master_owner_id where m.updated_at > $1
  union select property_id from seller.property_entity_contact_v1 where built_at > $1`

/**
 * @returns {{ ok, mode, rows, ms, logId, skipped? }}
 */
export async function refreshPropertyFacts({ mode = 'incremental', pool = null, now = () => new Date(), env = process.env, log = () => {} } = {}) {
  if (!refreshEnabled(env)) return { ok: false, skipped: 'EG_FACTS_REFRESH_ENABLED is not true' }
  const client = await (pool || getPgPool()).connect()
  const started = Date.now()
  let logId = null
  try {
    await client.query(`set statement_timeout = '60s'`)
    const present = await client.query(`select to_regclass('public.${FACTS_TABLE_NAME}') is not null as t, to_regclass('public.eg_refresh_log') is not null as l`)
    if (!present.rows[0]?.t || !present.rows[0]?.l) return { ok: false, skipped: 'read model not applied' }
    const locked = await client.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEY])
    if (!locked.rows[0]?.ok) return { ok: false, skipped: 'another refresh holds the lock' }
    try {
      const last = await client.query(`select started_at from public.eg_refresh_log where name = $1 and status = 'ok' order by finished_at desc limit 1`, [FACTS_TABLE_NAME])
      const watermark = last.rows[0]?.started_at || null
      const effective = mode === 'incremental' && !watermark ? 'full' : mode
      const runAt = now()
      const ins = await client.query(`insert into public.eg_refresh_log (name, mode, status, started_at, watermark) values ($1, $2, 'running', $3, $4) returning id`, [FACTS_TABLE_NAME, effective, runAt, watermark])
      logId = ins.rows[0].id
      const query = (sql, params, timeoutMs) => client.query({ text: sql, values: params }).then((r) => r)
      const allComputed = COMPUTED_FACTS.map((f) => f.col)
      const columns = factsTableColumns()
      const baseCols = [...new Set([...columns.filter((c) => c.plain || c.col === 'property_id').map((c) => c.col), ...baseColumnsFor(allComputed)])].filter((c) => c === 'property_id' || plainColumnType(c))

      let rows = 0
      const writeChunk = async (baseRows, { keyedMax }) => {
        const facts = await computeFacts(baseRows, allComputed, { query, timeoutMs: 60_000, now: runAt, keyedMax })
        const records = baseRows.map((r) => {
          const id = String(r.property_id)
          const f = facts.get(id) || {}
          const o = {}
          for (const c of columns) {
            let v = c.plain || c.col === 'property_id' ? r[c.col] : f[c.col]
            if (v instanceof Date) v = v.toISOString()
            o[c.col] = v === undefined ? null : v
          }
          o.refreshed_at = runAt.toISOString()
          return o
        })
        const set = columns.filter((c) => c.col !== 'property_id').map((c) => `${q(c.col)} = excluded.${q(c.col)}`).concat(['"refreshed_at" = excluded."refreshed_at"']).join(', ')
        const list = [...columns.map((c) => q(c.col)), '"refreshed_at"'].join(', ')
        for (let i = 0; i < records.length; i += UPSERT_BATCH) {
          await client.query(
            `insert into public.${FACTS_TABLE_NAME} (${list})
             select ${list} from jsonb_populate_recordset(null::public.${FACTS_TABLE_NAME}, $1::jsonb)
             on conflict ("property_id") do update set ${set}`,
            [JSON.stringify(records.slice(i, i + UPSERT_BATCH))],
          )
        }
        rows += records.length
      }

      if (effective === 'full') {
        let afterId = ''
        for (;;) {
          const chunk = await client.query(`select ${baseCols.map(q).join(', ')} from public.v_entity_graph_properties where "property_id" > $1 order by "property_id" limit ${FULL_CHUNK}`, [afterId])
          if (!chunk.rows.length) break
          await writeChunk(chunk.rows, { keyedMax: 0 })
          afterId = String(chunk.rows[chunk.rows.length - 1].property_id)
          log({ phase: 'full_chunk', rows, afterId })
          if (chunk.rows.length < FULL_CHUNK) break
        }
        // a property gone from the source since the last full run
        await client.query(`delete from public.${FACTS_TABLE_NAME} where refreshed_at < $1`, [runAt])
      } else {
        const changed = await client.query(CHANGED_IDS_SQL, [watermark])
        const ids = [...new Set(changed.rows.map((r) => String(r.property_id)).filter(Boolean))]
        if (ids.length > INCREMENTAL_CAP) {
          await client.query(`update public.eg_refresh_log set status = 'failed', finished_at = now(), error = $2 where id = $1`, [logId, `incremental would touch ${ids.length} properties (> ${INCREMENTAL_CAP}); run full`])
          return { ok: false, mode: effective, rows: 0, ms: Date.now() - started, logId, skipped: 'incremental_too_large' }
        }
        for (let i = 0; i < ids.length; i += 5_000) {
          const part = ids.slice(i, i + 5_000)
          const base = await client.query(`select ${baseCols.map(q).join(', ')} from public.v_entity_graph_properties where "property_id" = any($1::text[])`, [part])
          await writeChunk(base.rows, { keyedMax: 5_000 })
          const gone = part.filter((id) => !base.rows.some((r) => String(r.property_id) === id))
          if (gone.length) await client.query(`delete from public.${FACTS_TABLE_NAME} where "property_id" = any($1::text[])`, [gone])
        }
      }
      await client.query(`update public.eg_refresh_log set status = 'ok', finished_at = now(), rows = $2, detail = $3::jsonb where id = $1`, [logId, rows, JSON.stringify({ ms: Date.now() - started })])
      return { ok: true, mode: effective, rows, ms: Date.now() - started, logId }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    }
  } catch (error) {
    if (logId) await client.query(`update public.eg_refresh_log set status = 'failed', finished_at = now(), error = $2 where id = $1`, [logId, String(error?.message || error).slice(0, 500)]).catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
