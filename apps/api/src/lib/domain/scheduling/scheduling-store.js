/**
 * Scheduling core — persistence.
 *
 * The Supabase store is service-role only. The in-memory twin implements the
 * same interface and the same invariants — in particular the cross-brand
 * no-overlap rule is checked and applied inside one synchronous step, which is
 * what the database's exclusion constraint guarantees — so service tests
 * exercise real behaviour. Errors are `SchedulingStoreError` with a stable
 * code; 'slot_conflict' is the overlap rejection.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

export class SchedulingStoreError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const LIVE = ['scheduled', 'confirmed'];
const APPT_COLUMNS = 'id, brand_key, event_type_id, resource_id, status, start_at, end_at, block_start_at, block_end_at, customer_timezone, customer, related_refs, source, reason_key, note, routed_via, rescheduled_from_id, rescheduled_to_id, cancelled_at, cancelled_by, cancel_reason, completed_at, outcome_by, google_calendar_id, google_event_id, sync_status, sync_error, synced_at, idempotency_key, version, created_by, created_at, updated_at';

function mapPgError(error, fallback) {
  if (error?.code === '23P01') return new SchedulingStoreError('slot_conflict');
  if (error?.code === '23505') return new SchedulingStoreError('duplicate');
  if (/appointment_not_active/.test(error?.message || '')) return new SchedulingStoreError('appointment_not_active');
  if (/appointment_version_conflict/.test(error?.message || '')) return new SchedulingStoreError('version_conflict');
  if (/appointment_not_found/.test(error?.message || '')) return new SchedulingStoreError('not_found');
  return new SchedulingStoreError(fallback, error?.message);
}

export function createSupabaseSchedulingStore(deps = {}) {
  const db = () => deps.db ?? deps.supabase ?? getDefaultSupabaseClient();
  async function one(query, code) {
    const { data, error } = await query.maybeSingle();
    if (error) throw mapPgError(error, code);
    return data ?? null;
  }
  async function many(query, code) {
    const { data, error } = await query;
    if (error) throw mapPgError(error, code);
    return data ?? [];
  }

  return {
    kind: 'supabase',

    // --- configuration --------------------------------------------------------
    getEventType: (brand, typeKey) => one(db().from('scheduling_event_types').select('*').eq('brand_key', brand).eq('type_key', typeKey).eq('active', true), 'event_type_read_failed'),
    getEventTypeById: (id) => one(db().from('scheduling_event_types').select('*').eq('id', id), 'event_type_read_failed'),
    listEventTypes: (brand) => many(db().from('scheduling_event_types').select('*').eq('brand_key', brand).eq('active', true).order('name'), 'event_type_read_failed'),
    listResources: (ids) => (ids.length ? many(db().from('scheduling_resources').select('*').in('id', ids).eq('active', true), 'resource_read_failed') : []),
    listAllResources: () => many(db().from('scheduling_resources').select('*').order('display_name'), 'resource_read_failed'),
    getResource: (id) => one(db().from('scheduling_resources').select('*').eq('id', id), 'resource_read_failed'),
    findResourceByOpsUser: (uid) => one(db().from('scheduling_resources').select('*').eq('ops_user_id', uid), 'resource_read_failed'),
    async findResourceByOperatorKey(key) {
      const rows = await many(db().from('scheduling_resources').select('*').contains('operator_keys', [key]).eq('active', true).limit(2), 'resource_read_failed');
      return rows.length === 1 ? rows[0] : null; // ambiguous keys never auto-assign
    },
    async poolMembers(brand, poolKeys) {
      const keys = poolKeys.filter(Boolean);
      if (!keys.length) return {};
      const pools = await many(db().from('scheduling_pools').select('id, pool_key').eq('brand_key', brand).in('pool_key', keys), 'pool_read_failed');
      if (!pools.length) return {};
      const members = await many(db().from('scheduling_pool_members').select('pool_id, resource_id, resource:scheduling_resources(active)').in('pool_id', pools.map((p) => p.id)).eq('active', true), 'pool_read_failed');
      const out = {};
      for (const p of pools) out[p.pool_key] = members.filter((m) => m.pool_id === p.id && m.resource?.active !== false).map((m) => m.resource_id);
      return out;
    },

    /** Least privilege: an explicit grant on an allowlisted operator (ops_operator_permissions). */
    async hasPermission(userId, permission) {
      if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) return false;
      const { data, error } = await db().from('ops_operator_permissions').select('permission').eq('user_id', userId).eq('permission', permission).maybeSingle();
      if (error) throw mapPgError(error, 'permission_read_failed');
      return Boolean(data);
    },
    async updateEventType(id, patch) {
      const { data, error } = await db().from('scheduling_event_types').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
      if (error) throw mapPgError(error, 'event_type_write_failed');
      return data;
    },
    listAllEventTypes: () => many(db().from('scheduling_event_types').select('*').order('brand_key').order('name'), 'event_type_read_failed'),
    async upsertResource(row) {
      const { data, error } = await db().from('scheduling_resources').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: row.id ? 'id' : 'ops_user_id' }).select('*').single();
      if (error) throw mapPgError(error, 'resource_write_failed');
      return data;
    },
    async setPoolMember({ brand, poolKey, poolName, resourceId, active }) {
      const { data: pool, error } = await db().from('scheduling_pools').upsert({ brand_key: brand, pool_key: poolKey, name: poolName || poolKey }, { onConflict: 'brand_key,pool_key' }).select('id').single();
      if (error) throw mapPgError(error, 'pool_write_failed');
      const { error: e2 } = await db().from('scheduling_pool_members').upsert({ pool_id: pool.id, resource_id: resourceId, active }, { onConflict: 'pool_id,resource_id' });
      if (e2) throw mapPgError(e2, 'pool_write_failed');
    },
    listPools: () => many(db().from('scheduling_pools').select('id, brand_key, pool_key, name, members:scheduling_pool_members(resource_id, active)'), 'pool_read_failed'),
    async insertTimeOff(row) {
      const { data, error } = await db().from('scheduling_time_off').insert(row).select('*').single();
      if (error) throw mapPgError(error, 'time_off_write_failed');
      return data;
    },

    // --- busy time (all brands) ----------------------------------------------
    async busyFor(resourceIds, fromIso, toIso, { excludeAppointmentId } = {}) {
      if (!resourceIds.length) return {};
      const [appts, off, ext] = await Promise.all([
        many(db().from('scheduling_appointments').select('id, resource_id, block_start_at, block_end_at').in('resource_id', resourceIds).in('status', LIVE).lt('block_start_at', toIso).gt('block_end_at', fromIso), 'busy_read_failed'),
        many(db().from('scheduling_time_off').select('resource_id, start_at, end_at').in('resource_id', resourceIds).lt('start_at', toIso).gt('end_at', fromIso), 'busy_read_failed'),
        many(db().from('scheduling_external_busy').select('resource_id, start_at, end_at').in('resource_id', resourceIds).lt('start_at', toIso).gt('end_at', fromIso), 'busy_read_failed'),
      ]);
      const out = Object.fromEntries(resourceIds.map((id) => [id, []]));
      for (const a of appts) if (a.id !== excludeAppointmentId) out[a.resource_id]?.push({ start: a.block_start_at, end: a.block_end_at });
      for (const b of [...off, ...ext]) out[b.resource_id]?.push({ start: b.start_at, end: b.end_at });
      return out;
    },
    async resourceStats(resourceIds, nowIso) {
      if (!resourceIds.length) return {};
      const weekAhead = new Date(Date.parse(nowIso) + 7 * 86400e3).toISOString();
      const monthAgo = new Date(Date.parse(nowIso) - 30 * 86400e3).toISOString();
      const [recent, upcoming] = await Promise.all([
        many(db().from('scheduling_appointments').select('resource_id, created_at').in('resource_id', resourceIds).gte('created_at', monthAgo).order('created_at', { ascending: false }).limit(1000), 'stats_read_failed'),
        many(db().from('scheduling_appointments').select('resource_id').in('resource_id', resourceIds).in('status', LIVE).gte('start_at', nowIso).lt('start_at', weekAhead), 'stats_read_failed'),
      ]);
      const out = Object.fromEntries(resourceIds.map((id) => [id, { lastAssignedAt: null, upcoming: 0 }]));
      for (const r of recent) if (out[r.resource_id] && out[r.resource_id].lastAssignedAt == null) out[r.resource_id].lastAssignedAt = Date.parse(r.created_at);
      for (const r of upcoming) if (out[r.resource_id]) out[r.resource_id].upcoming += 1;
      return out;
    },

    // --- appointments ---------------------------------------------------------
    async insertAppointment(row) {
      const { data, error } = await db().from('scheduling_appointments').insert(row).select(APPT_COLUMNS).single();
      if (error) throw mapPgError(error, 'appointment_write_failed');
      return data;
    },
    getAppointment: (id) => one(db().from('scheduling_appointments').select(APPT_COLUMNS).eq('id', id), 'appointment_read_failed'),
    getAppointmentByIdempotencyKey: (key) => one(db().from('scheduling_appointments').select(APPT_COLUMNS).eq('idempotency_key', key), 'appointment_read_failed'),
    /** Conditional update: only rows still matching `where` change. Returns the row or null. */
    async updateAppointment(id, patch, where = {}) {
      let q = db().from('scheduling_appointments').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (where.statusIn) q = q.in('status', where.statusIn);
      if (where.version != null) q = q.eq('version', where.version);
      const { data, error } = await q.select(APPT_COLUMNS).maybeSingle();
      if (error) throw mapPgError(error, 'appointment_write_failed');
      return data ?? null;
    },
    async rescheduleAppointment(id, expectedVersion, next, actor) {
      const { data, error } = await db().rpc('scheduling_reschedule_appointment', { p_appointment_id: id, p_expected_version: expectedVersion ?? null, p_new: next, p_actor: actor });
      if (error) throw mapPgError(error, 'appointment_write_failed');
      return data;
    },
    async appendEvent(row) {
      const { error } = await db().from('scheduling_appointment_events').insert(row);
      if (error) throw mapPgError(error, 'event_write_failed');
    },
    listEvents: (appointmentId) => many(db().from('scheduling_appointment_events').select('event, actor, detail, created_at').eq('appointment_id', appointmentId).order('created_at'), 'event_read_failed'),
    listAppointmentsByRelated: (ref) => many(db().from('scheduling_appointments').select(APPT_COLUMNS).contains('related_refs', [ref]).order('start_at'), 'appointment_read_failed'),
    findByGoogleEvent: (eventId) => one(db().from('scheduling_appointments').select(APPT_COLUMNS).eq('google_event_id', eventId).in('status', LIVE).limit(1), 'appointment_read_failed'),
    listNeedingSync: (limit = 50) => many(db().from('scheduling_appointments').select(APPT_COLUMNS).in('sync_status', ['pending', 'failed']).not('resource_id', 'is', null).order('updated_at').limit(limit), 'appointment_read_failed'),
    async listAppointments({ fromIso, toIso, brand, resourceId, eventTypeId, statuses, unassigned, limit = 300 } = {}) {
      let q = db().from('scheduling_appointments').select(APPT_COLUMNS);
      if (fromIso) q = q.gte('start_at', fromIso);
      if (toIso) q = q.lt('start_at', toIso);
      if (brand) q = q.eq('brand_key', brand);
      if (resourceId) q = q.eq('resource_id', resourceId);
      if (eventTypeId) q = q.eq('event_type_id', eventTypeId);
      if (statuses?.length) q = q.in('status', statuses);
      if (unassigned) q = q.is('resource_id', null);
      return many(q.order('start_at').limit(limit), 'appointment_read_failed');
    },

    // --- calendar connections -------------------------------------------------
    getConnectionByResource: (rid) => one(db().from('scheduling_calendar_connections').select('*').eq('resource_id', rid).eq('provider', 'google'), 'connection_read_failed'),
    getConnection: (id) => one(db().from('scheduling_calendar_connections').select('*').eq('id', id), 'connection_read_failed'),
    getConnectionByChannel: (channelId) => one(db().from('scheduling_calendar_connections').select('*').eq('watch_channel_id', channelId), 'connection_read_failed'),
    listConnections: () => many(db().from('scheduling_calendar_connections').select('*'), 'connection_read_failed'),
    async upsertConnection(row) {
      const { data, error } = await db().from('scheduling_calendar_connections').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'resource_id,provider' }).select('*').single();
      if (error) throw mapPgError(error, 'connection_write_failed');
      return data;
    },
    async updateConnection(id, patch) {
      const { error } = await db().from('scheduling_calendar_connections').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw mapPgError(error, 'connection_write_failed');
    },
    async upsertBusy(rows) {
      if (!rows.length) return;
      const { error } = await db().from('scheduling_external_busy').upsert(rows, { onConflict: 'connection_id,external_event_id' });
      if (error) throw mapPgError(error, 'busy_write_failed');
    },
    async deleteBusy(connectionId, eventIds) {
      if (!eventIds.length) return;
      const { error } = await db().from('scheduling_external_busy').delete().eq('connection_id', connectionId).in('external_event_id', eventIds);
      if (error) throw mapPgError(error, 'busy_write_failed');
    },
    async clearBusy(connectionId) {
      const { error } = await db().from('scheduling_external_busy').delete().eq('connection_id', connectionId);
      if (error) throw mapPgError(error, 'busy_write_failed');
    },

    // --- OAuth state ------------------------------------------------------------
    async insertOAuthState(row) {
      const { error } = await db().from('scheduling_oauth_states').insert(row);
      if (error) throw mapPgError(error, 'oauth_state_write_failed');
    },
    /** Atomically consumes a state: a replayed or expired state returns null. */
    async consumeOAuthState(stateHash, nowIso) {
      const { data, error } = await db().from('scheduling_oauth_states').update({ consumed_at: nowIso }).eq('state_hash', stateHash).is('consumed_at', null).gt('expires_at', nowIso).select('*').maybeSingle();
      if (error) throw mapPgError(error, 'oauth_state_read_failed');
      return data ?? null;
    },
    async pruneOAuthStates(beforeIso) {
      await db().from('scheduling_oauth_states').delete().lt('expires_at', beforeIso);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory twin
// ---------------------------------------------------------------------------
export function createInMemorySchedulingStore(seed = {}) {
  const s = {
    eventTypes: [], resources: [], timeOff: [], pools: [], poolMembers: [], appointments: [], events: [],
    connections: [], externalBusy: [], oauthStates: [],
    ...structuredClone(seed),
  };
  const uuid = () => globalThis.crypto.randomUUID();
  const overlaps = (a, b) => Date.parse(a.block_start_at) < Date.parse(b.block_end_at) && Date.parse(b.block_start_at) < Date.parse(a.block_end_at);
  const live = (a) => LIVE.includes(a.status) && a.resource_id;
  /** The exclusion constraint, applied atomically (no await between check and write). */
  function assertNoOverlap(row, ignoreId) {
    if (!live(row)) return;
    if (s.appointments.some((a) => a.id !== ignoreId && live(a) && a.resource_id === row.resource_id && overlaps(a, row))) throw new SchedulingStoreError('slot_conflict');
  }
  const tick = () => new Promise((r) => setImmediate(r)); // let concurrent callers interleave like I/O would

  return {
    kind: 'memory',
    state: s,
    getEventType: async (brand, key) => s.eventTypes.find((t) => t.brand_key === brand && t.type_key === key && t.active !== false) ?? null,
    getEventTypeById: async (id) => s.eventTypes.find((t) => t.id === id) ?? null,
    listEventTypes: async (brand) => s.eventTypes.filter((t) => t.brand_key === brand && t.active !== false),
    listResources: async (ids) => s.resources.filter((r) => ids.includes(r.id) && r.active !== false),
    listAllResources: async () => s.resources,
    getResource: async (id) => s.resources.find((r) => r.id === id) ?? null,
    findResourceByOpsUser: async (uid) => s.resources.find((r) => r.ops_user_id === uid) ?? null,
    findResourceByOperatorKey: async (key) => {
      const rows = s.resources.filter((r) => r.active !== false && (r.operator_keys || []).includes(key));
      return rows.length === 1 ? rows[0] : null;
    },
    poolMembers: async (brand, keys) => {
      const out = {};
      for (const p of s.pools.filter((x) => x.brand_key === brand && keys.includes(x.pool_key))) {
        out[p.pool_key] = s.poolMembers.filter((m) => m.pool_id === p.id && m.active !== false && s.resources.find((r) => r.id === m.resource_id)?.active !== false).map((m) => m.resource_id);
      }
      return out;
    },
    hasPermission: async (uid, perm) => (s.permissions || []).some((p) => p.user_id === uid && p.permission === perm),
    async updateEventType(id, patch) { const t = s.eventTypes.find((x) => x.id === id); if (!t) return null; Object.assign(t, patch); return t; },
    listAllEventTypes: async () => s.eventTypes,
    async upsertResource(row) {
      const existing = s.resources.find((r) => (row.id && r.id === row.id) || (row.ops_user_id && r.ops_user_id === row.ops_user_id));
      if (existing) { Object.assign(existing, row); return existing; }
      const created = { id: uuid(), active: true, operator_keys: [], weekly_hours: {}, ...row };
      s.resources.push(created);
      return created;
    },
    async setPoolMember({ brand, poolKey, poolName, resourceId, active }) {
      let pool = s.pools.find((p) => p.brand_key === brand && p.pool_key === poolKey);
      if (!pool) { pool = { id: uuid(), brand_key: brand, pool_key: poolKey, name: poolName || poolKey }; s.pools.push(pool); }
      const m = s.poolMembers.find((x) => x.pool_id === pool.id && x.resource_id === resourceId);
      if (m) m.active = active; else s.poolMembers.push({ pool_id: pool.id, resource_id: resourceId, active });
    },
    listPools: async () => s.pools.map((p) => ({ ...p, members: s.poolMembers.filter((m) => m.pool_id === p.id) })),
    async insertTimeOff(row) { const r = { id: uuid(), ...row }; s.timeOff.push(r); return r; },
    busyFor: async (ids, fromIso, toIso, { excludeAppointmentId } = {}) => {
      await tick();
      const within = (a, b) => Date.parse(a) < Date.parse(toIso) && Date.parse(b) > Date.parse(fromIso);
      const out = Object.fromEntries(ids.map((id) => [id, []]));
      for (const a of s.appointments) if (a.id !== excludeAppointmentId && live(a) && out[a.resource_id] && within(a.block_start_at, a.block_end_at)) out[a.resource_id].push({ start: a.block_start_at, end: a.block_end_at });
      for (const b of [...s.timeOff, ...s.externalBusy]) if (out[b.resource_id] && within(b.start_at, b.end_at)) out[b.resource_id].push({ start: b.start_at, end: b.end_at });
      return out;
    },
    resourceStats: async (ids, nowIso) => {
      const out = Object.fromEntries(ids.map((id) => [id, { lastAssignedAt: null, upcoming: 0 }]));
      for (const a of s.appointments) {
        if (!out[a.resource_id]) continue;
        const c = Date.parse(a.created_at);
        if (out[a.resource_id].lastAssignedAt == null || c > out[a.resource_id].lastAssignedAt) out[a.resource_id].lastAssignedAt = c;
        if (LIVE.includes(a.status) && a.start_at >= nowIso) out[a.resource_id].upcoming += 1;
      }
      return out;
    },
    async insertAppointment(row) {
      await tick();
      if (row.idempotency_key && s.appointments.some((a) => a.idempotency_key === row.idempotency_key)) throw new SchedulingStoreError('duplicate');
      const created = { id: uuid(), status: 'scheduled', version: 1, sync_status: 'pending', customer: {}, related_refs: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
      assertNoOverlap(created);
      s.appointments.push(created);
      return { ...created };
    },
    getAppointment: async (id) => { const a = s.appointments.find((x) => x.id === id); return a ? { ...a } : null; },
    getAppointmentByIdempotencyKey: async (k) => { const a = s.appointments.find((x) => x.idempotency_key === k); return a ? { ...a } : null; },
    async updateAppointment(id, patch, where = {}) {
      await tick();
      const a = s.appointments.find((x) => x.id === id);
      if (!a) return null;
      if (where.statusIn && !where.statusIn.includes(a.status)) return null;
      if (where.version != null && a.version !== where.version) return null;
      const next = { ...a, ...patch, updated_at: new Date().toISOString() };
      assertNoOverlap(next, id);
      Object.assign(a, next);
      return { ...a };
    },
    async rescheduleAppointment(id, expectedVersion, next, actor) {
      await tick();
      const old = s.appointments.find((x) => x.id === id);
      if (!old) throw new SchedulingStoreError('not_found');
      if (!LIVE.includes(old.status)) throw new SchedulingStoreError('appointment_not_active');
      if (expectedVersion != null && old.version !== expectedVersion) throw new SchedulingStoreError('version_conflict');
      const resourceId = next.resource_id ?? old.resource_id;
      const created = {
        ...old, id: uuid(), status: 'scheduled', version: 1, resource_id: resourceId,
        start_at: next.start_at, end_at: next.end_at, block_start_at: next.block_start_at, block_end_at: next.block_end_at,
        customer_timezone: next.customer_timezone ?? old.customer_timezone, routed_via: next.routed_via ?? old.routed_via,
        rescheduled_from_id: old.id, rescheduled_to_id: null, idempotency_key: null,
        google_event_id: resourceId === old.resource_id ? old.google_event_id : null,
        google_calendar_id: resourceId === old.resource_id ? old.google_calendar_id : null,
        sync_status: 'pending', created_by: actor, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      assertNoOverlap(created, old.id); // old row is released in the same step
      old.status = 'rescheduled'; old.version += 1; old.rescheduled_to_id = created.id;
      s.appointments.push(created);
      s.events.push({ appointment_id: old.id, brand_key: old.brand_key, event: 'rescheduled', actor, detail: { to: created.id }, created_at: new Date().toISOString() });
      s.events.push({ appointment_id: created.id, brand_key: old.brand_key, event: 'booked', actor, detail: { rescheduled_from: old.id }, created_at: new Date().toISOString() });
      return created.id;
    },
    async appendEvent(row) { s.events.push({ created_at: new Date().toISOString(), ...row }); },
    listEvents: async (id) => s.events.filter((e) => e.appointment_id === id),
    listAppointmentsByRelated: async (ref) => s.appointments.filter((a) => (a.related_refs || []).includes(ref)).sort((a, b) => a.start_at.localeCompare(b.start_at)).map((a) => ({ ...a })),
    findByGoogleEvent: async (eid) => s.appointments.find((a) => a.google_event_id === eid && LIVE.includes(a.status)) ?? null,
    listNeedingSync: async () => s.appointments.filter((a) => ['pending', 'failed'].includes(a.sync_status) && a.resource_id),
    listAppointments: async ({ fromIso, toIso, brand, resourceId, eventTypeId, statuses, unassigned } = {}) => s.appointments.filter((a) =>
      (!fromIso || a.start_at >= fromIso) && (!toIso || a.start_at < toIso) && (!brand || a.brand_key === brand) && (!resourceId || a.resource_id === resourceId)
      && (!eventTypeId || a.event_type_id === eventTypeId) && (!statuses?.length || statuses.includes(a.status)) && (!unassigned || !a.resource_id)).sort((a, b) => a.start_at.localeCompare(b.start_at)),
    getConnectionByResource: async (rid) => s.connections.find((c) => c.resource_id === rid) ?? null,
    getConnection: async (id) => s.connections.find((c) => c.id === id) ?? null,
    getConnectionByChannel: async (ch) => s.connections.find((c) => c.watch_channel_id === ch) ?? null,
    listConnections: async () => s.connections,
    async upsertConnection(row) {
      const existing = s.connections.find((c) => c.resource_id === row.resource_id);
      if (existing) { Object.assign(existing, row); return existing; }
      const created = { id: uuid(), calendar_id: 'primary', status: 'connected', ...row };
      s.connections.push(created);
      return created;
    },
    async updateConnection(id, patch) { Object.assign(s.connections.find((c) => c.id === id) ?? {}, patch); },
    async upsertBusy(rows) {
      for (const r of rows) {
        const i = s.externalBusy.findIndex((b) => b.connection_id === r.connection_id && b.external_event_id === r.external_event_id);
        if (i >= 0) s.externalBusy[i] = r; else s.externalBusy.push(r);
      }
    },
    async deleteBusy(cid, ids) { s.externalBusy = s.externalBusy.filter((b) => !(b.connection_id === cid && ids.includes(b.external_event_id))); },
    async clearBusy(cid) { s.externalBusy = s.externalBusy.filter((b) => b.connection_id !== cid); },
    async insertOAuthState(row) { s.oauthStates.push({ ...row }); },
    async consumeOAuthState(hash, nowIso) {
      const r = s.oauthStates.find((x) => x.state_hash === hash && !x.consumed_at && x.expires_at > nowIso);
      if (!r) return null;
      r.consumed_at = nowIso;
      return { ...r };
    },
    async pruneOAuthStates(before) { s.oauthStates = s.oauthStates.filter((x) => x.expires_at >= before); },
  };
}
