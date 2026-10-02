import { NextResponse } from 'next/server.js';

import { child } from '@/lib/logging/logger.js';
import { requireSharedSecretAuth } from '@/lib/security/shared-secret.js';
import {
  EXTERNAL_INTAKE_MAX_BYTES,
  EXTERNAL_SELLER_INTAKE_SCHEMA,
  PROMINENT_SOURCE_APPLICATION,
  PROMINENT_SOURCE_CHANNEL,
  ingestExternalSellerIntake,
  normalizeExternalSellerIntake,
} from '@/lib/domain/acquisition/external-seller-intake-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'internal/acquisition/intake';
const logger = child({ module: 'api.internal.acquisition.intake' });

function correlationId(deps = {}) {
  return (deps.generateCorrelationId ?? (() => globalThis.crypto.randomUUID()))();
}

function configuredSecret() {
  return String(process.env.PROMINENT_INTAKE_SHARED_SECRET || '').trim();
}

function safeErrorResponse(status, error, request_id) {
  return NextResponse.json({ ok: false, error, request_id }, { status });
}

/**
 * Server-to-server Prominent seller intake. This route is intentionally under
 * an internal path and fails closed when its dedicated shared secret is absent.
 */
export async function handleExternalSellerIntakeRequest(request, deps = {}) {
  const routeLogger = deps.logger ?? logger;
  const requestId = correlationId(deps);

  if (!configuredSecret() && !deps.expectedSecret) {
    routeLogger.error('external_seller_intake.misconfigured', { request_id: requestId });
    return safeErrorResponse(500, 'intake_auth_not_configured', requestId);
  }

  const auth = requireSharedSecretAuth(request, routeLogger, {
    env_name: 'PROMINENT_INTAKE_SHARED_SECRET',
    header_names: ['x-prominent-intake-secret'],
    expected_token: deps.expectedSecret ?? null,
  });
  if (!auth.authorized) return auth.response;

  const contentLength = Number(request.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > EXTERNAL_INTAKE_MAX_BYTES) {
    routeLogger.warn('external_seller_intake.rejected', {
      request_id: requestId,
      failure_code: 'payload_too_large',
      content_length: contentLength,
    });
    return safeErrorResponse(413, 'payload_too_large', requestId);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    routeLogger.warn('external_seller_intake.rejected', {
      request_id: requestId,
      failure_code: 'malformed_json_body',
    });
    return safeErrorResponse(400, 'malformed_json_body', requestId);
  }

  // Content-Length is optional and can be absent on streamed requests. Enforce
  // the limit again after parsing so the boundary cannot be bypassed by a
  // missing or inaccurate header.
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > EXTERNAL_INTAKE_MAX_BYTES) {
    routeLogger.warn('external_seller_intake.rejected', {
      request_id: requestId,
      failure_code: 'payload_too_large',
    });
    return safeErrorResponse(413, 'payload_too_large', requestId);
  }

  if (body.source_application !== PROMINENT_SOURCE_APPLICATION || body.source_channel !== PROMINENT_SOURCE_CHANNEL) {
    routeLogger.warn('external_seller_intake.rejected', {
      request_id: requestId,
      failure_code: 'invalid_source_identity',
    });
    return safeErrorResponse(422, 'invalid_source_identity', requestId);
  }

  if (body.schema_version !== EXTERNAL_SELLER_INTAKE_SCHEMA) {
    return safeErrorResponse(422, 'unsupported_schema_version', requestId);
  }

  const normalized = normalizeExternalSellerIntake(body);
  if (!normalized.ok) {
    routeLogger.warn('external_seller_intake.validation_failed', {
      request_id: requestId,
      failure_code: 'invalid_external_seller_intake',
      validation_count: normalized.errors.length,
    });
    return NextResponse.json({
      ok: false,
      error: 'invalid_external_seller_intake',
      validation_errors: normalized.errors,
      request_id: requestId,
    }, { status: 422 });
  }

  try {
    const ingest = deps.ingestExternalSellerIntake ?? ingestExternalSellerIntake;
    const result = await ingest(normalized.intake, deps);
    if (result?.ok) {
      return NextResponse.json({
        ok: true,
        submission_id: result.submission_id,
        lead_id: result.lead_id,
        matched_existing: Boolean(result.matched_existing),
        idempotent_replay: Boolean(result.idempotent_replay),
        thread_created: Boolean(result.thread_created),
        communication_queued: false,
        message_sent: false,
      }, { status: 200 });
    }

    if (result?.failure_code === 'idempotency_key_reused_with_different_payload') {
      return NextResponse.json({
        ok: false,
        error: 'idempotency_key_reused_with_different_payload',
        request_id: requestId,
      }, { status: 409 });
    }
    if (result?.failure_code === 'invalid_external_seller_intake') {
      return NextResponse.json({
        ok: false,
        error: 'invalid_external_seller_intake',
        validation_errors: result.validation_errors ?? [],
        request_id: requestId,
      }, { status: 422 });
    }
    routeLogger.error('external_seller_intake.persistence_failed', {
      request_id: requestId,
      failure_code: result?.failure_code || 'external_intake_persistence_failed',
    });
    return safeErrorResponse(503, 'intake_unavailable', requestId);
  } catch (error) {
    routeLogger.error('external_seller_intake.failed', {
      request_id: requestId,
      error_code: error?.code || null,
    });
    return safeErrorResponse(503, 'intake_unavailable', requestId);
  }
}

export async function POST(request) {
  return handleExternalSellerIntakeRequest(request);
}
