/**
 * SIGNAL CENTER — persistence (service role). Every method fails CLOSED on a
 * missing schema: isMissingSchema() recognises Postgres 42P01 / 42703 and the
 * PostgREST schema-cache errors, and callers turn that into tables_ready:false.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const SIGNAL_TABLES = Object.freeze(['signal_rules', 'signal_rule_state', 'signals', 'signal_evaluator_checkpoints'])
export const CONTROL_KEY = 'signal_center_enabled'
export const ENV_CEILING = 'SIGNAL_CENTER_ENABLED'

const clean = (v) => String(v ?? '').trim()

export class SignalSchemaMissing extends Error {
  constructor(table, cause) { super(`signal schema missing: ${table}`); this.code = 'schema_missing'; this.table = table; this.cause = cause }
}

export function isMissingSchema(error) {
  if (!error) return false
  const code = clean(error.code)
  if (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(code)) return true
  const m = clean(error.message).toLowerCase()
  return m.includes('does not exist') || m.includes('schema cache') || m.includes('could not find the table') || m.includes('could not find the')
}

function check(table, { data, error }) {
  if (error) {
    if (isMissingSchema(error)) throw new SignalSchemaMissing(table, error)
    const e = new Error(`${table}: ${error.message || 'query failed'}`)
    e.code = error.code
    throw e
  }
  return data
}

export function createSignalStore(db = defaultSupabase) {
  return {
    /** Which signal tables exist (head probes; never throws). */
    async schema() {
      const missing = []
      await Promise.all(SIGNAL_TABLES.map(async (t) => {
        const { error } = await db.from(t).select('*', { count: 'exact', head: true }).limit(1)
        if (error) missing.push(isMissingSchema(error) ? t : `${t}:error`)
      }))
      // the migration also formalises the watchlist (entity columns); probe one
      const { error: wErr } = await db.from('notification_watchlist').select('entity_type').limit(1)
      const watchlistFormal = !wErr
      return { tables_ready: missing.length === 0 && watchlistFormal, missing, watchlist_formal: watchlistFormal }
    },

    async readControl(keys) {
      const { data, error } = await db.from('system_control').select('key, value, updated_at').in('key', keys)
      if (error) throw new Error(`system_control: ${error.message}`)
      const out = {}
      for (const r of data || []) out[r.key] = r.value
      return out
    },

    async listRules() { return check('signal_rules', await db.from('signal_rules').select('*').order('rule_key')) || [] },

    async setRuleEnabled(ruleKey, enabled, by) {
      const res = await db.from('signal_rules').update({ is_enabled: Boolean(enabled), updated_by: by || null }).eq('rule_key', ruleKey).select('*').maybeSingle()
      return check('signal_rules', res)
    },

    async listRuleState(ruleIds = []) {
      if (!ruleIds.length) return []
      return check('signal_rule_state', await db.from('signal_rule_state').select('*').in('rule_id', ruleIds).limit(5000)) || []
    },

    async upsertRuleState(rows = []) {
      if (!rows.length) return
      check('signal_rule_state', await db.from('signal_rule_state').upsert(rows, { onConflict: 'rule_id,subject_key' }))
    },

    /** Insert unless the dedupe_key exists. → { id, inserted } */
    async insertSignal(row) {
      const res = await db.from('signals').upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true }).select('id')
      const data = check('signals', res)
      const id = Array.isArray(data) ? data[0]?.id : data?.id
      return { id: id || null, inserted: Boolean(id) }
    },

    async linkNotification(signalId, notificationId) {
      if (!signalId || !notificationId) return
      check('signals', await db.from('signals').update({ notification_event_id: notificationId }).eq('id', signalId))
    },

    /** Resolve the open signals of one rule × subject (the condition cleared). */
    async resolveOpen(ruleKey, subjectType, subjectId, { reason, by = null, at }) {
      let q = db.from('signals').update({ status: 'resolved', resolved_at: at, resolved_by: by, resolve_reason: reason }).eq('rule_key', ruleKey).neq('status', 'resolved')
      q = subjectType ? q.eq('subject_type', subjectType) : q.is('subject_type', null)
      q = subjectId ? q.eq('subject_id', subjectId) : q.is('subject_id', null)
      check('signals', await q.select('id'))
    },

    async listSignals({ limit = 100 } = {}) {
      return check('signals', await db.from('signals').select('*').order('fired_at', { ascending: false }).limit(Math.min(200, Math.max(1, limit)))) || []
    },

    async patchSignal(id, patch) {
      return check('signals', await db.from('signals').update(patch).eq('id', id).select('*').maybeSingle())
    },

    async getSignal(id) {
      return check('signals', await db.from('signals').select('*').eq('id', id).maybeSingle())
    },

    async getCheckpoints() {
      return check('signal_evaluator_checkpoints', await db.from('signal_evaluator_checkpoints').select('*')) || []
    },

    async saveCheckpoint(row) {
      check('signal_evaluator_checkpoints', await db.from('signal_evaluator_checkpoints').upsert(row, { onConflict: 'source' }))
    },

    /* ── watchlist (works on the pre-migration table too) ── */

    async listWatches({ limit = 500 } = {}) {
      const { data, error } = await db.from('notification_watchlist').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(limit)
      if (error) throw new Error(`notification_watchlist: ${error.message}`)
      return data || []
    },

    async findWatch(watchTypes, watchKeys) {
      const { data, error } = await db.from('notification_watchlist').select('*').in('watch_type', watchTypes).in('watch_key', watchKeys).limit(10)
      if (error) throw new Error(`notification_watchlist: ${error.message}`)
      return data || []
    },

    async updateWatches(ids, patch) {
      if (!ids.length) return []
      const { data, error } = await db.from('notification_watchlist').update({ ...patch, updated_at: new Date().toISOString() }).in('id', ids).select('*')
      if (error) throw Object.assign(new Error(`notification_watchlist: ${error.message}`), { code: error.code })
      return data || []
    },

    async insertWatch(row) {
      const { data, error } = await db.from('notification_watchlist').insert(row).select('*').maybeSingle()
      if (error) throw Object.assign(new Error(`notification_watchlist: ${error.message}`), { code: error.code })
      return data
    },

    /** New Replies candidates (the bucket column); the caller applies the canonical predicate. */
    async newRepliesRows(limit = 500) {
      const { data, error } = await db.from('inbox_thread_state')
        .select('thread_key, property_id, market, is_archived, is_suppressed, latest_message_at, latest_direction, last_inbound_at, last_outbound_at, inbox_bucket, disposition, seller_display_name')
        .eq('inbox_bucket', 'new_replies').limit(limit)
      if (error) throw new Error(`inbox_thread_state: ${error.message}`)
      return data || []
    },
  }
}
