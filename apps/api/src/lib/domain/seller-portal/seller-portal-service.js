/**
 * Seller portal — service.
 *
 * AUTHORIZATION MODEL. A seller holds an opaque session token issued here.
 * The token resolves to a seller_portal_identities row, the identity to its
 * active seller_portal_grants, and every read or write first proves the
 * requested opportunity is one of those grants. Callers (the Prominent site)
 * never decide access and are never trusted with an opportunity id: an id that
 * is not granted is indistinguishable from one that does not exist.
 *
 * ACCOUNT CLAIM. Sellers are never asked to recreate their property. An email
 * address claims the opportunities created by accepted Prominent intake
 * submissions carrying that same email; operators can grant more. Sign-in
 * responses are identical whether or not the email is known.
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { SchedulingError } from '@/lib/domain/scheduling/scheduling-service.js';
import { createDefaultSchedulingService } from '@/lib/domain/scheduling/scheduling-runtime.js';
import { isValidTimeZone } from '@/lib/domain/scheduling/scheduling-time.js';
import { PROMINENT_BRAND, REASON_TO_TYPE } from './prominent-scheduling-adapter.js';
import { emitSellerLifecycle } from './seller-portal-lifecycle.js';

import {
  CALL_REASONS,
  SELLER_PORTAL_CODE_LENGTH,
  SELLER_PORTAL_CODE_MAX_ATTEMPTS,
  SELLER_PORTAL_CODE_TTL_MINUTES,
  SELLER_PORTAL_MESSAGE_MAX,
  SELLER_PORTAL_SESSION_TTL_DAYS,
  SELLER_PORTAL_SIGNED_URL_SECONDS,
  SELLER_STATES,
  buildTimeline,
  deriveSellerState,
  nextAction,
  projectClosing,
  projectMilestones,
  projectOffer,
} from './seller-portal-contracts.js';

const clean = (v) => String(v ?? '').trim();
const MIN = 60_000;

export class SellerPortalError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : null;
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function pepper(env) {
  const value = clean(env.SELLER_PORTAL_CODE_PEPPER);
  if (!value && clean(env.NODE_ENV) === 'production') throw new SellerPortalError('seller_portal_unconfigured', 503);
  return value || 'seller-portal-development-pepper';
}

const hashCode = (code, identityId, env) => createHash('sha256').update(`${pepper(env)}:${identityId}:${code}`).digest('hex');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(clean(a), 'hex');
  const y = Buffer.from(clean(b), 'hex');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

// Sign-in limits. Address limits apply whether or not the address has an
// account, so they reveal nothing.
export const SIGN_IN_LIMITS = Object.freeze({
  windowMinutes: 15,
  startsPerIp: 20,
  startsPerAddress: 5,
  verifiesPerIp: 30,
  maxActiveSessions: 5,
  idleTimeoutDays: 14,
});

const keyed = (env, value) => createHmac('sha256', pepper(env)).update(String(value)).digest('hex');

function context(deps = {}) {
  const env = deps.env ?? process.env;
  return {
    store: deps.store,
    env,
    now: () => (deps.now ? new Date(deps.now()) : new Date()),
    notify: deps.notify ?? (async () => ({ sent: false, reason: 'notifier_not_wired' })),
    scheduling: deps.scheduling ?? null,
    lifecycle: deps.sellerLifecycle ?? ((event) => emitSellerLifecycle(event, { env, store: deps.store, notify: deps.notify })),
  };
}

/** The shared scheduling core, with Prominent registered as a client brand. */
function scheduling(ctx, deps) {
  if (!ctx.scheduling) ctx.scheduling = createDefaultSchedulingService({ env: ctx.env, now: deps.now });
  return ctx.scheduling;
}

async function audit(ctx, event, { identityId = null, ipHash = null, detail = {} } = {}) {
  try {
    await ctx.store.audit({ identity_id: identityId, event, ip_hash: ipHash, detail });
  } catch {
    // Audit is best effort; it never blocks sign-in.
  }
}

