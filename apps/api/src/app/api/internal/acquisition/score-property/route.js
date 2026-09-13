import { NextResponse } from 'next/server.js';

import {
  DECISION_STATUS,
  ensurePropertyAcquisitionDecision,
} from '@/lib/acquisition/decisionAuthority.js';
import { child } from '@/lib/logging/logger.js';
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = child({ module: 'api.internal.acquisition.score_property' });

function clean(value) {
  return String(value ?? '').trim();
}

export async function handleScorePropertyRequest(request, deps = {}) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || 'unauthorized' },
      { status: auth.status || 401 },
    );
  }

  const routeLogger = deps.logger ?? logger;
  let propertyId = null;

  try {
    const body = await request.json().catch(() => ({}));
    propertyId = clean(body?.property_id);
    // One authority for every entry point. `force` defaults true because a
    // caller POSTing to this route is asking for a run; passing force:false
    // turns it into "give me a current decision, run only if you must".
    const ensured = await ensurePropertyAcquisitionDecision(propertyId, {
      force: body?.force !== false,
      sellerFacts: body?.seller_facts || {},
      reason: clean(body?.reason) || 'internal_score_property_route',
      deps,
    });
    // An engine that threw is a server fault, not a decision outcome: it keeps
    // its 500 and its structured log, with the original error code intact.
    if (ensured.error_kind === 'engine_threw') throw ensured.error_cause;
    const ok = ensured.status !== DECISION_STATUS.ENGINE_FAILED;
    const result = {
      ok,
      score: ensured.decision,
      snapshot_id: ensured.snapshot_id,
      immutable_snapshot_id: ensured.snapshot_id,
      evidence: ensured.decision?.evidence ?? null,
      decision_status: ensured.status,
      freshness: ensured.freshness,
      ran: ensured.ran,
      ...(ok ? {} : { error: ensured.error }),
    };
    return NextResponse.json(result, { status: ok ? 200 : 400 });
  } catch (error) {
    const errorMessage = clean(error?.message) || 'unknown';
    routeLogger.error('acquisition.score_property.failed', {
      failure_code: 'score_property_failed',
      property_id: propertyId || null,
      error_code: clean(error?.code) || null,
      error_message: errorMessage,
      error: errorMessage,
    });
    return NextResponse.json(
      { ok: false, error: 'score_property_failed' },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  return handleScorePropertyRequest(request);
}
