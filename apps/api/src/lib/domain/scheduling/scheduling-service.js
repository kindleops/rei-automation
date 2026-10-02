/**
 * Scheduling core — service.
 *
 * Brand-agnostic. A brand is context on an appointment and an adapter that
 * supplies domain knowledge (who owns a record, how to describe it, how to
 * tell the customer). The core owns the mechanics: availability, routing,
 * atomic reservation, calendar sync, reminders, reconciliation.
 *
 * BOOKING TRANSACTION
 *   1. recompute availability for the requested start, server-side, from fresh
 *      data (a previously rendered slot is never trusted);
 *   2. rank the free eligible resources by routing policy;
 *   3. for each in turn: confirm against the live connected calendar, then
 *      INSERT — the database's exclusion constraint is the atomic reservation
 *      across every brand; a concurrent loss (23P01) falls through to the next
 *      eligible person, and when none remain the caller gets slot_unavailable
 *      with refreshed availability;
 *   4. after commit: mirror to Google, persist its ids, notify the brand
 *      adapter (domain exposure + customer confirmation), schedule reminders,
 *      append the ledger event.
 * Steps in 4 never undo the booking: a Google failure leaves sync_status
 * 'failed' for the reconciler, a notification failure is logged.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { child } from '@/lib/logging/logger.js';

import { computeAvailability, heldBlock } from './scheduling-availability.js';
import { planRouting, rankForSlot } from './scheduling-routing.js';
import { TIME, isValidTimeZone, zoneAbbreviation } from './scheduling-time.js';
import { createSupabaseSchedulingStore, SchedulingStoreError } from './scheduling-store.js';
import { createGoogleCalendarClient } from './google-calendar-client.js';
import { decryptSecret, encryptSecret, tokenCryptoConfigured } from './scheduling-token-crypto.js';
import { scheduleReminders } from './scheduling-reminders.js';

const { MIN, DAY } = TIME;
const LIVE = ['scheduled', 'confirmed'];
const clean = (v) => String(v ?? '').trim();
const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const logger = child({ module: 'domain.scheduling' });

export class SchedulingError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Brand adapters
// ---------------------------------------------------------------------------
const ADAPTERS = new Map();
/** A brand plugs into the core by registering an adapter; see docs/integrations/scheduling-core.md. */
export function registerBrandAdapter(adapter) {
  if (!adapter?.brand_key) throw new Error('brand adapter needs brand_key');
  ADAPTERS.set(adapter.brand_key, adapter);
}
const NULL_ADAPTER = {
  resolveOwner: async () => null,
  describe: ({ eventType }) => ({ summary: eventType.name, description: '' }),
  onChange: async () => {},
  reminder: () => null,
};

