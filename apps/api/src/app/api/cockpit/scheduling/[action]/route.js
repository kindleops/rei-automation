import { NextResponse } from 'next/server.js';

import { ensureDashboardReadAuth, ensureMutationAuth, parseJsonSafe, withCors, handleOptionsResponse } from '@/app/api/cockpit/_shared.js';
import { opsActor, opsUserId } from '@/app/api/cockpit/_ops-actor.js';
import { SchedulingError } from '@/lib/domain/scheduling/scheduling-service.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';
import { isValidTimeZone } from '@/lib/domain/scheduling/scheduling-time.js';
import { ROUTING_STRATEGIES } from '@/lib/domain/scheduling/scheduling-routing.js';
import { child } from '@/lib/logging/logger.js';

const logger = child({ module: 'api.cockpit.scheduling' });

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
 * GET  permissions  what the signed-in operator may administer
 * GET  event-types  every brand's appointment types (routing included)
 *
 * Self-service (any operator who is a bookable person):
 * POST connect      start Google OAuth for MY calendar → { url }
 * POST disconnect   disconnect MY calendar (destroys the stored credential)
 * POST me           MY hours and time zone
 * POST time-off     { start_at, end_at, kind, note } for me
 *
 * scheduling.admin only (ops_operator_permissions — least privilege):
 * POST resource     create/update a bookable person { ops_user_id?, id?, display_name,
 *                   public_name, email, timezone, weekly_hours, operator_keys, active }
 * POST pool-member  { brand, pool_key, resource_id, active }
 * POST event-type   { id, duration_minutes?, slot_interval_minutes?, buffer_*?,
 *                   min_notice_minutes?, horizon_days?, routing?, reminder_offsets_minutes?, active? }
 *
 * Any operator:
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
      case 'permissions': {
        const uid = opsUserId(request);
        return json(request, { ok: true, user_id: uid, scheduling_admin: uid ? await service.store.hasPermission(uid, 'scheduling.admin') : false });
      }
      case 'event-types':
        return json(request, { ok: true, event_types: (await service.store.listAllEventTypes()).map((t) => ({ id: t.id, brand: t.brand_key, key: t.type_key, name: t.name, duration_minutes: t.duration_minutes, slot_interval_minutes: t.slot_interval_minutes, buffer_before_minutes: t.buffer_before_minutes, buffer_after_minutes: t.buffer_after_minutes, min_notice_minutes: t.min_notice_minutes, horizon_days: t.horizon_days, routing: t.routing, reminder_offsets_minutes: t.reminder_offsets_minutes, active: t.active, environment: t.environment })) });
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
  return handleSchedulingCockpitPost(request, params.action);
}

