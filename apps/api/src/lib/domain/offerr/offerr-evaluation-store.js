/**
 * Offerr Evaluation Spine — persistence store.
 *
 * Backing tables (additive, PROPOSED migration — see
 * apps/api/supabase/migrations/PROPOSED_20260729120000_offerr_evaluation_spine.sql):
 *   - offerr_evaluation_requests  : one row per intake, UNIQUE(idempotency_key)
 *   - offerr_evaluations          : versioned immutable evaluation snapshots
 *   - offerr_evaluation_events    : append-only lifecycle/audit ledger
 *
 * Idempotency follows the repo's DB-unique-key pattern (acquisition_events /
 * acquisition_opportunity_history): the UNIQUE constraint is the authority and
 * a 23505 conflict resolves by re-reading the winner.
 *
 * The in-memory store implements the identical interface for tests and is the
 * behavioral reference. Neither store ever updates or deletes evaluation rows
 * — snapshots are immutable.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

export const OFFERR_REQUESTS_TABLE = 'offerr_evaluation_requests';
export const OFFERR_EVALUATIONS_TABLE = 'offerr_evaluations';
export const OFFERR_EVENTS_TABLE = 'offerr_evaluation_events';

const UNIQUE_VIOLATION = '23505';

function generateId(deps = {}) {
  return (deps.generateId ?? (() => globalThis.crypto.randomUUID()))();
}

/**
 * Supabase-backed store. All methods return { ok, ... } envelopes and never
 * throw for expected persistence outcomes.
 */
export function createSupabaseOfferrEvaluationStore(deps = {}) {
  const db = () => deps.db ?? deps.supabase ?? getDefaultSupabaseClient();

  async function loadByRequestRow(requestRow) {
    const { data: evaluation, error } = await db()
      .from(OFFERR_EVALUATIONS_TABLE)
      .select('*')
      .eq('request_id', requestRow.id)
      .order('evaluation_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { ok: false, error: 'offerr_evaluation_read_failed', detail: error.message };
    }
    return { ok: true, found: true, request: requestRow, evaluation: evaluation ?? null };
  }

  return {
    kind: 'supabase',

    async findByIdempotencyKey(idempotencyKey) {
      const { data, error } = await db()
        .from(OFFERR_REQUESTS_TABLE)
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (error) {
        return { ok: false, error: 'offerr_request_read_failed', detail: error.message };
      }
      if (!data) return { ok: true, found: false, request: null, evaluation: null };
      return loadByRequestRow(data);
    },

    async persistEvaluation({ request, evaluation, event }) {
      const requestRow = { ...request };
      const { data: insertedRequest, error: requestError } = await db()
        .from(OFFERR_REQUESTS_TABLE)
        .insert(requestRow)
        .select('*')
        .single();

      if (requestError) {
        if (requestError.code === UNIQUE_VIOLATION) {
          const existing = await this.findByIdempotencyKey(request.idempotency_key);
          if (existing.ok && existing.found) {
            return { ok: true, duplicate: true, ...existing };
          }
          return { ok: false, error: 'offerr_idempotency_conflict_unreadable' };
        }
        return { ok: false, error: 'offerr_request_write_failed', detail: requestError.message };
      }

      const evaluationRow = { ...evaluation, request_id: insertedRequest.id };
      const { data: insertedEvaluation, error: evaluationError } = await db()
        .from(OFFERR_EVALUATIONS_TABLE)
        .insert(evaluationRow)
        .select('*')
        .single();
      if (evaluationError) {
        return {
          ok: false,
          error: 'offerr_evaluation_write_failed',
          detail: evaluationError.message,
        };
      }

      if (event) {
        // Audit event is best-effort: its failure is reported but does not
        // roll back the immutable snapshot.
        const { error: eventError } = await db()
          .from(OFFERR_EVENTS_TABLE)
          .insert({ ...event, request_id: insertedRequest.id, evaluation_id: insertedEvaluation.id });
        if (eventError) {
          return {
            ok: true,
            duplicate: false,
            request: insertedRequest,
            evaluation: insertedEvaluation,
            event_write_failed: true,
            event_error: eventError.message,
          };
        }
      }

      return { ok: true, duplicate: false, request: insertedRequest, evaluation: insertedEvaluation };
    },
  };
}

/** In-memory store with identical semantics (tests / reference). */
export function createInMemoryOfferrEvaluationStore(deps = {}) {
  const requestsByKey = new Map();
  const evaluationsByRequestId = new Map();
  const events = [];

  return {
    kind: 'memory',
    _events: events,

    async findByIdempotencyKey(idempotencyKey) {
      const request = requestsByKey.get(idempotencyKey) ?? null;
      if (!request) return { ok: true, found: false, request: null, evaluation: null };
      const versions = evaluationsByRequestId.get(request.id) ?? [];
      const evaluation = versions.length ? versions[versions.length - 1] : null;
      return { ok: true, found: true, request, evaluation };
    },

    async persistEvaluation({ request, evaluation, event }) {
      const existing = requestsByKey.get(request.idempotency_key);
      if (existing) {
        const found = await this.findByIdempotencyKey(request.idempotency_key);
        return { ok: true, duplicate: true, ...found };
      }
      const requestRow = { id: request.id ?? generateId(deps), ...request };
      requestsByKey.set(requestRow.idempotency_key, requestRow);

      const evaluationRow = {
        id: evaluation.id ?? generateId(deps),
        ...evaluation,
        request_id: requestRow.id,
      };
      const versions = evaluationsByRequestId.get(requestRow.id) ?? [];
      versions.push(evaluationRow);
      evaluationsByRequestId.set(requestRow.id, versions);

      if (event) {
        events.push({
          id: generateId(deps),
          ...event,
          request_id: requestRow.id,
          evaluation_id: evaluationRow.id,
        });
      }
      return { ok: true, duplicate: false, request: requestRow, evaluation: evaluationRow };
    },
  };
}

export default {
  OFFERR_REQUESTS_TABLE,
  OFFERR_EVALUATIONS_TABLE,
  OFFERR_EVENTS_TABLE,
  createSupabaseOfferrEvaluationStore,
  createInMemoryOfferrEvaluationStore,
};