export function createSchedulingService(deps = {}) {
  const env = deps.env ?? process.env;
  const store = deps.store ?? createSupabaseSchedulingStore(deps);
  const google = deps.google ?? createGoogleCalendarClient({ env, metrics: (m) => metric('google_api', m) });
  const now = () => (deps.now ? new Date(deps.now()) : new Date());
  const adapters = deps.adapters ?? ADAPTERS;
  const adapterFor = (brand) => ({ ...NULL_ADAPTER, ...(adapters.get(brand) || {}) });
  const isProduction = clean(env.NODE_ENV) === 'production' && clean(env.SCHEDULING_ALLOW_TEST_TYPES) !== '1';
  const busyMaxAgeMs = Number(env.SCHEDULING_BUSY_MAX_AGE_MINUTES || 15) * MIN;
  const metrics = deps.metrics ?? null;
  function metric(name, detail) {
    if (metrics) metrics(name, detail);
    if (detail?.ok === false || name.endsWith('_failed') || name.endsWith('conflict')) logger.warn(`scheduling.${name}`, detail);
  }

  async function eventTypeFor(brand, typeKey) {
    const type = await store.getEventType(clean(brand), clean(typeKey));
    if (!type) throw new SchedulingError('event_type_not_found', 404);
    if (type.environment === 'test' && isProduction) throw new SchedulingError('event_type_not_found', 404);
    return type;
  }

  /** Domain adapter resolves an owner record → configured resource, or null. Never invented. */
  async function ownerResource(brand, eventType, refs) {
    if (!eventType.routing?.owner) return null;
    const key = await adapterFor(brand).resolveOwner({ role: eventType.routing.owner, refs, deps });
    if (!key) return null;
    const byUser = await store.findResourceByOpsUser(key);
    const resource = byUser?.active ? byUser : await store.findResourceByOperatorKey(key);
    return resource?.id ?? null;
  }

  /** Live busy from Google for resources whose mirrored busy is stale. */
  async function liveBusy(resourceIds, fromIso, toIso, { force = false } = {}) {
    const out = {};
    await Promise.all(resourceIds.map(async (rid) => {
      const conn = await store.getConnectionByResource(rid);
      if (!conn || conn.status !== 'connected') return;
      const fresh = conn.busy_synced_at && now() - new Date(conn.busy_synced_at) < busyMaxAgeMs;
      if (fresh && !force) return;
      try {
        const token = await accessTokenFor(conn);
        out[rid] = await google.freeBusy(token, { calendarId: conn.calendar_id, timeMin: fromIso, timeMax: toIso });
      } catch (error) {
        metric('availability_failed', { ok: false, reason: error.code || 'google_error', resource_id: rid });
        out[rid] = { unverifiable: true };
      }
    }));
    return out;
  }

  /**
   * Slots for a brand's event type. Returns times only — never who, never why
   * a time is busy, never anything from a calendar.
   */
  async function computeSlots({ brand, eventType, refs, fromMs, toMs, excludeAppointmentId, excludeGoogleWindow }) {
    const owner = await ownerResource(brand, eventType, refs);
    const poolKeys = [eventType.routing?.pool, eventType.routing?.fallback_pool].filter(Boolean);
    const pools = await store.poolMembers(brand, poolKeys);
    const plan = planRouting({ routing: eventType.routing || {}, ownerResourceId: owner, pools });
    const dur = eventType.duration_minutes * MIN;
    const pad = ((eventType.buffer_before_minutes || 0) + (eventType.buffer_after_minutes || 0)) * MIN + dur;
    for (const tier of plan.tiers) {
      const resources = await store.listResources(tier.resourceIds);
      if (!resources.length) continue;
      const ids = resources.map((r) => r.id);
      const fromIso = new Date(fromMs - pad).toISOString();
      const toIso = new Date(toMs + pad).toISOString();
      const [busy, live] = await Promise.all([
        store.busyFor(ids, fromIso, toIso, { excludeAppointmentId }),
        liveBusy(ids, fromIso, toIso),
      ]);
      const usable = resources.filter((r) => !live[r.id]?.unverifiable);
      for (const [rid, list] of Object.entries(live)) {
        if (Array.isArray(list)) busy[rid] = [...(busy[rid] || []), ...list.filter((b) => !sameWindow(b, excludeGoogleWindow))];
      }
      const slots = computeAvailability({ eventType, resources: usable, busy, now: now(), from: fromMs, to: toMs });
      if (slots.length) return { slots, plan, tier, owner };
    }
    return { slots: [], plan, tier: null, owner };
  }

  function sameWindow(b, w) {
    return w && Date.parse(b.start) === Date.parse(w.start) && Date.parse(b.end) === Date.parse(w.end);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async function getAvailability({ brand, typeKey, refs = [], from, to, timezone } = {}) {
    const started = Date.now();
    const eventType = await eventTypeFor(brand, typeKey);
    const tz = isValidTimeZone(timezone) ? timezone : null;
    const nowMs = now().getTime();
    const fromMs = Math.max(from ? Date.parse(from) : nowMs, nowMs);
    const toMs = Math.min(to ? Date.parse(to) : nowMs + eventType.horizon_days * DAY, nowMs + eventType.horizon_days * DAY);
    if (!(toMs > fromMs)) throw new SchedulingError('invalid_window', 422);
    const { slots } = await computeSlots({ brand, eventType, refs, fromMs, toMs });
    metric('availability', { ok: true, ms: Date.now() - started, brand, type: eventType.type_key, slots: slots.length });
    return {
      ok: true,
      event_type: { key: eventType.type_key, name: eventType.name, duration_minutes: eventType.duration_minutes },
      timezone: tz,
      slots: slots.map((s) => ({ start_at: s.start_at, end_at: s.end_at, ...(tz ? { zone: zoneAbbreviation(s.start_at, tz) } : {}) })),
    };
  }

  async function bookAppointment(input = {}) {
    const started = Date.now();
    const { brand, typeKey, startAt, refs = [], customer = {}, customerTimezone, source, reasonKey, note, idempotencyKey, actor } = input;
    const eventType = await eventTypeFor(brand, typeKey);
    if (idempotencyKey) {
      const existing = await store.getAppointmentByIdempotencyKey(clean(idempotencyKey));
      if (existing) return { ok: true, appointment: present(existing, eventType), duplicate: true };
    }
    const at = Date.parse(startAt);
    if (!Number.isFinite(at)) throw new SchedulingError('invalid_start', 422);
    const { slots, plan, tier, owner } = await computeSlots({ brand, eventType, refs, fromMs: at, toMs: at });
    const slot = slots.find((s) => Date.parse(s.start_at) === at);
    if (!slot) return conflict(brand, typeKey, refs, customerTimezone, 'slot_unavailable', started);

    const stats = await store.resourceStats(slot.resource_ids, now().toISOString());
    const ranked = rankForSlot({ strategy: plan.strategy, via: tier.via, ownerResourceId: owner, freeIds: slot.resource_ids, stats });
    const block = heldBlock(eventType, slot.start_at);
    for (const resourceId of ranked) {
      // Authoritative calendar check for this person right now (cache bypassed).
      const live = await liveBusy([resourceId], block.block_start_at, block.block_end_at, { force: true });
      if (live[resourceId]?.unverifiable) continue;
      if (Array.isArray(live[resourceId]) && live[resourceId].some((b) => Date.parse(b.start) < Date.parse(block.block_end_at) && Date.parse(b.end) > Date.parse(block.block_start_at))) continue;
      try {
        const appt = await store.insertAppointment({
          brand_key: brand, event_type_id: eventType.id, resource_id: resourceId, status: 'scheduled',
          ...block,
          customer_timezone: isValidTimeZone(customerTimezone) ? customerTimezone : null,
          customer: pickCustomer(customer), related_refs: refs.map(clean).filter(Boolean),
          source: clean(source) || 'api', reason_key: clean(reasonKey) || null, note: clean(note).slice(0, 1000) || null,
          routed_via: tier.via, idempotency_key: clean(idempotencyKey) || null, created_by: clean(actor) || clean(source) || 'api',
        });
        metric('booking', { ok: true, ms: Date.now() - started, brand, type: eventType.type_key });
        await afterCommit('booked', appt, eventType, { actor });
        return { ok: true, appointment: present(await store.getAppointment(appt.id) ?? appt, eventType) };
      } catch (error) {
        if (error instanceof SchedulingStoreError && error.code === 'slot_conflict') {
          metric('booking_conflict', { ok: false, brand, type: eventType.type_key, resource_id: resourceId });
          continue;
        }
        if (error instanceof SchedulingStoreError && error.code === 'duplicate' && idempotencyKey) {
          const existing = await store.getAppointmentByIdempotencyKey(clean(idempotencyKey));
          if (existing) return { ok: true, appointment: present(existing, eventType), duplicate: true };
        }
        throw error;
      }
    }
    return conflict(brand, typeKey, refs, customerTimezone, 'slot_unavailable', started);
  }

  async function conflict(brand, typeKey, refs, timezone, code, started) {
    metric('booking_conflict', { ok: false, brand, type: typeKey, ms: Date.now() - started });
    const fresh = await getAvailability({ brand, typeKey, refs, timezone }).catch(() => ({ slots: [] }));
    throw new SchedulingError(code, 409, { slots: fresh.slots });
  }

  async function rescheduleAppointment({ appointmentId, startAt, actor, expectedVersion, authorize } = {}) {
    const current = await store.getAppointment(clean(appointmentId));
    if (!current || (authorize && !(await authorize(current)))) throw new SchedulingError('not_found', 404);
    if (!LIVE.includes(current.status)) throw new SchedulingError('appointment_not_active', 409);
    const eventType = await store.getEventTypeById(current.event_type_id);
    const at = Date.parse(startAt);
    if (!Number.isFinite(at)) throw new SchedulingError('invalid_start', 422);
    if (at === Date.parse(current.start_at)) return { ok: true, appointment: present(current, eventType), unchanged: true };
    const { slots, plan, tier, owner } = await computeSlots({
      brand: current.brand_key, eventType, refs: current.related_refs || [], fromMs: at, toMs: at,
      excludeAppointmentId: current.id, excludeGoogleWindow: { start: current.start_at, end: current.end_at },
    });
    const slot = slots.find((s) => Date.parse(s.start_at) === at);
    if (!slot) return conflict(current.brand_key, eventType.type_key, current.related_refs, current.customer_timezone, 'slot_unavailable', Date.now());
    // Keep the same person when they are free; otherwise routing decides.
    const stats = await store.resourceStats(slot.resource_ids, now().toISOString());
    const ranked = slot.resource_ids.includes(current.resource_id)
      ? [current.resource_id, ...slot.resource_ids.filter((id) => id !== current.resource_id)]
      : rankForSlot({ strategy: plan.strategy, via: tier.via, ownerResourceId: owner, freeIds: slot.resource_ids, stats });
    const block = heldBlock(eventType, slot.start_at);
    for (const resourceId of ranked) {
      try {
        const newId = await store.rescheduleAppointment(current.id, expectedVersion ?? current.version, { ...block, resource_id: resourceId, routed_via: resourceId === current.resource_id ? current.routed_via : tier.via }, clean(actor) || 'api');
        const next = await store.getAppointment(newId);
        if (resourceId !== current.resource_id && current.google_event_id) await removeGoogleEvent(current).catch(() => null);
        await afterCommit('rescheduled', next, eventType, { actor, previous: current });
        return { ok: true, appointment: present(await store.getAppointment(newId) ?? next, eventType), previous_id: current.id };
      } catch (error) {
        if (error instanceof SchedulingStoreError && error.code === 'slot_conflict') { metric('booking_conflict', { ok: false, op: 'reschedule' }); continue; }
        if (error instanceof SchedulingStoreError && ['version_conflict', 'appointment_not_active'].includes(error.code)) throw new SchedulingError(error.code, 409);
        throw error;
      }
    }
    return conflict(current.brand_key, eventType.type_key, current.related_refs, current.customer_timezone, 'slot_unavailable', Date.now());
  }

  async function cancelAppointment({ appointmentId, actor, reason, authorize } = {}) {
    const current = await store.getAppointment(clean(appointmentId));
    if (!current || (authorize && !(await authorize(current)))) throw new SchedulingError('not_found', 404);
    if (!LIVE.includes(current.status)) return { ok: true, appointment: present(current, await store.getEventTypeById(current.event_type_id)), unchanged: true };
    const nowIso = now().toISOString();
    const updated = await store.updateAppointment(current.id, { status: 'cancelled', cancelled_at: nowIso, cancelled_by: clean(actor) || 'api', cancel_reason: clean(reason).slice(0, 300) || null, version: current.version + 1, sync_status: current.google_event_id ? 'pending' : current.sync_status }, { statusIn: LIVE, version: current.version });
    if (!updated) throw new SchedulingError('version_conflict', 409);
    const eventType = await store.getEventTypeById(current.event_type_id);
    await afterCommit('cancelled', updated, eventType, { actor, previous: current });
    return { ok: true, appointment: present(await store.getAppointment(current.id) ?? updated, eventType) };
  }

  /** Ops outcome: confirmed / completed / no_show. */
  async function markOutcome({ appointmentId, outcome, actor } = {}) {
    if (!['confirmed', 'completed', 'no_show'].includes(outcome)) throw new SchedulingError('invalid_outcome', 422);
    const current = await store.getAppointment(clean(appointmentId));
    if (!current) throw new SchedulingError('not_found', 404);
    const allowed = outcome === 'confirmed' ? ['scheduled'] : LIVE;
    const patch = { status: outcome, version: current.version + 1, outcome_by: clean(actor) || null, ...(outcome === 'completed' ? { completed_at: now().toISOString() } : {}) };
    const updated = await store.updateAppointment(current.id, patch, { statusIn: allowed, version: current.version });
    if (!updated) throw new SchedulingError('appointment_not_active', 409);
    await store.appendEvent({ appointment_id: current.id, brand_key: current.brand_key, event: outcome, actor: clean(actor) || null, detail: {} });
    await adapterFor(current.brand_key).onChange(outcome, { appointment: updated, eventType: await store.getEventTypeById(current.event_type_id), previous: current, deps }).catch((e) => metric('notification_failed', { ok: false, kind: outcome, reason: e.message }));
    return { ok: true, appointment: updated };
  }

  /** Ops assignment (needs-assignment queue). The overlap constraint still applies. */
  async function assignAppointment({ appointmentId, resourceId, actor } = {}) {
    const current = await store.getAppointment(clean(appointmentId));
    if (!current || !LIVE.includes(current.status)) throw new SchedulingError('appointment_not_active', 409);
    const resource = await store.getResource(clean(resourceId));
    if (!resource?.active) throw new SchedulingError('resource_not_found', 404);
    try {
      const updated = await store.updateAppointment(current.id, { resource_id: resource.id, version: current.version + 1, sync_status: 'pending', google_event_id: null, google_calendar_id: null }, { statusIn: LIVE, version: current.version });
      if (!updated) throw new SchedulingError('version_conflict', 409);
      if (current.google_event_id) await removeGoogleEvent(current).catch(() => null);
      await store.appendEvent({ appointment_id: current.id, brand_key: current.brand_key, event: 'assigned', actor: clean(actor) || null, detail: { resource_id: resource.id } });
      await syncAppointment(updated);
      return { ok: true, appointment: await store.getAppointment(current.id) };
    } catch (error) {
      if (error instanceof SchedulingStoreError && error.code === 'slot_conflict') throw new SchedulingError('resource_busy', 409);
      throw error;
    }
  }

  async function afterCommit(kind, appointment, eventType, { actor, previous } = {}) {
    if (kind === 'booked') await store.appendEvent({ appointment_id: appointment.id, brand_key: appointment.brand_key, event: 'booked', actor: clean(actor) || null, detail: { routed_via: appointment.routed_via } });
    if (kind === 'cancelled') await store.appendEvent({ appointment_id: appointment.id, brand_key: appointment.brand_key, event: 'cancelled', actor: clean(actor) || null, detail: {} });
    await syncAppointment(appointment);
    const adapter = adapterFor(appointment.brand_key);
    try {
      await adapter.onChange(kind, { appointment, eventType, previous, deps });
    } catch (error) {
      metric('notification_failed', { ok: false, kind, brand: appointment.brand_key, reason: error.message });
    }
    if (kind !== 'cancelled') {
      await scheduleReminders({ appointment, eventType, adapter, now: now(), deps }).catch((e) => metric('notification_failed', { ok: false, kind: 'reminder', reason: e.message }));
    }
  }

  // -------------------------------------------------------------------------
  // Google sync — our database is the record; Google mirrors it.
  // -------------------------------------------------------------------------

  async function accessTokenFor(conn) {
    try {
      return await google.accessToken(decryptSecret(conn.refresh_token_ciphertext, env));
    } catch (error) {
      if (error.code === 'google_invalid_grant' || error.code === 'google_unauthorized') {
        await store.updateConnection(conn.id, { status: 'needs_reauth', last_error_code: error.code, last_error_at: now().toISOString() });
        metric('google_auth_expired', { ok: false, connection_id: conn.id });
      }
      throw error;
    }
  }

  async function googleEventBody(appointment) {
    const eventType = await store.getEventTypeById(appointment.event_type_id);
    const resource = appointment.resource_id ? await store.getResource(appointment.resource_id) : null;
    const described = await adapterFor(appointment.brand_key).describe({ appointment, eventType, deps });
    return {
      summary: clean(described.summary).slice(0, 200) || eventType.name,
      description: clean(described.description).slice(0, 2000),
      start: { dateTime: appointment.start_at, timeZone: resource?.timezone || 'UTC' },
      end: { dateTime: appointment.end_at, timeZone: resource?.timezone || 'UTC' },
      visibility: 'private',
      transparency: 'opaque',
      extendedProperties: { private: { scheduling_appointment_id: appointment.id, scheduling_brand: appointment.brand_key } },
    };
  }

  async function syncAppointment(appointment) {
    if (!appointment?.resource_id) return;
    const conn = await store.getConnectionByResource(appointment.resource_id);
    if (!conn || conn.status !== 'connected') {
      if (LIVE.includes(appointment.status)) await store.updateAppointment(appointment.id, { sync_status: 'not_connected' });
      return;
    }
    try {
      const token = await accessTokenFor(conn);
      if (LIVE.includes(appointment.status)) {
        const body = await googleEventBody(appointment);
        let event = null;
        if (appointment.google_event_id) {
          event = await google.patchEvent(token, conn.calendar_id, appointment.google_event_id, body).catch((e) => {
            if (['google_not_found', 'google_gone'].includes(e.code)) return null;
            throw e;
          });
        }
        if (!event) event = await google.insertEvent(token, conn.calendar_id, body);
        await store.updateAppointment(appointment.id, { google_event_id: event.id, google_calendar_id: conn.calendar_id, sync_status: 'synced', sync_error: null, synced_at: now().toISOString() });
      } else if (appointment.status === 'cancelled' && appointment.google_event_id) {
        // Supported cancellation policy: the mirrored event is removed from
        // the person's calendar (Google keeps it as cancelled in its history).
        await google.deleteEvent(token, conn.calendar_id, appointment.google_event_id);
        await store.updateAppointment(appointment.id, { sync_status: 'synced', sync_error: null, synced_at: now().toISOString() });
      } else {
        await store.updateAppointment(appointment.id, { sync_status: 'synced', synced_at: now().toISOString() });
      }
    } catch (error) {
      await store.updateAppointment(appointment.id, { sync_status: 'failed', sync_error: clean(error.code || 'sync_failed').slice(0, 80) });
      metric('sync_failed', { ok: false, appointment_id: appointment.id, reason: error.code || 'sync_failed' });
    }
  }

  async function removeGoogleEvent(appointment) {
    const conn = appointment.resource_id ? await store.getConnectionByResource(appointment.resource_id) : null;
    if (!conn || conn.status !== 'connected' || !appointment.google_event_id) return;
    const token = await accessTokenFor(conn);
    await google.deleteEvent(token, appointment.google_calendar_id || conn.calendar_id, appointment.google_event_id);
  }

  /**
   * Google → us. Busy time from everything that is not ours is mirrored as
   * times only. Our own events are compared with the appointment: a move or
   * deletion made in Google does NOT change the appointment (the customer was
   * promised a time); it is flagged as drift for a person to resolve, and the
   * appointment keeps holding its time.
   */
  async function syncConnectionBusy(conn) {
    const started = Date.now();
    let token;
    try {
      token = await accessTokenFor(conn);
    } catch (error) {
      return { ok: false, reason: error.code };
    }
    let syncToken = conn.sync_token || null;
    let pageToken = null;
    let full = !syncToken;
    const upserts = [];
    const deletes = [];
    let drift = 0;
    let orphans = 0;
    const resource = await store.getResource(conn.resource_id);
    for (let page = 0; page < 40; page++) {
      let body;
      try {
        body = await google.listEvents(token, conn.calendar_id, full ? { timeMin: new Date(now().getTime() - DAY).toISOString(), pageToken } : { syncToken, pageToken });
      } catch (error) {
        if (error.code === 'google_gone' && !full) {
          await store.clearBusy(conn.id);
          full = true; syncToken = null; pageToken = null; page = -1; upserts.length = 0; deletes.length = 0;
          continue;
        }
        await store.updateConnection(conn.id, { last_error_code: error.code || 'sync_failed', last_error_at: now().toISOString() });
        metric('sync_failed', { ok: false, connection_id: conn.id, reason: error.code });
        return { ok: false, reason: error.code };
      }
      for (const item of body.items || []) {
        const ours = item.extendedProperties?.private?.scheduling_appointment_id;
        if (ours) {
          const result = await reconcileOwnEvent(ours, item, conn, token);
          if (result === 'drift') drift++;
          if (result === 'orphan') orphans++;
          continue;
        }
        if (item.status === 'cancelled' || item.transparency === 'transparent') { deletes.push(item.id); continue; }
        const span = eventSpan(item, resource?.timezone);
        if (!span) continue;
        upserts.push({ connection_id: conn.id, resource_id: conn.resource_id, external_event_id: item.id, start_at: span.start, end_at: span.end, updated_at: now().toISOString() });
      }
      if (body.nextPageToken) { pageToken = body.nextPageToken; continue; }
      if (full) await store.clearBusy(conn.id);
      await store.upsertBusy(upserts);
      await store.deleteBusy(conn.id, deletes);
      await store.updateConnection(conn.id, { sync_token: body.nextSyncToken || null, busy_synced_at: now().toISOString(), last_error_code: null });
      metric('calendar_sync', { ok: true, ms: Date.now() - started, connection_id: conn.id, upserts: upserts.length, deletes: deletes.length, drift, orphans });
      return { ok: true, upserts: upserts.length, deletes: deletes.length, drift, orphans, full };
    }
    return { ok: false, reason: 'too_many_pages' };
  }

  function eventSpan(item, tz) {
    if (item.start?.dateTime && item.end?.dateTime) return { start: new Date(item.start.dateTime).toISOString(), end: new Date(item.end.dateTime).toISOString() };
    if (item.start?.date && item.end?.date) {
      // An all-day event marked busy blocks the whole local day(s).
      const zone = tz || 'UTC';
      const startMs = wallMidnight(item.start.date, zone);
      const endMs = wallMidnight(item.end.date, zone);
      return startMs && endMs ? { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() } : null;
    }
    return null;
  }
  function wallMidnight(date, tz) {
    const guess = Date.parse(`${date}T00:00:00Z`);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(guess);
    const get = (t) => Number(p.find((x) => x.type === t).value);
    const offset = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - guess;
    return guess - offset;
  }

  async function reconcileOwnEvent(appointmentId, item, conn, token) {
    const appt = await store.getAppointment(appointmentId);
    if (!appt || !LIVE.includes(appt.status) || appt.google_event_id !== item.id) {
      // Our marker, but no live appointment owns this event: remove it (we own it).
      if (item.status !== 'cancelled') {
        await google.deleteEvent(token, conn.calendar_id, item.id).catch(() => null);
        metric('orphan_calendar_event', { ok: false, connection_id: conn.id });
        return 'orphan';
      }
      return 'ok';
    }
    const moved = item.status !== 'cancelled' && (Date.parse(item.start?.dateTime) !== Date.parse(appt.start_at) || Date.parse(item.end?.dateTime) !== Date.parse(appt.end_at));
    if (item.status === 'cancelled' || moved) {
      if (appt.sync_status !== 'drift') {
        await store.updateAppointment(appt.id, { sync_status: 'drift', sync_error: item.status === 'cancelled' ? 'deleted_in_google' : 'moved_in_google' });
        await store.appendEvent({ appointment_id: appt.id, brand_key: appt.brand_key, event: 'drift_detected', actor: 'google', detail: { kind: item.status === 'cancelled' ? 'deleted' : 'moved' } });
        metric('drift_detected', { ok: false, appointment_id: appt.id });
      }
      return 'drift';
    }
    return 'ok';
  }

  /** Push notification from Google. Only a channel we created, with its secret token, is honoured. */
  async function handleGoogleNotification(headers = {}) {
    const channelId = clean(headers['x-goog-channel-id']);
    const token = clean(headers['x-goog-channel-token']);
    const state = clean(headers['x-goog-resource-state']);
    if (!channelId || !token) { metric('webhook_rejected', { ok: false, reason: 'missing_headers' }); return { ok: false, status: 400 }; }
    const conn = await store.getConnectionByChannel(channelId);
    const expected = Buffer.from(conn?.watch_token_hash || '', 'hex');
    const got = Buffer.from(sha256(token), 'hex');
    if (!conn || expected.length !== got.length || !timingSafeEqual(expected, got)) { metric('webhook_rejected', { ok: false, reason: 'unknown_channel' }); return { ok: false, status: 404 }; }
    if (state === 'sync') return { ok: true, status: 200, initial: true };
    const result = await syncConnectionBusy(conn);
    return { ok: true, status: 200, result };
  }

  async function ensureWatch(conn) {
    const address = clean(env.GOOGLE_CALENDAR_WEBHOOK_URL);
    if (!address) return { ok: false, reason: 'webhook_not_configured' };
    if (conn.watch_expires_at && Date.parse(conn.watch_expires_at) - now().getTime() > DAY) return { ok: true, reason: 'current' };
    const token = await accessTokenFor(conn);
    if (conn.watch_channel_id && conn.watch_resource_id) await google.stopChannel(token, { id: conn.watch_channel_id, resourceId: conn.watch_resource_id });
    const id = globalThis.crypto.randomUUID();
    const channelToken = randomBytes(24).toString('base64url');
    const res = await google.watch(token, conn.calendar_id, { id, token: channelToken, address });
    await store.updateConnection(conn.id, { watch_channel_id: id, watch_resource_id: res.resourceId, watch_token_hash: sha256(channelToken), watch_expires_at: res.expiration ? new Date(Number(res.expiration)).toISOString() : null });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Connecting a person's Google Calendar (OAuth, per team member)
  // -------------------------------------------------------------------------

  async function startGoogleConnect({ opsUserId, resourceId, returnTo } = {}) {
    if (!google.config.configured) throw new SchedulingError('google_not_configured', 503);
    if (!tokenCryptoConfigured(env)) throw new SchedulingError('token_encryption_not_configured', 503);
    const resource = resourceId ? await store.getResource(clean(resourceId)) : await store.findResourceByOpsUser(clean(opsUserId));
    if (!resource) throw new SchedulingError('resource_not_found', 404);
    // A person connects their own calendar; nobody connects someone else's.
    if (resource.ops_user_id && resource.ops_user_id !== clean(opsUserId)) throw new SchedulingError('forbidden', 403);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await store.insertOAuthState({
      state_hash: sha256(state), resource_id: resource.id, ops_user_id: clean(opsUserId),
      verifier_ciphertext: encryptSecret(verifier, env).ciphertext, return_to: safeReturn(returnTo),
      expires_at: new Date(now().getTime() + 10 * MIN).toISOString(),
    });
    return { ok: true, url: google.authorizationUrl({ state, codeChallenge: challenge, loginHint: resource.email || undefined }) };
  }

  function safeReturn(v) {
    const s = clean(v);
    return s.startsWith('/') && !s.startsWith('//') ? s.slice(0, 200) : null;
  }

  async function completeGoogleConnect({ state, code } = {}) {
    const row = await store.consumeOAuthState(sha256(clean(state)), now().toISOString());
    if (!row) throw new SchedulingError('oauth_state_invalid', 400);
    const verifier = decryptSecret(row.verifier_ciphertext, env);
    const tokens = await google.exchangeCode({ code: clean(code), codeVerifier: verifier });
    if (!tokens.refreshToken) throw new SchedulingError('google_no_refresh_token', 400);
    const missing = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'].filter((s) => !tokens.scopes.includes(s));
    if (missing.length) throw new SchedulingError('google_scopes_missing', 400);
    const enc = encryptSecret(tokens.refreshToken, env);
    const conn = await store.upsertConnection({
      resource_id: row.resource_id, provider: 'google', account_email: tokens.email, calendar_id: 'primary',
      refresh_token_ciphertext: enc.ciphertext, token_key_id: enc.keyId, scopes: tokens.scopes,
      status: 'connected', connected_at: now().toISOString(), last_error_code: null, sync_token: null, busy_synced_at: null,
    });
    await syncConnectionBusy(conn).catch(() => null);
    await ensureWatch(await store.getConnection(conn.id)).catch(() => null);
    return { ok: true, return_to: row.return_to, connection: presentConnection(await store.getConnection(conn.id)) };
  }

  async function disconnectGoogle({ resourceId, opsUserId } = {}) {
    const resource = await store.getResource(clean(resourceId));
    if (!resource) throw new SchedulingError('resource_not_found', 404);
    const conn = await store.getConnectionByResource(resource.id);
    if (!conn) return { ok: true };
    try {
      const refresh = decryptSecret(conn.refresh_token_ciphertext, env);
      const token = await google.accessToken(refresh).catch(() => null);
      if (token && conn.watch_channel_id) await google.stopChannel(token, { id: conn.watch_channel_id, resourceId: conn.watch_resource_id });
      await google.revoke(refresh);
    } catch { /* revoke is best effort; the credential is destroyed below either way */ }
    await store.clearBusy(conn.id);
    await store.updateConnection(conn.id, { status: 'disconnected', refresh_token_ciphertext: null, token_key_id: null, sync_token: null, watch_channel_id: null, watch_resource_id: null, watch_token_hash: null, watch_expires_at: null, last_error_code: null });
    logger.info('scheduling.calendar_disconnected', { resource_id: resource.id, by: clean(opsUserId) || null });
    return { ok: true };
  }

  function presentConnection(c) {
    if (!c) return null;
    const stale = c.status === 'connected' && (!c.busy_synced_at || now() - new Date(c.busy_synced_at) > 30 * MIN);
    return {
      status: c.status, account_email: c.account_email, connected_at: c.connected_at, busy_synced_at: c.busy_synced_at,
      health: c.status !== 'connected' ? c.status : stale ? 'stale' : 'healthy',
      last_error_code: c.last_error_code, push_notifications: Boolean(c.watch_channel_id), watch_expires_at: c.watch_expires_at,
    };
  }

  // -------------------------------------------------------------------------
  // Reconciliation tick (cron): missed webhooks, failed syncs, renewals.
  // -------------------------------------------------------------------------
  async function reconcile({ maxConnections = 25 } = {}) {
    const started = Date.now();
    const summary = { connections_synced: 0, connection_errors: 0, watches_renewed: 0, appointments_resynced: 0, appointment_sync_failures: 0 };
    const conns = (await store.listConnections()).filter((c) => c.status === 'connected').slice(0, maxConnections);
    for (const conn of conns) {
      if (!conn.busy_synced_at || now() - new Date(conn.busy_synced_at) > 10 * MIN) {
        const r = await syncConnectionBusy(conn);
        if (r.ok) summary.connections_synced++; else summary.connection_errors++;
      }
      const w = await ensureWatch(await store.getConnection(conn.id)).catch(() => ({ ok: false }));
      if (w.ok && w.reason !== 'current') summary.watches_renewed++;
    }
    for (const appt of await store.listNeedingSync(50)) {
      await syncAppointment(appt);
      const after = await store.getAppointment(appt.id);
      if (after?.sync_status === 'failed') summary.appointment_sync_failures++; else summary.appointments_resynced++;
    }
    await store.pruneOAuthStates(new Date(now().getTime() - DAY).toISOString()).catch(() => null);
    metric('reconcile', { ok: true, ms: Date.now() - started, ...summary });
    return { ok: true, ...summary };
  }

  // -------------------------------------------------------------------------
  // Operations read models (Calendar)
  // -------------------------------------------------------------------------
  const OPS_VIEWS = {
    today: (nowMs, dayStart) => ({ fromIso: new Date(dayStart).toISOString(), toIso: new Date(dayStart + DAY).toISOString(), statuses: ['scheduled', 'confirmed', 'completed', 'no_show'] }),
    upcoming: (nowMs) => ({ fromIso: new Date(nowMs).toISOString(), toIso: new Date(nowMs + 60 * DAY).toISOString(), statuses: LIVE }),
    needs_assignment: (nowMs) => ({ fromIso: new Date(nowMs - DAY).toISOString(), statuses: LIVE }),
    completed: (nowMs) => ({ fromIso: new Date(nowMs - 30 * DAY).toISOString(), statuses: ['completed'] }),
    cancelled: (nowMs) => ({ fromIso: new Date(nowMs - 30 * DAY).toISOString(), statuses: ['cancelled'] }),
    no_show: (nowMs) => ({ fromIso: new Date(nowMs - 30 * DAY).toISOString(), statuses: ['no_show'] }),
  };

  async function listForOps({ view = 'upcoming', brand, resourceId, typeKey, timezone } = {}) {
    const make = OPS_VIEWS[view];
    if (!make) throw new SchedulingError('invalid_view', 422);
    const tz = isValidTimeZone(timezone) ? timezone : 'America/New_York';
    const nowMs = now().getTime();
    const dayStart = startOfLocalDay(nowMs, tz);
    let eventTypeId;
    if (brand && typeKey) eventTypeId = (await store.getEventType(brand, typeKey))?.id;
    let rows = await store.listAppointments({ ...make(nowMs, dayStart), brand: clean(brand) || undefined, resourceId: clean(resourceId) || undefined, eventTypeId });
    // Needs assignment: nobody holds it, or its calendar copy drifted.
    if (view === 'needs_assignment') rows = rows.filter((a) => !a.resource_id || a.sync_status === 'drift');
    return { ok: true, view, timezone: tz, appointments: await Promise.all(rows.map((a) => opsView(a))) };
  }

  function startOfLocalDay(ms, tz) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
    return wallMidnight(p, tz);
  }

  const typeCache = new Map();
  const resourceCache = new Map();
  async function opsView(a) {
    if (!typeCache.has(a.event_type_id)) typeCache.set(a.event_type_id, await store.getEventTypeById(a.event_type_id));
    if (a.resource_id && !resourceCache.has(a.resource_id)) resourceCache.set(a.resource_id, await store.getResource(a.resource_id));
    const eventType = typeCache.get(a.event_type_id);
    const resource = a.resource_id ? resourceCache.get(a.resource_id) : null;
    const described = await Promise.resolve().then(() => adapterFor(a.brand_key).describe({ appointment: a, eventType, deps })).catch(() => ({ summary: eventType?.name, description: '' }));
    return {
      id: a.id, brand: a.brand_key, status: a.status, start_at: a.start_at, end_at: a.end_at,
      duration_minutes: eventType?.duration_minutes ?? Math.round((Date.parse(a.end_at) - Date.parse(a.start_at)) / MIN),
      type: eventType ? { key: eventType.type_key, name: eventType.name } : null,
      assigned: resource ? { id: resource.id, name: resource.display_name } : null,
      context: { summary: described.summary, lines: clean(described.description).split('\n').filter((l) => l && !l.startsWith('Details (sign-in')) },
      customer: a.customer, customer_timezone: a.customer_timezone, related_refs: a.related_refs,
      source: a.source, sync_status: a.sync_status, sync_error: a.sync_error, version: a.version, routed_via: a.routed_via,
    };
  }

  async function appointmentDetail(id) {
    const a = await store.getAppointment(clean(id));
    if (!a) throw new SchedulingError('not_found', 404);
    return { ok: true, appointment: await opsView(a), history: await store.listEvents(a.id) };
  }

  // -------------------------------------------------------------------------
  // Read models
  // -------------------------------------------------------------------------
  function present(a, eventType) {
    return {
      id: a.id, brand: a.brand_key, status: a.status, start_at: a.start_at, end_at: a.end_at,
      timezone: a.customer_timezone, type: eventType ? { key: eventType.type_key, name: eventType.name, duration_minutes: eventType.duration_minutes } : null,
      reason_key: a.reason_key, version: a.version, rescheduled_from_id: a.rescheduled_from_id ?? null,
    };
  }

  return {
    store,
    getAvailability,
    bookAppointment,
    rescheduleAppointment,
    cancelAppointment,
    markOutcome,
    assignAppointment,
    syncAppointment,
    syncConnectionBusy,
    handleGoogleNotification,
    startGoogleConnect,
    completeGoogleConnect,
    disconnectGoogle,
    presentConnection,
    reconcile,
    present,
    listForOps,
    appointmentDetail,
  };
}

function pickCustomer(c = {}) {
  const out = {};
  if (clean(c.name)) out.name = clean(c.name).slice(0, 120);
  if (clean(c.email)) out.email = clean(c.email).toLowerCase().slice(0, 254);
  if (clean(c.phone)) out.phone = clean(c.phone).slice(0, 20);
  return out;
}
