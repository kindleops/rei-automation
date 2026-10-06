// ─── scoringBackfillStore.js ────────────────────────────────────────────────
// Supabase-backed side effects for scoringBackfill.js. The policy module never
// touches the database directly; everything it needs is here, so tests inject
// an in-memory store instead.
//
// Writes performed (live mode only):
//   * system_control[acquisition_scoring_backfill]   run state / cursor
//   * property_acquisition_scores                    upsert on property_id
// Never written: acquisition_score_snapshots (backfill rows are not monetary
// authority), properties (the legacy final_acquisition_score is untouched).

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { readFeatureFlag } from './modelConstants.js';
import { scoreProperty } from './acquisitionDecisionEngine.js';
import {
  BACKFILL_STATE_KEY,
  SCORING_VERSION,
  SCOPE_KINDS,
  CAMPAIGN_SCOPE_STATUSES,
  CAMPAIGN_BUILT_STATUSES,
  QUEUE_ELIGIBLE_TARGET_STATUSES,
  buildBackfillRow,
} from './scoringBackfill.js';

const SCORE_TABLE = 'property_acquisition_scores';

function clean(value) {
  return String(value ?? '').trim();
}

function isMissingColumn(error) {
  const m = clean(error?.message).toLowerCase();
  return error?.code === '42703' || error?.code === 'PGRST204' || (m.includes('column') && m.includes('does not exist'));
}

