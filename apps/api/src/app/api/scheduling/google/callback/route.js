import { NextResponse } from 'next/server.js';

import { child } from '@/lib/logging/logger.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = child({ module: 'api.scheduling.google.callback' });

/**
 * Google OAuth redirect target. The single-use state (bound to the team member
 * who started the connection, with its PKCE verifier) is the only authority;
 * a replayed, expired or forged state is refused. Tokens never leave the
 * server; the browser is sent back to the ops app with a status word only.
 */
export async function GET(request) {
  const url = new URL(request.url);
  const back = (path, status) => {
    const base = String(process.env.SCHEDULING_OPS_APP_URL || '').trim() || url.origin;
    const target = new URL(path || '/calendar', base);
    target.searchParams.set('calendar_connection', status);
    return NextResponse.redirect(target, { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  };
  if (url.searchParams.get('error')) return back(null, 'declined');
  try {
    const result = await createDefaultSchedulingService().completeGoogleConnect({ state: url.searchParams.get('state'), code: url.searchParams.get('code') });
    return back(result.return_to, 'connected');
  } catch (error) {
    logger.warn('scheduling.google_connect_failed', { code: error?.code || 'unexpected' });
    return back(null, error?.code === 'oauth_state_invalid' ? 'expired' : 'failed');
  }
}
