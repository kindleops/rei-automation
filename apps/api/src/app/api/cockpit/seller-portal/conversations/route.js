import { NextResponse } from 'next/server.js';

import { ensureDashboardReadAuth, withCors, handleOptionsResponse } from '@/app/api/cockpit/_shared.js';
import { createSupabaseSellerPortalStore } from '@/lib/domain/seller-portal/seller-portal-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Seller portal conversations for operations: unread first, with property and opportunity context. */
export function OPTIONS(request) {
  return handleOptionsResponse(request);
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request);
  if (!auth.ok) return auth.response;
  const unreadOnly = new URL(request.url).searchParams.get('unread') === '1';
  try {
    const conversations = await createSupabaseSellerPortalStore().listSellerConversations({ unreadOnly });
    conversations.sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.last_at.localeCompare(a.last_at));
    return withCors(request, NextResponse.json({ ok: true, conversations }));
  } catch (error) {
    return withCors(request, NextResponse.json({ ok: false, error: error?.code || 'unavailable' }, { status: 503 }));
  }
}
