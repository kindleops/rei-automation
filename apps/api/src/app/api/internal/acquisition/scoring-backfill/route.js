/**
 * Canonical scoring backfill — POST /api/internal/acquisition/scoring-backfill
 *
 *   { "action": "tick" }                      cron (Worker job SCORING_BACKFILL)
 *   { "action": "start", "config": {...}, "resume": true }   operator (internal secret)
 *   { "action": "pause" }                     operator
 *   { "action": "status" }                    operator (read-only)
 *
 * Gates, in order: auth -> ACQUISITION_SCORING_BACKFILL_ENABLED='true'
 * (container ceiling; status is always readable) -> run lock -> state.status
 * === 'running' -> sending window -> DB load probe -> backoff. Writes only
 * property_acquisition_scores (compact, version-stamped, non-monetary rows)
 * and its own system_control state key. Sends nothing.
 * See lib/acquisition/scoringBackfill.js.
 */
import crypto from 'node:crypto';
import { NextResponse } from 'next/server.js';

import {
  BACKFILL_STATE_KEY,
  CAMPAIGN_SCOPE_STATE_KEY,
  SCOPE_KINDS,
  SCORING_VERSION,
  applyPause,
  applyStart,
  parseState,
  runBackfillTick,
} from '@/lib/acquisition/scoringBackfill.js';
import { createScoringBackfillStore } from '@/lib/acquisition/scoringBackfillStore.js';
import { withRunLock } from '@/lib/domain/runs/run-locks.js';
import { child } from '@/lib/logging/logger.js';
import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js';
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const ROUTE_NAME = 'internal/acquisition/scoring-backfill';
const logger = child({ module: 'api.internal.acquisition.scoring_backfill' });

function enabled() {
  return String(process.env.ACQUISITION_SCORING_BACKFILL_ENABLED || '').trim().toLowerCase() === 'true';
}

/** { scope: 'campaign' } or { scope: { kind: 'campaign', campaign_ids: [...] } } selects the offer-ready layer. */
export function isCampaignScope(body = {}) {
  const scope = body?.scope;
  return scope === SCOPE_KINDS.CAMPAIGN || scope?.kind === SCOPE_KINDS.CAMPAIGN;
}

export async function handleScoringBackfill(action, body = {}, deps = {}) {
  const campaign = isCampaignScope(body);
  const stateKey = campaign ? CAMPAIGN_SCOPE_STATE_KEY : BACKFILL_STATE_KEY;
  const store = deps.store ?? createScoringBackfillStore({ stateKey });
  const now = deps.now ?? new Date();

  if (action === 'status') {
    const state = parseState(await store.readState(), now);
    return { status: 200, body: { ok: true, key: stateKey, scoring_version: SCORING_VERSION, enabled: enabled(), state } };
  }
  if (!enabled() && !deps.forceEnabled) {
    return { status: 200, body: { ok: true, skipped: true, reason: 'ACQUISITION_SCORING_BACKFILL_ENABLED_not_true' } };
  }
  if (action === 'start') {
    if (store.hasVersionColumns && !(await store.hasVersionColumns())) {
      return { status: 409, body: { ok: false, error: 'migration_not_applied', detail: 'property_acquisition_scores.scoring_version/scored_at missing' } };
    }
    const next = applyStart(parseState(await store.readState(), now), {
      now,
      runId: crypto.randomUUID(),
      config: {
        ...(body?.config && typeof body.config === 'object' ? body.config : {}),
        ...(campaign
          ? { scope: { kind: SCOPE_KINDS.CAMPAIGN, campaign_ids: Array.isArray(body?.scope?.campaign_ids) ? body.scope.campaign_ids : Array.isArray(body?.campaign_ids) ? body.campaign_ids : [], include_blocked: body?.scope?.include_blocked === true } }
          : {}),
      },
      resume: body?.resume !== false,
    });
    await store.writeState(next);
    return { status: 200, body: { ok: true, state: next } };
  }
  if (action === 'pause') {
    const next = applyPause(parseState(await store.readState(), now), { now, reason: body?.reason || 'operator_pause' });
    await store.writeState(next);
    return { status: 200, body: { ok: true, state: next } };
  }
  if (action === 'tick') {
    const lock = deps.withRunLock ?? withRunLock;
    const result = await lock({
      scope: campaign ? 'acquisition_scoring_backfill_campaign' : 'acquisition_scoring_backfill',
      lease_ms: 6 * 60_000,
      owner: ROUTE_NAME,
      onLocked: () => ({ ok: true, skipped: true, reason: 'run_lock_held' }),
      fn: () => runBackfillTick({ store }),
    });
    return { status: 200, body: { ok: true, route: ROUTE_NAME, ...result } };
  }
  return { status: 400, body: { ok: false, error: 'unknown_action' } };
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || 'tick').trim();
  if (action === 'tick') {
    const auth = requireScheduledMutationAuth(request, logger);
    if (!auth.authorized) return auth.response;
  } else {
    const auth = requireInternalSecret(request);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error || 'unauthorized' }, { status: auth.status || 401 });
  }
  try {
    const out = await handleScoringBackfill(action, body);
    if (action === 'tick' && !out.body.skipped) {
      logger.info('scoring_backfill.tick', {
        scored: out.body.scored, skipped_existing: out.body.skipped_existing, failed: out.body.failed,
        transient_failed: out.body.transient_failed, stopped_because: out.body.stopped_because, cursor_after: out.body.cursor_after,
      });
    }
    // per_property_ms / row_bytes arrays are diagnostics; trim from the wire.
    if (out.body.per_property_ms) out.body.per_property_ms = out.body.per_property_ms.length;
    if (out.body.row_bytes) out.body.row_bytes = out.body.row_bytes.length;
    return NextResponse.json(out.body, { status: out.status });
  } catch (error) {
    logger.error('scoring_backfill.failed', { action, error: error?.message || 'unknown' });
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'scoring_backfill_failed', message: error?.message || 'failed' }, { status: 500 });
  }
}
