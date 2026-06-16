import { NextResponse } from 'next/server.js';

import { scoreProperty } from '@/lib/acquisition/acquisitionDecisionEngine.js';
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

  const scorer = deps.scoreProperty ?? scoreProperty;
  const routeLogger = deps.logger ?? logger;
  let propertyId = null;

  try {
    const body = await request.json().catch(() => ({}));
    propertyId = clean(body?.property_id);
    const result = await scorer(propertyId);
    return NextResponse.json(result, {
      status: result.status || (result.ok ? 200 : 400),
    });
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