async function overLimit(ctx, bucket, key, limit) {
  const since = new Date(ctx.now().getTime() - SIGN_IN_LIMITS.windowMinutes * MIN).toISOString();
  return (await ctx.store.countThrottle(bucket, key, since)) >= limit;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** Find or create the identity for an email, refreshing grants from intake. */
async function resolveIdentityForEmail(ctx, email) {
  const claims = await ctx.store.findIntakeClaims(email);
  let identity = await ctx.store.findIdentityByEmail(email);
  if (!identity && claims.length) {
    const first = claims[0];
    identity = await ctx.store.createIdentity({ email, display_name: clean(first.seller_display_name) || null, phone_e164: normalizePhone(first.seller_phone) });
  }
  if (!identity) return null;
  for (const claim of claims) {
    await ctx.store.createGrant({ identity_id: identity.id, opportunity_id: claim.lead_id, granted_via: 'intake_email_match', source_submission_id: claim.id });
  }
  return identity;
}

/**
 * Always resolves to the same response so it cannot be used to discover who
 * has an account. A code is only created and sent when the email holds at
 * least one active grant.
 */
/**
 * Known and unknown addresses must also take the same time: a known one stores
 * a code and sends an email. Responses are held to a floor (production default
 * 900 ms, configurable; 0 in tests) so timing reveals nothing.
 */
async function constantTime(ctx, started, fn) {
  const configured = clean(ctx.env.SELLER_PORTAL_SIGNIN_MIN_MS) === '' ? NaN : Number(ctx.env.SELLER_PORTAL_SIGNIN_MIN_MS);
  const floor = Number.isFinite(configured) && configured >= 0 ? configured : clean(ctx.env.NODE_ENV) === 'production' ? 900 : 0;
  try {
    return await fn();
  } finally {
    const wait = floor - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

export async function startSignIn(input = {}, deps = {}) {
  const ctx = context(deps);
  return constantTime(ctx, Date.now(), () => startSignInNow(input, deps, ctx));
}

async function startSignInNow({ email: raw, ip } = {}, deps, ctx) {
  const email = normalizeEmail(raw);
  const generic = { ok: true, status: 'code_sent_if_eligible' };
  if (!email) throw new SellerPortalError('invalid_email', 422);
  const ipHash = clean(ip) ? keyed(ctx.env, `ip:${clean(ip)}`) : null;
  const addressHash = keyed(ctx.env, `email:${email}`);

  // Throttle by network and by address before any lookup; the response is
  // identical either way.
  if ((ipHash && await overLimit(ctx, 'sign_in_ip', ipHash, SIGN_IN_LIMITS.startsPerIp)) || await overLimit(ctx, 'sign_in_address', addressHash, SIGN_IN_LIMITS.startsPerAddress)) {
    await audit(ctx, 'sign_in_throttled', { ipHash });
    return generic;
  }
  const stamp = ctx.now().toISOString();
  if (ipHash) await ctx.store.recordThrottle('sign_in_ip', ipHash, stamp);
  await ctx.store.recordThrottle('sign_in_address', addressHash, stamp);

  const identity = await resolveIdentityForEmail(ctx, email);
  if (!identity || identity.status !== 'active') return generic;
  const grants = await ctx.store.listGrants(identity.id);
  if (!grants.length) return generic;

  const now = ctx.now();
  const code = String(randomInt(0, 10 ** SELLER_PORTAL_CODE_LENGTH)).padStart(SELLER_PORTAL_CODE_LENGTH, '0');
  await ctx.store.insertCode({ identity_id: identity.id, code_hash: hashCode(code, identity.id, ctx.env), expires_at: new Date(now.getTime() + SELLER_PORTAL_CODE_TTL_MINUTES * MIN).toISOString() });
  await audit(ctx, 'sign_in_code_issued', { identityId: identity.id, ipHash });
  await ctx.notify({ kind: 'sign_in_code', to: email, context: { code, minutes: SELLER_PORTAL_CODE_TTL_MINUTES, name: identity.display_name } });
  // Development and tests only: the code is never echoed in production.
  if (deps.echoCode && clean(ctx.env.NODE_ENV) !== 'production') return { ...generic, dev_code: code };
  return generic;
}

export async function verifySignIn({ email: raw, code: rawCode, ip } = {}, deps = {}) {
  const ctx = context(deps);
  const email = normalizeEmail(raw);
  const code = clean(rawCode).replace(/\s/g, '');
  const invalid = new SellerPortalError('invalid_or_expired_code', 401);
  const ipHash = clean(ip) ? keyed(ctx.env, `ip:${clean(ip)}`) : null;
  if (ipHash) {
    if (await overLimit(ctx, 'verify_ip', ipHash, SIGN_IN_LIMITS.verifiesPerIp)) {
      await audit(ctx, 'verify_throttled', { ipHash });
      throw new SellerPortalError('too_many_attempts', 429);
    }
    await ctx.store.recordThrottle('verify_ip', ipHash, ctx.now().toISOString());
  }
  if (!email || !/^\d{6}$/.test(code)) throw invalid;
  const identity = await ctx.store.findIdentityByEmail(email);
  if (!identity || identity.status !== 'active') throw invalid;
  const now = ctx.now();
  const open = await ctx.store.latestOpenCode(identity.id, now.toISOString());
  if (!open || open.attempts >= SELLER_PORTAL_CODE_MAX_ATTEMPTS) throw invalid;
  if (!safeEqualHex(open.code_hash, hashCode(code, identity.id, ctx.env))) {
    await ctx.store.incrementCodeAttempts(open.id, open.attempts ?? 0);
    await audit(ctx, 'sign_in_failed', { identityId: identity.id, ipHash });
    throw invalid;
  }
  // Single use, even under concurrent submission: only the request that flips
  // consumed_at from null gets a session.
  if (!(await ctx.store.consumeCode(open.id, now.toISOString()))) throw invalid;
  await ctx.store.consumeOpenCodes(identity.id, now.toISOString());

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SELLER_PORTAL_SESSION_TTL_DAYS * 24 * 60 * MIN);
  await ctx.store.insertSession({ identity_id: identity.id, token_hash: hashToken(token), created_at: now.toISOString(), expires_at: expires.toISOString(), last_seen_at: now.toISOString(), ip_hash: ipHash });
  // Concurrent-session policy: the newest N stay signed in.
  const active = await ctx.store.listActiveSessions(identity.id, now.toISOString());
  const surplus = active.slice(SIGN_IN_LIMITS.maxActiveSessions).map((x) => x.id);
  if (surplus.length) await ctx.store.revokeSessions(surplus, 'session_limit', now.toISOString());
  await ctx.store.touchSignIn(identity.id, now.toISOString());
  await audit(ctx, 'sign_in_succeeded', { identityId: identity.id, ipHash });
  return { ok: true, session_token: token, expires_at: expires.toISOString() };
}

/** Resolves a session token to { identity, grants } or throws unauthorized. */
export async function resolveSession(token, deps = {}) {
  const ctx = context(deps);
  const unauthorized = new SellerPortalError('unauthorized', 401);
  const raw = clean(token);
  if (raw.length < 32) throw unauthorized;
  const session = await ctx.store.findSession(hashToken(raw));
  const now = ctx.now();
  if (!session || session.revoked_at || new Date(session.expires_at) <= now) throw unauthorized;
  const lastSeen = new Date(session.last_seen_at || session.created_at);
  if (now - lastSeen > SIGN_IN_LIMITS.idleTimeoutDays * 24 * 60 * MIN) {
    await ctx.store.updateSession(session.id, { revoked_at: now.toISOString(), revoked_reason: 'idle_timeout' });
    throw unauthorized;
  }
  const identity = await ctx.store.findIdentityById(session.identity_id);
  if (!identity || identity.status !== 'active') throw unauthorized;
  const grants = await ctx.store.listGrants(identity.id);
  if (now - lastSeen > 5 * MIN) await ctx.store.updateSession(session.id, { last_seen_at: now.toISOString() });
  return { session, identity, grants };
}

export async function signOut(token, deps = {}) {
  const ctx = context(deps);
  const session = await ctx.store.findSession(hashToken(clean(token)));
  if (session && !session.revoked_at) {
    await ctx.store.updateSession(session.id, { revoked_at: ctx.now().toISOString(), revoked_reason: 'sign_out' });
    await audit(ctx, 'signed_out', { identityId: session.identity_id });
  }
  return { ok: true };
}

/** Signs the seller out on every device. */
export async function signOutEverywhere(token, deps = {}) {
  const ctx = context(deps);
  const auth = await resolveSession(token, deps);
  await ctx.store.revokeAllSessions(auth.identity.id, 'sign_out_everywhere', ctx.now().toISOString());
  await audit(ctx, 'signed_out_everywhere', { identityId: auth.identity.id });
  return { ok: true };
}

/** The single authorization gate for opportunity-scoped work. */
function authorizedOpportunityId(auth, requested) {
  const ids = auth.grants.map((g) => g.opportunity_id);
  if (!ids.length) throw new SellerPortalError('no_linked_property', 404);
  if (!requested) return ids[0];
  if (!ids.includes(clean(requested))) throw new SellerPortalError('not_found', 404);
  return clean(requested);
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

function operatorDirectory(env) {
  try {
    return JSON.parse(clean(env.SELLER_PORTAL_OPERATOR_DIRECTORY) || '{}');
  } catch {
    return {};
  }
}

async function addressFor(ctx, opportunity) {
  if (clean(opportunity.property_address_full)) return clean(opportunity.property_address_full);
  const intake = await ctx.store.getIntakeSubmission(opportunity.source_submission_id);
  return clean(intake?.property_address) || null;
}

export async function getPortalState({ token, opportunityId } = {}, deps = {}) {
  const ctx = context(deps);
  const auth = await resolveSession(token, deps);
  const oppId = authorizedOpportunityId(auth, opportunityId);
  const opportunity = await ctx.store.getOpportunity(oppId);
  if (!opportunity) throw new SellerPortalError('not_found', 404);
  const now = ctx.now();

  const [offers, evaluations, closing, appointments, messages, shares] = await Promise.all([
    ctx.store.listOffers(oppId),
    ctx.store.listEvaluations(oppId),
    ctx.store.getClosingCase(oppId),
    scheduling(ctx, deps).store.listAppointmentsByRelated(`opportunity:${oppId}`),
    ctx.store.listMessages(oppId),
    ctx.store.listShares(oppId),
  ]);
  const [milestones, titleIssues] = closing
    ? await Promise.all([ctx.store.listMilestones(closing.closing_case_id), ctx.store.listTitleIssues(closing.closing_case_id)])
    : [[], []];

  const state = deriveSellerState({ opportunity, offers, evaluations, closing, now });
  const properties = await Promise.all(auth.grants.map(async (g) => {
    const o = g.opportunity_id === oppId ? opportunity : await ctx.store.getOpportunity(g.opportunity_id);
    return o ? { opportunity_id: o.id, address: await addressFor(ctx, o) } : null;
  }));
  const directory = operatorDirectory(ctx.env);
  const contact = directory[clean(opportunity.assigned_operator)];

  return {
    ok: true,
    seller: { display_name: auth.identity.display_name || null, email: auth.identity.email },
    properties: properties.filter(Boolean),
    property: { opportunity_id: oppId, address: await addressFor(ctx, opportunity) },
    state,
    state_copy: SELLER_STATES[state],
    next_action: nextAction({ state, closing, titleIssues }),
    offer: projectOffer({ offers, evaluations, closing, now }),
    timeline: buildTimeline({ opportunity, offers, closing, titleIssues, state }),
    closing: projectClosing(closing),
    milestones: projectMilestones(milestones),
    calls: appointments.filter((c) => ['scheduled', 'confirmed'].includes(c.status) && new Date(c.end_at) > now).map((c) => ({ id: c.id, start_at: c.start_at, end_at: c.end_at, timezone: c.customer_timezone, reason: CALL_REASONS[c.reason_key] || 'A call', reason_key: c.reason_key, status: c.status, version: c.version })),
    contact: contact ? { name: clean(contact.name), title: clean(contact.title) || null } : null,
    messages: { count: messages.length, last_at: messages.at(-1)?.created_at ?? null },
    documents: shares.map((d) => ({ id: d.id, label: d.label, kind: d.document_kind, status: d.seller_status, shared_at: d.shared_at, filename: d.attachment?.filename ?? null, content_type: d.attachment?.content_type ?? null, size_bytes: d.attachment?.size_bytes ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Messages — the conversation about this property
// ---------------------------------------------------------------------------

export async function listSellerMessages({ token, opportunityId } = {}, deps = {}) {
  const ctx = context(deps);
  const auth = await resolveSession(token, deps);
  const oppId = authorizedOpportunityId(auth, opportunityId);
  const messages = await ctx.store.listMessages(oppId);
  await ctx.store.markRead(oppId, 'seller_read_at', ctx.now().toISOString());
  return { ok: true, opportunity_id: oppId, messages: messages.map((m) => ({ id: m.id, author: m.author_kind, body: m.body, created_at: m.created_at })) };
}

export async function sendSellerMessage({ token, opportunityId, body, idempotencyKey } = {}, deps = {}) {
  const ctx = context(deps);
  const auth = await resolveSession(token, deps);
  const oppId = authorizedOpportunityId(auth, opportunityId);
  const text = clean(body);
  if (!text || text.length > SELLER_PORTAL_MESSAGE_MAX) throw new SellerPortalError('invalid_message', 422);
  const opportunity = await ctx.store.getOpportunity(oppId);
  const now = ctx.now().toISOString();
  const message = await ctx.store.insertMessage({ opportunity_id: oppId, author_kind: 'seller', author_identity_id: auth.identity.id, body: text, idempotency_key: clean(idempotencyKey) || null });
  await ctx.store.appendHistory({ opportunity_id: oppId, event_type: 'seller_portal_message_received', actor: 'seller', source: 'seller_portal', created_at: now, metadata: { message_id: message.id } });
  await ctx.store.flagInbox(opportunity?.primary_thread_key, now, `Portal message: ${text.slice(0, 140)}`);
  return { ok: true, message: { id: message.id, author: 'seller', body: message.body, created_at: message.created_at } };
}

/** Operations' reply, through the cockpit; the seller is told by email. */
export async function operatorReply({ opportunityId, operator, body } = {}, deps = {}) {
  const ctx = context(deps);
  const text = clean(body);
  if (!text || text.length > SELLER_PORTAL_MESSAGE_MAX || !clean(operator)) throw new SellerPortalError('invalid_message', 422);
  const opportunity = await ctx.store.getOpportunity(clean(opportunityId));
  if (!opportunity) throw new SellerPortalError('not_found', 404);
  const message = await ctx.store.insertMessage({ opportunity_id: opportunity.id, author_kind: 'operator', author_operator: clean(operator), body: text });
  await ctx.store.markRead(opportunity.id, 'operator_read_at', ctx.now().toISOString());
  await ctx.store.appendHistory({ opportunity_id: opportunity.id, event_type: 'seller_portal_message_sent', actor: clean(operator), source: 'cockpit', created_at: ctx.now().toISOString(), metadata: { message_id: message.id } });
  await ctx.lifecycle({ kind: 'message', opportunityId: opportunity.id, dedupeKey: `message:${message.id}` });
  return { ok: true, message };
}

export async function listOperatorMessages({ opportunityId } = {}, deps = {}) {
  const ctx = context(deps);
  return { ok: true, messages: await ctx.store.listMessages(clean(opportunityId)) };
}

// ---------------------------------------------------------------------------
// Calls — the seller schedules, Prominent calls
// ---------------------------------------------------------------------------

/**
 * Calls are appointments in the shared scheduling core. Prominent supplies the
 * context (seller, opportunity, closing case, reason → appointment type); the
 * core supplies availability across every brand, routing, the atomic booking,
 * Google Calendar and reminders. Availability exists only for people who are
 * configured as scheduling resources; with none, there is honestly none.
 */

const callType = (reasonKey) => REASON_TO_TYPE[reasonKey] || 'property_conversation';

async function sellerContext(ctx, deps, token, opportunityId) {
  const auth = await resolveSession(token, deps);
  const opportunity = await ctx.store.getOpportunity(authorizedOpportunityId(auth, opportunityId));
  if (!opportunity) throw new SellerPortalError('not_found', 404);
  const closing = await ctx.store.getClosingCase(opportunity.id);
  const refs = [`opportunity:${opportunity.id}`, closing?.closing_case_id ? `closing_case:${closing.closing_case_id}` : null].filter(Boolean);
  return { auth, opportunity, refs };
}

function mapSchedulingError(error) {
  if (error instanceof SchedulingError) {
    const mapped = new SellerPortalError(error.code, error.status);
    if (error.slots) mapped.slots = error.slots;
    return mapped;
  }
  return error;
}

export async function listCallSlots({ token, opportunityId, reason, from, to, timezone } = {}, deps = {}) {
  const ctx = context(deps);
  const reasonKey = CALL_REASONS[clean(reason)] ? clean(reason) : 'property';
  const refs = token ? (await sellerContext(ctx, deps, token, opportunityId)).refs : [];
  try {
    const result = await scheduling(ctx, deps).getAvailability({ brand: PROMINENT_BRAND, typeKey: callType(reasonKey), refs, from, to, timezone: isValidTimeZone(timezone) ? timezone : undefined });
    return { ok: true, available: result.slots.length > 0, reason: result.slots.length ? null : 'no_availability', duration_minutes: result.event_type.duration_minutes, slots: result.slots };
  } catch (error) {
    if (error instanceof SchedulingError && error.code === 'event_type_not_found') return { ok: true, available: false, reason: 'scheduling_not_configured', slots: [] };
    throw mapSchedulingError(error);
  }
}

/**
 * Books a call. Signed in: identity, phone, property and opportunity come from
 * the session; nothing is asked again. Public: name plus phone (email
 * optional); the booking is linked to an opportunity only when the email
 * deterministically matches exactly one accepted Prominent intake.
 */
export async function bookCall({ token, opportunityId, reason, startAt, contact = {}, note, timezone, idempotencyKey } = {}, deps = {}) {
  const ctx = context(deps);
  const reasonKey = clean(reason);
  if (!CALL_REASONS[reasonKey]) throw new SellerPortalError('invalid_reason', 422);
  let refs = [];
  let customer;
  let source;
  if (token) {
    const seller = await sellerContext(ctx, deps, token, opportunityId);
    refs = seller.refs;
    customer = { name: seller.auth.identity.display_name, email: seller.auth.identity.email, phone: seller.auth.identity.phone_e164 };
    source = 'prominent_portal';
  } else {
    customer = { name: clean(contact.name), phone: normalizePhone(contact.phone), email: normalizeEmail(contact.email) };
    if (!customer.name || !customer.phone) throw new SellerPortalError('invalid_contact', 422);
    if (customer.email) {
      const claims = await ctx.store.findIntakeClaims(customer.email);
      const ids = [...new Set(claims.map((c) => c.lead_id))];
      if (ids.length === 1) refs = [`opportunity:${ids[0]}`];
    }
    source = 'prominent_public';
  }
  try {
    const { appointment } = await scheduling(ctx, deps).bookAppointment({
      brand: PROMINENT_BRAND, typeKey: callType(reasonKey), startAt, refs, customer,
      customerTimezone: isValidTimeZone(timezone) ? timezone : null, source, reasonKey,
      note: [clean(note), !token && clean(contact.address) ? `Property: ${clean(contact.address)}` : ''].filter(Boolean).join('\n'),
      idempotencyKey: clean(idempotencyKey) || null, actor: source,
    });
    return { ok: true, call: { id: appointment.id, start_at: appointment.start_at, end_at: appointment.end_at, timezone: appointment.timezone, reason: CALL_REASONS[reasonKey], status: appointment.status, version: appointment.version }, linked: refs.length > 0 };
  } catch (error) {
    throw mapSchedulingError(error);
  }
}

/** Only calls about the seller's own granted opportunities can be changed. */
async function ownCall(ctx, deps, token, appointmentId) {
  const auth = await resolveSession(token, deps);
  const granted = new Set(auth.grants.map((g) => `opportunity:${g.opportunity_id}`));
  return { auth, authorize: async (appt) => appt.brand_key === PROMINENT_BRAND && (appt.related_refs || []).some((r) => granted.has(r)) };
}

export async function rescheduleCall({ token, appointmentId, startAt, version } = {}, deps = {}) {
  const ctx = context(deps);
  const { authorize } = await ownCall(ctx, deps, token, appointmentId);
  try {
    const { appointment } = await scheduling(ctx, deps).rescheduleAppointment({ appointmentId, startAt, expectedVersion: version ?? undefined, actor: 'seller', authorize });
    return { ok: true, call: { id: appointment.id, start_at: appointment.start_at, end_at: appointment.end_at, timezone: appointment.timezone, reason: CALL_REASONS[appointment.reason_key] || 'A call', status: appointment.status, version: appointment.version } };
  } catch (error) {
    throw mapSchedulingError(error);
  }
}

export async function cancelCall({ token, appointmentId } = {}, deps = {}) {
  const ctx = context(deps);
  const { authorize } = await ownCall(ctx, deps, token, appointmentId);
  try {
    await scheduling(ctx, deps).cancelAppointment({ appointmentId, actor: 'seller', reason: 'cancelled_by_seller', authorize });
    return { ok: true };
  } catch (error) {
    throw mapSchedulingError(error);
  }
}

// ---------------------------------------------------------------------------
// Documents — only what an operator explicitly shared
// ---------------------------------------------------------------------------

export async function documentLink({ token, opportunityId, documentId } = {}, deps = {}) {
  const ctx = context(deps);
  const auth = await resolveSession(token, deps);
  const oppId = authorizedOpportunityId(auth, opportunityId);
  // The share must belong to THIS granted opportunity and be unrevoked; an id
  // from another seller's property is indistinguishable from a missing one.
  const share = await ctx.store.getShare(oppId, clean(documentId));
  if (!share?.attachment?.storage_bucket || !share.attachment.storage_path) throw new SellerPortalError('not_found', 404);
  const filename = clean(share.attachment.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'document';
  // Signed for minutes, served as a download with the stored content type.
  const url = await ctx.store.signedUrl(share.attachment.storage_bucket, share.attachment.storage_path, SELLER_PORTAL_SIGNED_URL_SECONDS, filename);
  return { ok: true, url, expires_in: SELLER_PORTAL_SIGNED_URL_SECONDS, filename };
}

/** Documents an operator may share: this opportunity's own, never buyer-side files. */
export async function listShareableDocuments({ opportunityId } = {}, deps = {}) {
  const ctx = context(deps);
  const opportunity = await ctx.store.getOpportunity(clean(opportunityId));
  if (!opportunity) throw new SellerPortalError('not_found', 404);
  const [candidates, shares] = await Promise.all([ctx.store.listShareableAttachments(opportunity.id), ctx.store.listSharesForOps(opportunity.id)]);
  return { ok: true, attachments: candidates, shares };
}

export async function shareDocument({ opportunityId, attachmentId, label, kind, operator, status = 'ready' } = {}, deps = {}) {
  const ctx = context(deps);
  if (!clean(operator) || !clean(label)) throw new SellerPortalError('invalid_share', 422);
  const opportunity = await ctx.store.getOpportunity(clean(opportunityId));
  if (!opportunity) throw new SellerPortalError('not_found', 404);
  const allowed = await ctx.store.listShareableAttachments(opportunity.id);
  if (!allowed.some((a) => a.id === clean(attachmentId))) throw new SellerPortalError('attachment_not_shareable', 422);
  const share = await ctx.store.createShare({ opportunity_id: opportunity.id, attachment_id: clean(attachmentId), label: clean(label).slice(0, 120), document_kind: clean(kind) || 'other', seller_status: status, shared_by: clean(operator), shared_at: ctx.now().toISOString(), revoked_at: null, revoked_by: null });
  await ctx.store.appendHistory({ opportunity_id: opportunity.id, event_type: 'seller_document_shared', actor: clean(operator), source: 'cockpit', created_at: ctx.now().toISOString(), metadata: { share_id: share.id, attachment_id: clean(attachmentId), kind: clean(kind) || 'other' } });
  await ctx.lifecycle({ kind: 'document_ready', opportunityId: opportunity.id, dedupeKey: `document:${share.id}:${ctx.now().toISOString()}`, context: { label: clean(label) } });
  return { ok: true, share };
}

export async function revokeDocument({ opportunityId, shareId, operator } = {}, deps = {}) {
  const ctx = context(deps);
  if (!clean(operator)) throw new SellerPortalError('invalid_share', 422);
  const revoked = await ctx.store.revokeShare(clean(opportunityId), clean(shareId), clean(operator), ctx.now().toISOString());
  if (!revoked) throw new SellerPortalError('not_found', 404);
  await ctx.store.appendHistory({ opportunity_id: clean(opportunityId), event_type: 'seller_document_revoked', actor: clean(operator), source: 'cockpit', created_at: ctx.now().toISOString(), metadata: { share_id: clean(shareId) } });
  return { ok: true };
}