/** POST body, after dashboard authentication. Exported for tests (service injectable). */
export async function handleSchedulingCockpitPost(request, action, deps = {}) {
  const body = (await parseJsonSafe(request)) ?? {};
  const actor = opsActor(request);
  const uid = opsUserId(request);
  const service = deps.service ?? createDefaultSchedulingService();
  const params = { action };
  const mine = async () => (uid ? service.store.findResourceByOpsUser(uid) : null);
  const admin = async () => Boolean(uid) && (await service.store.hasPermission(uid, 'scheduling.admin'));
  const denied = () => json(request, { ok: false, error: 'scheduling_admin_required' }, 403);
  const audit = (what, detail) => logger.info('scheduling.config_changed', { what, by: actor, ...detail });
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
        // Self-service is limited to one's own hours and time zone; becoming
        // bookable, display names and routing keys are an admin decision.
        const existing = await mine();
        if (!existing) return json(request, { ok: false, error: 'not_bookable' }, 403);
        if (!isValidTimeZone(body.timezone)) return json(request, { ok: false, error: 'invalid_timezone' }, 422);
        const hours = validHours(body.weekly_hours);
        if (!hours) return json(request, { ok: false, error: 'invalid_hours' }, 422);
        const resource = await service.store.upsertResource({ id: existing.id, timezone: body.timezone, weekly_hours: hours });
        return json(request, { ok: true, resource });
      }
      case 'resource': {
        if (!(await admin())) return denied();
        if (!isValidTimeZone(body.timezone)) return json(request, { ok: false, error: 'invalid_timezone' }, 422);
        const hours = validHours(body.weekly_hours ?? {});
        if (!hours) return json(request, { ok: false, error: 'invalid_hours' }, 422);
        const target = body.id ? await service.store.getResource(String(body.id)) : body.ops_user_id ? await service.store.findResourceByOpsUser(String(body.ops_user_id)) : null;
        const resource = await service.store.upsertResource({
          ...(target ? { id: target.id } : {}),
          ...(body.ops_user_id ? { ops_user_id: String(body.ops_user_id) } : {}),
          kind: 'person',
          display_name: String(body.display_name || target?.display_name || '').trim().slice(0, 80) || 'Team member',
          public_name: String(body.public_name ?? target?.public_name ?? '').trim().slice(0, 80) || null,
          email: String(body.email ?? target?.email ?? '').trim().toLowerCase() || null,
          operator_keys: Array.isArray(body.operator_keys) ? body.operator_keys.map(String).filter(Boolean).slice(0, 10) : (target?.operator_keys ?? []),
          timezone: body.timezone, weekly_hours: hours, active: body.active !== false,
        });
        audit('resource', { resource_id: resource.id });
        return json(request, { ok: true, resource });
      }
      case 'event-type': {
        if (!(await admin())) return denied();
        const patch = eventTypePatch(body);
        if (!patch) return json(request, { ok: false, error: 'invalid_event_type' }, 422);
        const updated = await service.store.updateEventType(String(body.id || ''), patch);
        if (!updated) return json(request, { ok: false, error: 'not_found' }, 404);
        audit('event_type', { event_type_id: updated.id });
        return json(request, { ok: true, event_type: updated });
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
        if (!(await admin())) return denied();
        audit('pool_member', { brand: body.brand, pool_key: body.pool_key, resource_id: body.resource_id, active: body.active !== false });
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

const INT = (v, lo, hi) => (v === undefined ? undefined : Number.isInteger(v) && v >= lo && v <= hi ? v : NaN);

/** Only known fields, only valid values; anything else rejects the whole change. */
function eventTypePatch(b) {
  const patch = {
    duration_minutes: INT(b.duration_minutes, 5, 480),
    slot_interval_minutes: INT(b.slot_interval_minutes, 5, 240),
    buffer_before_minutes: INT(b.buffer_before_minutes, 0, 240),
    buffer_after_minutes: INT(b.buffer_after_minutes, 0, 240),
    min_notice_minutes: INT(b.min_notice_minutes, 0, 20160),
    horizon_days: INT(b.horizon_days, 1, 120),
  };
  if (Object.values(patch).some((v) => Number.isNaN(v))) return null;
  if (b.reminder_offsets_minutes !== undefined) {
    if (!Array.isArray(b.reminder_offsets_minutes) || b.reminder_offsets_minutes.length > 4 || !b.reminder_offsets_minutes.every((n) => Number.isInteger(n) && n >= 5 && n <= 10080)) return null;
    patch.reminder_offsets_minutes = b.reminder_offsets_minutes;
  }
  if (b.routing !== undefined) {
    const r = b.routing || {};
    const keys = ['strategy', 'owner', 'owner_unavailable', 'pool', 'fallback_pool'];
    if (Object.keys(r).some((k) => !keys.includes(k)) || !ROUTING_STRATEGIES.includes(r.strategy)) return null;
    if (r.owner_unavailable && !['next_available_owner', 'route_to_pool'].includes(r.owner_unavailable)) return null;
    patch.routing = Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === 'string' && v));
  }
  if (b.active !== undefined) patch.active = b.active === true;
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return Object.keys(clean).length ? clean : null;
}
