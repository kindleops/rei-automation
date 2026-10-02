import { NextResponse } from 'next/server.js';

import { ensureDashboardReadAuth, ensureMutationAuth, parseJsonSafe, withCors, handleOptionsResponse } from '@/app/api/cockpit/_shared.js';
import { opsActor, opsUserId } from '@/app/api/cockpit/_ops-actor.js';
import { SchedulingError } from '@/lib/domain/scheduling/scheduling-service.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';
import { isValidTimeZone } from '@/lib/domain/scheduling/scheduling-time.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduling for operations, inside the existing Calendar.
 *
 * GET  appointments?view=today|upcoming|needs_assignment|completed|cancelled|no_show
 *                   &brand=&resource_id=&type=&tz=
 * GET  appointment?id=
 * GET  team         people, their connected-calendar health, pools
 * GET  me           the signed-in team member's resource and calendar
 * POST connect      start Google OAuth for MY calendar → { url }
 * POST disconnect   disconnect MY calendar (destroys the stored credential)
 * POST me           create/update MY hours, time zone, display names
 * POST time-off     { start_at, end_at, kind, note } for me
 * POST pool-member  { brand, pool_key, resource_id, active }
 * POST outcome      { id, outcome: confirmed|completed|no_show }
 * POST assign       { id, resource_id }
 * POST reschedule   { id, start_at }
 * POST cancel       { id, reason }
 * POST resync       { id }   re-assert our appointment onto Google (e.g. after drift)
 */
export function OPTIONS(request) {
  return handleOptionsResponse(request);
}

const json = (request, body, status = 200) => withCors(request, NextResponse.json(body, { status }));
const fail = (request, error) => {
  if (error instanceof SchedulingError) return json(request, { ok: false, error: error.code, ...(error.slots ? { slots: error.slots } : {}) }, error.status);
  return json(request, { ok: false, error: 'scheduling_unavailable' }, 503);
};

