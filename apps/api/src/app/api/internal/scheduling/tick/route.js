/**
 * Scheduling reconciliation tick — POST /api/internal/scheduling/tick
 * (Cloudflare cron, every 5 minutes, flag CRON_SCHEDULING_ENABLED).
 *
 * Catches up everything a push notification might have missed: busy-time
 * sync for connected calendars, push channel renewal, appointments whose
 * Google copy is pending or failed, orphaned events, and expired OAuth state.
 */
import { NextResponse } from 'next/server.js';

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js';
import { child } from '@/lib/logging/logger.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';
import { createSupabaseSellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const logger = child({ module: 'api.internal.scheduling.tick' });

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger);
  if (!auth.authorized) return auth.response;
  try {
    const result = await createDefaultSchedulingService().reconcile();
    // Seller sign-in throttle rows only matter for 15 minutes.
    await createSupabaseSellerPortalStore().pruneThrottle(new Date(Date.now() - 86400e3).toISOString()).catch(() => null);
    return NextResponse.json({ ok: true, route: 'internal/scheduling/tick', ...result });
  } catch (error) {
    logger.error('scheduling.reconcile_failed', { error: error?.code || error?.message || 'unknown' });
    return NextResponse.json({ ok: false, error: 'scheduling_reconcile_failed' }, { status: 500 });
  }
}
