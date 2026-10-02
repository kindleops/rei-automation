import { NextResponse } from 'next/server.js';

import { ensureDashboardReadAuth, ensureMutationAuth, parseJsonSafe, withCors, handleOptionsResponse } from '@/app/api/cockpit/_shared.js';
import { opsActor } from '@/app/api/cockpit/_ops-actor.js';
import {
  SellerPortalError,
  listOperatorMessages,
  listShareableDocuments,
  operatorReply,
  revokeDocument,
  shareDocument,
} from '@/lib/domain/seller-portal/seller-portal-service.js';
import { createSupabaseSellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';
import { CALL_REASONS } from '@/lib/domain/seller-portal/seller-portal-contracts.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operations' side of one seller's portal, behind the ops dashboard gate.
 *
 *   GET   context, conversation, documents (shared + shareable), calls
 *   POST  { action: "reply", body }                       seller is emailed (deduplicated)
 *   POST  { action: "mark_read" }
 *   POST  { action: "share", attachment_id, label, kind, status }
 *   POST  { action: "revoke", share_id }
 *
 * The acting operator is the authenticated ops user (x-ops-user-id), never a
 * value from the request body.
 */
export function OPTIONS(request) {
  return handleOptionsResponse(request);
}

export async function GET(request, { params }) {
  const auth = ensureDashboardReadAuth(request);
  if (!auth.ok) return auth.response;
  const store = createSupabaseSellerPortalStore();
  try {
    const opportunity = await store.getOpportunity(params.opportunity_id);
    if (!opportunity) return withCors(request, NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 }));
    const [messages, documents, appointments, identities] = await Promise.all([
      listOperatorMessages({ opportunityId: opportunity.id }, { store }),
      listShareableDocuments({ opportunityId: opportunity.id }, { store }),
      createDefaultSchedulingService().store.listAppointmentsByRelated(`opportunity:${opportunity.id}`),
      store.listIdentitiesForOpportunity(opportunity.id),
    ]);
    return withCors(request, NextResponse.json({
      ok: true,
      opportunity: { id: opportunity.id, address: opportunity.property_address_full, seller: opportunity.seller_display_name, stage: opportunity.acquisition_stage, status: opportunity.opportunity_status, assigned_operator: opportunity.assigned_operator },
      portal_accounts: identities.map((i) => ({ email: i.email, name: i.display_name })),
      messages: messages.messages,
      documents: { shareable: documents.attachments, shares: documents.shares },
      calls: appointments.map((a) => ({ id: a.id, status: a.status, start_at: a.start_at, end_at: a.end_at, reason: CALL_REASONS[a.reason_key] || a.reason_key, resource_id: a.resource_id, sync_status: a.sync_status })),
    }));
  } catch (error) {
    return withCors(request, NextResponse.json({ ok: false, error: error?.code || 'unavailable' }, { status: 503 }));
  }
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  const body = (await parseJsonSafe(request)) ?? {};
  const operator = opsActor(request);
  const store = createSupabaseSellerPortalStore();
  try {
    if (body.action === 'reply') {
      return withCors(request, NextResponse.json(await operatorReply({ opportunityId: params.opportunity_id, operator, body: body.body }, { store })));
    }
    if (body.action === 'mark_read') {
      await store.markRead(params.opportunity_id, 'operator_read_at', new Date().toISOString());
      return withCors(request, NextResponse.json({ ok: true }));
    }
    if (body.action === 'share') {
      return withCors(request, NextResponse.json(await shareDocument({ opportunityId: params.opportunity_id, attachmentId: body.attachment_id, label: body.label, kind: body.kind, status: body.status, operator }, { store })));
    }
    if (body.action === 'revoke') {
      return withCors(request, NextResponse.json(await revokeDocument({ opportunityId: params.opportunity_id, shareId: body.share_id, operator }, { store })));
    }
    return withCors(request, NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 }));
  } catch (error) {
    const status = error instanceof SellerPortalError ? error.status : 503;
    return withCors(request, NextResponse.json({ ok: false, error: error?.code || 'unavailable' }, { status }));
  }
}
