import { NextResponse } from 'next/server.js';

import { ensureDashboardReadAuth, ensureMutationAuth, parseJsonSafe, withCors, handleOptionsResponse } from '@/app/api/cockpit/_shared.js';
import { SellerPortalError, listOperatorMessages, operatorReply, shareDocument } from '@/lib/domain/seller-portal/seller-portal-service.js';
import { createSupabaseSellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';
import { createSellerNotifier } from '@/lib/domain/seller-portal/seller-portal-notify.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operations' side of the seller portal, behind the ops dashboard gate:
 *   GET   the seller conversation for an opportunity
 *   POST  { action: "reply", body }                 reply (seller is emailed)
 *   POST  { action: "share", attachment_id, label, kind, status }
 */
export function OPTIONS(request) {
  return handleOptionsResponse(request);
}

export async function GET(request, { params }) {
  const auth = ensureDashboardReadAuth(request);
  if (!auth.ok) return auth.response;
  const result = await listOperatorMessages({ opportunityId: params.opportunity_id }, { store: createSupabaseSellerPortalStore() });
  return withCors(request, NextResponse.json(result));
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  const body = (await parseJsonSafe(request)) ?? {};
  const operator = String(body.operator || auth.auth?.user_id || 'operator');
  const store = createSupabaseSellerPortalStore();
  try {
    if (body.action === 'reply') {
      const result = await operatorReply({ opportunityId: params.opportunity_id, operator, body: body.body }, { store });
      const opportunity = await store.getOpportunity(params.opportunity_id);
      const intake = await store.getIntakeSubmission(opportunity?.source_submission_id);
      if (intake?.seller_email) await createSellerNotifier()({ kind: 'message', to: intake.seller_email, context: {} });
      return withCors(request, NextResponse.json(result));
    }
    if (body.action === 'share') {
      return withCors(request, NextResponse.json(await shareDocument({ opportunityId: params.opportunity_id, attachmentId: body.attachment_id, label: body.label, kind: body.kind, status: body.status, operator }, { store })));
    }
    return withCors(request, NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 }));
  } catch (error) {
    const status = error instanceof SellerPortalError ? error.status : 503;
    return withCors(request, NextResponse.json({ ok: false, error: error?.code || 'unavailable' }, { status }));
  }
}
