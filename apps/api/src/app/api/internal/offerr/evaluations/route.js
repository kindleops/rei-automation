import { NextResponse } from 'next/server.js';

import { child } from '@/lib/logging/logger.js';
import { captureRouteException } from '@/lib/monitoring/sentry.js';
import { requireSharedSecretAuth } from '@/lib/security/shared-secret.js';
import { buildDisabledResponse, getSystemFlag } from '@/lib/system-control.js';
import {
  OFFERR_FLAG_KEY,
  OFFERR_INTAKE_LIMITS,
} from '@/lib/domain/offerr/offerr-contracts.js';
import { evaluateOfferrProperty } from '@/lib/domain/offerr/offerr-evaluation-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ROUTE = 'internal/offerr/evaluations';

const logger = child({ module: 'api.internal.offerr.evaluations' });

const FAILURE_STATUS = {
  invalid_offerr_intake: 400,
  idempotency_key_reused_with_different_payload: 409,
  evaluation_timeout: 504,
  offerr_persistence_unavailable: 503,
  offerr_persistence_failed: 503,
  offerr_idempotency_conflict_retry: 503,
  // A request row without its evaluation snapshot is a transiently inconsistent
  // server state, not an unhandled fault: under concurrent same-key traffic the
  // pre-flight replay lookup routinely observes the winner's request row before
  // its snapshot commits. Retry is the correct client action, so this is 503
  // rather than 500 (503 also keeps a routine race out of exception alerting).
  // Verified against a real Postgres race — see docs/offerr/
  // offerr-staging-verification-report.md.
  offerr_incomplete_snapshot: 503,
};

function clean(value) {
  return String(value ?? '').trim();
}

function generateCorrelationId(deps = {}) {
  return (deps.generateCorrelationId ?? (() => globalThis.crypto.randomUUID()))();
}

/**
 * Internal-only Offerr evaluation intake. Feature-flag gated (default OFF via
 * system_control key offerr_evaluation_enabled), internal-secret protected,
 * idempotent on body.idempotency_key. Returns the sanitized seller-safe
 * evaluation plus internal identifiers — never the internal underwriting.
 */
export async function handleOfferrEvaluationsRequest(request, deps = {}) {
  const routeLogger = deps.logger ?? logger;
  // Correlation id exists before validation so every log line and error
  // envelope for this HTTP request can be tied together, even when the
  // evaluation never starts.
  const correlationId = generateCorrelationId(deps);

  const auth = requireSharedSecretAuth(request, routeLogger, {
    env_name: 'INTERNAL_API_SECRET',
    header_names: ['x-internal-api-secret'],
  });
  if (!auth.authorized) return auth.response;

  const flagReader = deps.getSystemFlag ?? getSystemFlag;
  const enabled = await flagReader(OFFERR_FLAG_KEY, { failClosedOnError: true });
  if (!enabled) {
    return NextResponse.json(buildDisabledResponse(OFFERR_FLAG_KEY, ROUTE), { status: 423 });
  }

  const contentLength = Number(request.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > OFFERR_INTAKE_LIMITS.max_request_bytes) {
    routeLogger.warn('offerr_evaluations.rejected', {
      correlation_id: correlationId,
      failure_code: 'payload_too_large',
      content_length: contentLength,
    });
    return NextResponse.json(
      { ok: false, route: ROUTE, error: 'payload_too_large', correlation_id: correlationId },
      { status: 413 },
    );
  }

  let requestId = null;
  try {
    // Malformed JSON is a normal client error, not an exception path.
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      routeLogger.warn('offerr_evaluations.rejected', {
        correlation_id: correlationId,
        failure_code: 'malformed_json_body',
      });
      return NextResponse.json(
        {
          ok: false,
          route: ROUTE,
          error: 'invalid_offerr_intake',
          validation_errors: ['malformed_json_body'],
          correlation_id: correlationId,
        },
        { status: 400 },
      );
    }

    const evaluate = deps.evaluateOfferrProperty ?? evaluateOfferrProperty;
    const result = await evaluate(
      {
        address: body?.address ?? body?.submitted_address,
        idempotency_key: body?.idempotency_key ?? body?.idempotencyKey,
        seller_facts: body?.seller_facts ?? body?.sellerFacts,
        source: body?.source,
      },
      deps,
    );
    requestId = result?.request_id ?? null;

    if (result.ok) {
      return NextResponse.json(
        {
          ok: true,
          route: ROUTE,
          request_id: result.request_id,
          evaluation_id: result.evaluation_id,
          idempotent_replay: Boolean(result.idempotent_replay),
          evaluation: result.seller_projection,
        },
        { status: 200 },
      );
    }

    if (result.failure_code === 'invalid_offerr_intake') {
      return NextResponse.json(
        {
          ok: false,
          route: ROUTE,
          error: 'invalid_offerr_intake',
          validation_errors: result.validation_errors ?? [],
          correlation_id: correlationId,
        },
        { status: 400 },
      );
    }

    routeLogger.warn('offerr_evaluations.failed', {
      correlation_id: correlationId,
      request_id: requestId,
      failure_code: clean(result.failure_code) || 'unknown',
      timeout_stage: result.timeout_stage ?? null,
    });
    return NextResponse.json(
      {
        ok: false,
        route: ROUTE,
        error: 'offerr_evaluation_failed',
        failure_code: clean(result.failure_code) || 'unknown',
        correlation_id: correlationId,
      },
      { status: FAILURE_STATUS[result.failure_code] ?? 500 },
    );
  } catch (error) {
    const errorMessage = clean(error?.message) || 'unknown';
    routeLogger.error('offerr_evaluations.failed', {
      failure_code: 'offerr_evaluations_route_failed',
      correlation_id: correlationId,
      request_id: requestId,
      error_message: errorMessage,
    });
    captureRouteException(error, { route: ROUTE, subsystem: 'offerr' });
    return NextResponse.json(
      {
        ok: false,
        route: ROUTE,
        error: 'offerr_evaluations_route_failed',
        correlation_id: correlationId,
      },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  return handleOfferrEvaluationsRequest(request);
}