export async function GET(request, { params }) {
  const auth = ensureDashboardReadAuth(request);
  if (!auth.ok) return auth.response;
  const q = new URL(request.url).searchParams;
  const service = createDefaultSchedulingService();
  try {
    switch (params.action) {
      case 'appointments':
        return json(request, await service.listForOps({ view: q.get('view') || 'upcoming', brand: q.get('brand'), resourceId: q.get('resource_id'), typeKey: q.get('type'), timezone: q.get('tz') }));
      case 'appointment':
        return json(request, await service.appointmentDetail(q.get('id')));
      case 'team': {
        const [resources, pools] = await Promise.all([service.store.listAllResources(), service.store.listPools()]);
        const team = await Promise.all(resources.map(async (r) => ({
          id: r.id, name: r.display_name, public_name: r.public_name, timezone: r.timezone, weekly_hours: r.weekly_hours, active: r.active, environment: r.environment,
          calendar: service.presentConnection(await service.store.getConnectionByResource(r.id)),
        })));
        return json(request, { ok: true, team, pools: pools.map((p) => ({ brand: p.brand_key, key: p.pool_key, name: p.name, members: (p.members || []).filter((m) => m.active).map((m) => m.resource_id) })) });
      }
      case 'me': {
        const uid = opsUserId(request);
        const resource = uid ? await service.store.findResourceByOpsUser(uid) : null;
        return json(request, { ok: true, user_id: uid, resource, calendar: resource ? service.presentConnection(await service.store.getConnectionByResource(resource.id)) : null });
      }
      default:
        return json(request, { ok: false, error: 'not_found' }, 404);
    }
  } catch (error) {
    return fail(request, error);
  }
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  const body = (await parseJsonSafe(request)) ?? {};
  const actor = opsActor(request);
  const uid = opsUserId(request);
  const service = createDefaultSchedulingService();
  const mine = async () => (uid ? service.store.findResourceByOpsUser(uid) : null);
  try {
    switch (params.action) {
      case 'connect': {
        if (!uid) return json(request, { ok: false, error: 'personal_sign_in_required' }, 403);
        return json(request, await service.startGoogleConnect({ opsUserId: uid, returnTo: body.return_to || '/calendar' }));
      }
      case 'disconnect': {
        const resource = await mine();
        if (!resource) return json(request, { ok: false, error: 'resource_not_found' }, 404);
        return json(request, await service.disconnectGoogle({ resourceId: resource.id, opsUserId: uid }));
      }
      case 'me': {
        if (!uid) return json(request, { ok: false, error: 'personal_sign_in_required' }, 403);
        if (!isValidTimeZone(body.timezone)) return json(request, { ok: false, error: 'invalid_timezone' }, 422);
        const hours = validHours(body.weekly_hours);
        if (!hours) return json(request, { ok: false, error: 'invalid_hours' }, 422);
        const existing = await mine();
        const resource = await service.store.upsertResource({
          ...(existing ? { id: existing.id } : {}), ops_user_id: uid, kind: 'person',
          display_name: String(body.display_name || existing?.display_name || '').trim().slice(0, 80) || 'Team member',
          public_name: String(body.public_name ?? existing?.public_name ?? '').trim().slice(0, 80) || null,
          email: String(body.email ?? existing?.email ?? '').trim().toLowerCase() || null,
          operator_keys: Array.isArray(body.operator_keys) ? body.operator_keys.map(String).filter(Boolean).slice(0, 10) : (existing?.operator_keys ?? []),
          timezone: body.timezone, weekly_hours: hours, active: body.active !== false,
        });
        return json(request, { ok: true, resource });
      }
      case 'time-off': {
        const resource = await mine();
        if (!resource) return json(request, { ok: false, error: 'resource_not_found' }, 404);
        const start = Date.parse(body.start_at);
        const end = Date.parse(body.end_at);
        if (!(end > start)) return json(request, { ok: false, error: 'invalid_range' }, 422);
        return json(request, { ok: true, time_off: await service.store.insertTimeOff({ resource_id: resource.id, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(), kind: ['pto', 'holiday', 'block'].includes(body.kind) ? body.kind : 'block', note: String(body.note || '').slice(0, 200) || null, created_by: actor }) });
      }
      case 'pool-member':
        await service.store.setPoolMember({ brand: String(body.brand || ''), poolKey: String(body.pool_key || ''), poolName: body.pool_name, resourceId: String(body.resource_id || ''), active: body.active !== false });
        return json(request, { ok: true });
      case 'outcome':
        return json(request, await service.markOutcome({ appointmentId: body.id, outcome: body.outcome, actor }));
      case 'assign':
        return json(request, await service.assignAppointment({ appointmentId: body.id, resourceId: body.resource_id, actor }));
      case 'reschedule':
        return json(request, await service.rescheduleAppointment({ appointmentId: body.id, startAt: body.start_at, actor }));
      case 'cancel':
        return json(request, await service.cancelAppointment({ appointmentId: body.id, reason: body.reason, actor }));
      case 'resync': {
        const appt = await service.store.getAppointment(String(body.id || ''));
        if (!appt) return json(request, { ok: false, error: 'not_found' }, 404);
        await service.syncAppointment(appt);
        return json(request, { ok: true, appointment: await service.store.getAppointment(appt.id) });
      }
      default:
        return json(request, { ok: false, error: 'not_found' }, 404);
    }
  } catch (error) {
    return fail(request, error);
  }
}

/** { "1": [["09:00","17:00"]], ... } with ISO weekday keys and HH:MM ranges. */
function validHours(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const [day, ranges] of Object.entries(v)) {
    if (!/^[1-7]$/.test(day) || !Array.isArray(ranges)) return null;
    const clean = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !r.every((t) => /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(t)) || r[0] >= r[1]) return null;
      clean.push([r[0], r[1]]);
    }
    if (clean.length) out[day] = clean;
  }
  return out;
}
