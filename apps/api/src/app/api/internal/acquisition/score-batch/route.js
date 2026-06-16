import { NextResponse } from 'next/server';

import { scoreBatch } from '@/lib/acquisition/acquisitionDecisionEngine.js';
import { child } from '@/lib/logging/logger.js';
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = child({ module: 'api.internal.acquisition.score_batch' });

function clean(value) {
  return String(value ?? '').trim();
}

function asBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const normalized = clean(value).toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return fallback;
}

function asLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(500, Math.trunc(parsed));
}

export async function POST(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || 'unauthorized' },
      { status: auth.status || 401 },
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const result = await scoreBatch({
      limit: asLimit(body?.limit),
      market: clean(body?.market) || null,
      only_missing: asBoolean(body?.only_missing, true),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    logger.error('acquisition.score_batch.failed', {
      error: clean(error?.message) || 'unknown',
    });
    return NextResponse.json(
      { ok: false, error: 'score_batch_failed' },
      { status: 500 },
    );
  }
}
