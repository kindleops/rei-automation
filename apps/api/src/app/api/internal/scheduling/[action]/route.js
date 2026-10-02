import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server.js';

import { child } from '@/lib/logging/logger.js';
import { SchedulingError } from '@/lib/domain/scheduling/scheduling-service.js';
import { createDefaultSchedulingService, schedulingClients } from '@/lib/domain/scheduling/scheduling-runtime.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = child({ module: 'api.internal.scheduling' });

/**
 * The scheduling core's API for client applications (Prominent today;
 * Reivesti, Everline, SignPro later).
 *
 *   x-scheduling-client   the brand key
 *   x-scheduling-secret   that brand's secret (SCHEDULING_CLIENT_SECRETS)
 *
 * A client can only act within its own brand. Availability returns times
 * only. Booking recomputes availability server-side; a stale slot gets 409
 * slot_unavailable with refreshed slots. Appointment ids from one brand are
 * invisible to another.
 *
 *   POST availability  { event_type, related_refs?, from?, to?, timezone? }
 *   POST book          { event_type, start_at, related_refs?, customer, timezone?, source?, reason_key?, note?, idempotency_key? }
 *   POST reschedule    { appointment_id, start_at, version? }
 *   POST cancel        { appointment_id, reason? }
 */
function authenticate(request, env) {
  const brand = String(request.headers.get('x-scheduling-client') || '').trim();
  const secret = Buffer.from(String(request.headers.get('x-scheduling-secret') || ''));
  const expected = Buffer.from(schedulingClients(env)[brand] || '');
  if (!brand || !expected.length || expected.length !== secret.length || !timingSafeEqual(expected, secret)) return null;
  return brand;
}

export async function handleSchedulingClientRequest(request, action, deps = {}) {
  const env = deps.env ?? process.env;
  const brand = authenticate(request, env);
  if (!brand) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) ?? {};
  const service = deps.service ?? createDefaultSchedulingService({ env });
  const own = async (appt) => appt.brand_key === brand;
  try {
    switch (action) {
      case 'availability':
        return NextResponse.json(await service.getAvailability({ brand, typeKey: body.event_type, refs: body.related_refs || [], from: body.from, to: body.to, timezone: body.timezone }));
      case 'book':
        return NextResponse.json(await service.bookAppointment({ brand, typeKey: body.event_type, startAt: body.start_at, refs: body.related_refs || [], customer: body.customer || {}, customerTimezone: body.timezone, source: body.source || brand, reasonKey: body.reason_key, note: body.note, idempotencyKey: body.idempotency_key, actor: `client:${brand}` }));
      case 'reschedule':
        return NextResponse.json(await service.rescheduleAppointment({ appointmentId: body.appointment_id, startAt: body.start_at, expectedVersion: body.version, actor: `client:${brand}`, authorize: own }));
      case 'cancel':
        return NextResponse.json(await service.cancelAppointment({ appointmentId: body.appointment_id, reason: body.reason, actor: `client:${brand}`, authorize: own }));
      default:
        return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof SchedulingError) return NextResponse.json({ ok: false, error: error.code, ...(error.slots ? { slots: error.slots } : {}) }, { status: error.status });
    logger.error('scheduling.client_failed', { action, brand, code: error?.code || 'unexpected' });
    return NextResponse.json({ ok: false, error: 'scheduling_unavailable' }, { status: 503 });
  }
}

export async function POST(request, { params }) {
  return handleSchedulingClientRequest(request, params?.action);
}