export function createScoringBackfillStore({ supabase = null, engineDeps = {}, v3Enabled = null, stateKey = BACKFILL_STATE_KEY, ensureDecision = null } = {}) {
  const db = supabase ?? getDefaultSupabaseClient();
  const v3 = v3Enabled ?? readFeatureFlag('ACQUISITION_ENGINE_V3_ENABLED');
  let versionColumns = null; // tri-state cache: null unknown, true present, false absent

  async function hasVersionColumns() {
    if (versionColumns !== null) return versionColumns;
    const { error } = await db.from(SCORE_TABLE).select('property_id,scoring_version,scored_at').limit(0);
    if (error && !isMissingColumn(error)) throw error;
    versionColumns = !error;
    return versionColumns;
  }

  return {
    hasVersionColumns,

    async readState() {
      const { data, error } = await db.from('system_control').select('value').eq('key', stateKey).maybeSingle();
      if (error) throw error;
      return data?.value ?? null;
    },

    async writeState(state) {
      const { error } = await db
        .from('system_control')
        .upsert({ key: stateKey, value: JSON.stringify(state), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
    },

    async readContactWindow() {
      const { data, error } = await db
        .from('system_control')
        .select('key,value')
        .in('key', ['queue_contact_window_start', 'queue_contact_window_end']);
      if (error) throw error;
      const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
      return { start: m.queue_contact_window_start ?? '08:00', end: m.queue_contact_window_end ?? '21:00' };
    },

    /** PROPOSED RPC (migration PROPOSED_20261004000000). Missing => fail closed. */
    async probeLoad() {
      const t0 = Date.now();
      const { data, error } = await db.rpc('scoring_backfill_load_probe', { p_long_running_seconds: 20 });
      const latency_ms = Date.now() - t0;
      if (error) return { ok: false, error: clean(error.message) || 'probe_failed', latency_ms };
      const row = Array.isArray(data) ? data[0] : data;
      return { ok: true, latency_ms, ...(row || {}) };
    },

    /**
     * Campaign scope: the campaign ids whose targets are scored. Explicit ids
     * win; otherwise every active/scheduled campaign (all queue-eligible
     * targets) plus built campaigns (queue-eligible targets only).
     */
    async resolveCampaignIds(scope = {}) {
      if (Array.isArray(scope?.campaign_ids) && scope.campaign_ids.length) return scope.campaign_ids;
      const { data, error } = await db
        .from('campaigns')
        .select('id,status')
        .in('status', [...CAMPAIGN_SCOPE_STATUSES, ...CAMPAIGN_BUILT_STATUSES]);
      if (error) throw error;
      return (data || []).map((r) => clean(r.id)).filter(Boolean);
    },

    /** Keyset page over properties.property_id (uq_properties_property_id); campaign scope pages campaign_targets.property_id. */
    async loadPropertyPage({ afterPropertyId = null, limit = 200, scope = null } = {}) {
      if (scope?.kind === SCOPE_KINDS.CAMPAIGN) {
        const ids = await this.resolveCampaignIds(scope);
        if (!ids.length) return [];
        let q = db
          .from('campaign_targets')
          .select('property_id')
          .in('campaign_id', ids)
          .not('property_id', 'is', null)
          .order('property_id', { ascending: true })
          .limit(limit);
        if (!scope.include_blocked) q = q.in('target_status', QUEUE_ELIGIBLE_TARGET_STATUSES);
        if (clean(afterPropertyId)) q = q.gt('property_id', clean(afterPropertyId));
        const { data, error } = await q;
        if (error) throw error;
        // The same property can be a target of two campaigns: one score each.
        return [...new Set((data || []).map((r) => clean(r.property_id)).filter(Boolean))];
      }
      let q = db.from('properties').select('property_id').order('property_id', { ascending: true }).limit(limit);
      if (clean(afterPropertyId)) q = q.gt('property_id', clean(afterPropertyId));
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map((r) => clean(r.property_id)).filter(Boolean);
    },

    async loadExistingScores(propertyIds = []) {
      if (!propertyIds.length) return [];
      const withVersion = await hasVersionColumns();
      // decision_tier / offer / ceiling / evidence_mode let the campaign scope
      // apply the offer-ready predicate without reading full evidence.
      const base = 'property_id,computed_at,decision_tier,recommended_cash_offer,engine_version:evidence->engine->>version,evidence_mode:evidence->backfill->>evidence_mode,mao:evidence->offer_calculation->>effective_authorized_ceiling';
      const select = withVersion ? `${base},scoring_version` : base;
      const { data, error } = await db.from(SCORE_TABLE).select(select).in('property_id', propertyIds);
      if (error) throw error;
      // Re-shape the projected ceiling so evaluateOfferReadiness reads it.
      return (data || []).map((r) => ({
        ...r,
        evidence: { offer_calculation: { effective_authorized_ceiling: r.mao ?? null }, ...(r.evidence_mode ? { backfill: { evidence_mode: r.evidence_mode, monetary_authority: false } } : {}) },
      }));
    },

    /**
     * Run the canonical engine for one property. Live: upsert a compact,
     * version-stamped projection row; no snapshot; no decision-input stamp.
     * Dry run: identical computation, persister returns the row unwritten.
     */
    async scoreOne(propertyId, { dryRun = false, runId = null, now = new Date() } = {}) {
      if (!dryRun && !(await hasVersionColumns())) {
        return { ok: false, error: 'migration_not_applied:scoring_version_columns' };
      }
      let rowBytes = null;
      const result = await scoreProperty(propertyId, {
        ...engineDeps,
        supabase: db,
        now,
        v3Enabled: v3,
        decisionInputStamp: undefined,
        persistImmutableScoreSnapshot: async () => null,
        persistAcquisitionScore: async (row) => {
          const out = buildBackfillRow(row, { runId, now, v3Enabled: v3 });
          rowBytes = Buffer.byteLength(JSON.stringify(out));
          if (dryRun) return out;
          const { data, error } = await db.from(SCORE_TABLE).upsert(out, { onConflict: 'property_id' }).select('id,property_id').single();
          if (error) throw error;
          return { ...out, ...data };
        },
      });
      return { ok: Boolean(result?.ok), error: result?.error ?? null, row_bytes: rowBytes, aos_score: result?.score?.aos_score ?? null };
    },

    /**
     * Campaign scope: the canonical monetary path (snapshot + decision-input
     * stamp). Dry run never calls it — it scores read-only through scoreOne's
     * engine path with the persister returning the row unwritten.
     */
    async scoreOneMonetary(propertyId, { dryRun = false, runId = null, now = new Date() } = {}) {
      if (dryRun) return this.scoreOne(propertyId, { dryRun: true, runId, now });
      const ensure = ensureDecision
        ?? (await import('./decisionAuthority.js')).ensurePropertyAcquisitionDecision;
      const ensured = await ensure(propertyId, { now, reason: 'campaign_offer_ready_scoring', deps: { supabase: db } });
      const failed = ensured?.status === 'decision_engine_failed' || Boolean(ensured?.error);
      return {
        ok: !failed,
        error: failed ? clean(ensured?.error) || 'engine_failed' : null,
        decision_status: ensured?.status ?? null,
        reused: ensured?.ran === false,
        tier: ensured?.decision?.decision_tier ?? null,
        row_bytes: ensured?.decision ? Buffer.byteLength(JSON.stringify(ensured.decision)) : null,
      };
    },
  };
}

export { SCORING_VERSION };
export default createScoringBackfillStore;
