import { NextResponse } from 'next/server.js';

import { child } from '@/lib/logging/logger.js';
import { requireSharedSecretAuth } from '@/lib/security/shared-secret.js';
import {
  SellerPortalError,
  bookCall,
  documentLink,
  getPortalState,
  listCallSlots,
  listSellerMessages,
  sendSellerMessage,
  signOut,
  startSignIn,
  verifySignIn,
} from '@/lib/domain/seller-portal/seller-portal-service.js';
import { createSupabaseSellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';
import { createSellerNotifier } from '@/lib/domain/seller-portal/seller-portal-notify.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = child({ module: 'api.internal.seller_portal' });
const MAX_BYTES = 16_384;

/**
 * Server-to-server boundary for the Prominent site's seller portal.
 *
 *   x-seller-portal-secret  SELLER_PORTAL_INTERNAL_SECRET (who may call)
 *   x-seller-session        the seller's opaque session token (whose data)
 *
 * The caller is trusted to relay; it is never trusted to authorize. Every
 * seller-scoped action re-resolves the session and its grants here.
 */
const ACTIONS = {
  'sign-in-start': (b, deps) => startSignIn({ email: b.email }, deps),
  'sign-in-verify': (b, deps) => verifySignIn({ email: b.email, code: b.code }, deps),
  'sign-out': (b, deps, token) => signOut(token, deps),
  state: (b, deps, token) => getPortalState({ token, opportunityId: b.opportunity_id }, deps),
  messages: (b, deps, token) => listSellerMessages({ token, opportunityId: b.opportunity_id }, deps),
  'messages-send': (b, deps, token) => sendSellerMessage({ token, opportunityId: b.opportunity_id, body: b.body, idempotencyKey: b.idempotency_key }, deps),
  'call-slots': (b, deps) => listCallSlots({ from: b.from }, deps),
  'call-book': (b, deps, token) => bookCall({ token: token || null, opportunityId: b.opportunity_id, reason: b.reason, startAt: b.start_at, contact: b.contact, note: b.note }, deps),
  'document-link': (b, deps, token) => documentLink({ token, opportunityId: b.opportunity_id, documentId: b.document_id }, deps),
};

export async function handleSellerPortalRequest(request, action, deps = {}) {
  const env = deps.env ?? process.env;
  const auth = requireSharedSecretAuth(request, logger, { env_name: 'SELLER_PORTAL_INTERNAL_SECRET', header_names: ['x-seller-portal-secret'] });
  if (!auth.authorized) return auth.response;
  if (String(env.SELLER_PORTAL_ENABLED ?? '').trim() !== '1') return NextResponse.json({ ok: false, error: 'seller_portal_disabled' }, { status: 503 });
  const run = ACTIONS[action];
  if (!run) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 });
  const body = (await request.json().catch(() => ({}))) ?? {};
  const token = request.headers.get('x-seller-session') || '';
  const serviceDeps = {
    store: deps.store ?? createSupabaseSellerPortalStore(),
    notify: deps.notify ?? createSellerNotifier({ env }),
    env,
    now: deps.now,
    echoCode: deps.echoCode,
  };
  try {
    return NextResponse.json(await run(body, serviceDeps, token));
  } catch (error) {
    if (error instanceof SellerPortalError) return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
    logger.error('seller_portal.failed', { action, code: error?.code || 'unexpected' });
    return NextResponse.json({ ok: false, error: 'seller_portal_unavailable' }, { status: 503 });
  }
}

export async function POST(request, { params }) {
  return handleSellerPortalRequest(request, params?.action);
}
