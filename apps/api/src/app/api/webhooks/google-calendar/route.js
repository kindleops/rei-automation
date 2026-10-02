import { NextResponse } from 'next/server.js';

import { child } from '@/lib/logging/logger.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = child({ module: 'api.webhooks.google_calendar' });

/**
 * Google Calendar push notifications. Authenticated by the per-channel secret
 * token we set when creating the watch (stored only as a hash). The body is
 * empty by design; the notification only says "something changed", and the
 * incremental sync decides what.
 */
export async function POST(request) {
  const headers = Object.fromEntries([...request.headers.entries()].filter(([k]) => k.startsWith('x-goog-')));
  try {
    const result = await createDefaultSchedulingService().handleGoogleNotification(headers);
    return new NextResponse(null, { status: result.status });
  } catch (error) {
    logger.error('scheduling.webhook_failed', { code: error?.code || 'unexpected' });
    // 500 makes Google retry with backoff; the reconcile tick also catches up.
    return new NextResponse(null, { status: 500 });
  }
}
