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

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

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

function context(deps = {}) {
  return {
    store: deps.store,
    env: deps.env ?? process.env,
    now: () => (deps.now ? new Date(deps.now()) : new Date()),
    notify: deps.notify ?? (async () => ({ sent: false, reason: 'notifier_not_wired' })),
  };
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
export async function startSignIn({ email: raw } = {}, deps = {}) {
  const ctx = context(deps);
  const email = normalizeEmail(raw);
  const generic = { ok: true, status: 'code_sent_if_eligible' };
  if (!email) throw new SellerPortalError('invalid_email', 422);

  const identity = await resolveIdentityForEmail(ctx, email);
  if (!identity || identity.status !== 'active') return generic;
  const grants = await ctx.store.listGrants(identity.id);
  if (!grants.length) return generic;

  const now = ctx.now();
  const recent = await ctx.store.countCodesSince(identity.id, new Date(now.getTime() - 15 * MIN).toISOString());
  if (recent >= 5) return generic; // quietly rate limited

  const code = String(randomInt(0, 10 ** SELLER_PORTAL_CODE_LENGTH)).padStart(SELLER_PORTAL_CODE_LENGTH, '0');
  await ctx.store.insertCode({ identity_id: identity.id, code_hash: hashCode(code, identity.id, ctx.env), expires_at: new Date(now.getTime() + SELLER_PORTAL_CODE_TTL_MINUTES * MIN).toISOString() });
  await ctx.notify({ kind: 'sign_in_code', to: email, context: { code, minutes: SELLER_PORTAL_CODE_TTL_MINUTES, name: identity.display_name } });
  // Development and tests only: the code is never echoed in production.
  if (deps.echoCode && clean(ctx.env.NODE_ENV) !== 'production') return { ...generic, dev_code: code };
  return generic;
}

export async function verifySignIn({ email: raw, code: rawCode } = {}, deps = {}) {
  const ctx = context(deps);
  const email = normalizeEmail(raw);
  const code = clean(rawCode).replace(/\s/g, '');
  const invalid = new SellerPortalError('invalid_or_expired_code', 401);
  if (!email || !/^\d{6}$/.test(code)) throw invalid;
  const identity = await ctx.store.findIdentityByEmail(email);
  if (!identity || identity.status !== 'active') throw invalid;
  const now = ctx.now();
  const open = await ctx.store.latestOpenCode(identity.id, now.toISOString());
  if (!open || open.attempts >= SELLER_PORTAL_CODE_MAX_ATTEMPTS) throw invalid;
  if (!safeEqualHex(open.code_hash, hashCode(code, identity.id, ctx.env))) {
    await ctx.store.updateCode(open.id, { attempts: (open.attempts ?? 0) + 1 });
    throw invalid;
  }
  await ctx.store.updateCode(open.id, { consumed_at: now.toISOString() });
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SELLER_PORTAL_SESSION_TTL_DAYS * 24 * 60 * MIN);
  await ctx.store.insertSession({ identity_id: identity.id, token_hash: hashToken(token), created_at: now.toISOString(), expires_at: expires.toISOString() });
  await ctx.store.touchSignIn(identity.id, now.toISOString());
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
  const identity = await ctx.store.findIdentityById(session.identity_id);
  if (!identity || identity.status !== 'active') throw unauthorized;
  const grants = await ctx.store.listGrants(identity.id);
  await ctx.store.updateSession(session.id, { last_seen_at: now.toISOString() });
  return { session, identity, grants };
}

export async function signOut(token, deps = {}) {
  const ctx = context(deps);
  const session = await ctx.store.findSession(hashToken(clean(token)));
  if (session && !session.revoked_at) await ctx.store.updateSession(session.id, { revoked_at: ctx.now().toISOString() });
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

  const [offers, evaluations, closing, calls, messages, shares] = await Promise.all([
    ctx.store.listOffers(oppId),
    ctx.store.listEvaluations(oppId),
    ctx.store.getClosingCase(oppId),
    ctx.store.listCalls(oppId),
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
    calls: calls.filter((c) => c.status === 'scheduled' && new Date(c.start_at) > new Date(now.getTime() - 60 * MIN)).map((c) => ({ id: c.id, start_at: c.start_at, timezone: c.timezone, reason: CALL_REASONS[c.call_reason] || 'A call', status: c.status })),
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
 * Availability comes from configuration Prominent sets, never from invented
 * staffing. SELLER_PORTAL_CALL_HOURS (JSON):
 *   { "timezone":"America/New_York", "days":[1,2,3,4,5],
 *     "times":["10:30","13:00","15:30","17:00"], "capacity_per_slot":1,
 *     "lead_minutes":120, "horizon_days":14, "duration_minutes":20 }
 */
export function callHours(env = process.env) {
  try {
    const cfg = JSON.parse(clean(env.SELLER_PORTAL_CALL_HOURS) || 'null');
    if (!cfg?.timezone || !Array.isArray(cfg.times) || !cfg.times.length) return null;
    return { days: [1, 2, 3, 4, 5], capacity_per_slot: 1, lead_minutes: 120, horizon_days: 14, duration_minutes: 20, ...cfg };
  } catch {
    return null;
  }
}

/** UTC instant for a wall-clock time on a calendar date in a time zone. */
function zonedInstant(dateStr, time, tz) {
  const [h, m] = time.split(':').map(Number);
  const guess = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asZoned = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return new Date(guess.getTime() - (asZoned - guess.getTime()));
}

export async function listCallSlots({ from } = {}, deps = {}) {
  const ctx = context(deps);
  const cfg = callHours(ctx.env);
  if (!cfg) return { ok: true, available: false, reason: 'scheduling_not_configured', slots: [] };
  const now = ctx.now();
  const earliest = new Date(now.getTime() + cfg.lead_minutes * MIN);
  const start = from ? new Date(from) : now;
  const end = new Date(now.getTime() + cfg.horizon_days * 24 * 60 * MIN);
  const booked = await ctx.store.listCallsBetween(start.toISOString(), end.toISOString());
  const taken = new Map();
  for (const b of booked) taken.set(new Date(b.start_at).toISOString(), (taken.get(new Date(b.start_at).toISOString()) ?? 0) + 1);
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone, weekday: 'short' });
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const slots = [];
  for (let d = 0; d <= cfg.horizon_days; d++) {
    const probe = new Date(start.getTime() + d * 24 * 60 * MIN);
    if (!cfg.days.includes(WD[weekday.format(probe)])) continue;
    const dateStr = dayFmt.format(probe);
    for (const time of cfg.times) {
      const at = zonedInstant(dateStr, time, cfg.timezone);
      if (at < earliest || at > end) continue;
      if ((taken.get(at.toISOString()) ?? 0) >= cfg.capacity_per_slot) continue;
      if (!slots.some((s) => s.start_at === at.toISOString())) slots.push({ start_at: at.toISOString(), date: dateStr, time });
    }
  }
  return { ok: true, available: true, timezone: cfg.timezone, slots };
}

/**
 * Books a call. Authenticated: identity and property come from the session —
 * nothing is asked again. Public (no session): name plus phone are required.
 */
export async function bookCall({ token, opportunityId, reason, startAt, contact = {}, note } = {}, deps = {}) {
  const ctx = context(deps);
  const cfg = callHours(ctx.env);
  if (!cfg) throw new SellerPortalError('scheduling_not_configured', 503);
  const reasonKey = clean(reason);
  if (!CALL_REASONS[reasonKey]) throw new SellerPortalError('invalid_reason', 422);
  const { slots } = await listCallSlots({}, deps);
  const slot = slots.find((s) => s.start_at === new Date(clean(startAt)).toISOString());
  if (!slot) throw new SellerPortalError('slot_unavailable', 409);

  let opportunity = null;
  let who;
  let source;
  if (token) {
    const auth = await resolveSession(token, deps);
    opportunity = await ctx.store.getOpportunity(authorizedOpportunityId(auth, opportunityId));
    who = { name: auth.identity.display_name, email: auth.identity.email, phone: auth.identity.phone_e164 };
    source = 'seller_portal';
  } else {
    who = { name: clean(contact.name), phone: normalizePhone(contact.phone), email: normalizeEmail(contact.email), address: clean(contact.address) || null };
    if (!who.name || !who.phone) throw new SellerPortalError('invalid_contact', 422);
    source = 'public_contact';
  }
  const start = new Date(slot.start_at);
  const call = await ctx.store.insertCall({
    event_type: 'manual_call',
    title: `Call ${who.name || 'seller'} — ${CALL_REASONS[reasonKey]}`,
    description: clean(note).slice(0, 1000) || null,
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + cfg.duration_minutes * MIN).toISOString(),
    timezone: cfg.timezone,
    status: 'scheduled',
    priority: 'high',
    opportunity_id: opportunity?.id ?? null,
    property_id: opportunity?.primary_property_id ?? null,
    master_owner_id: opportunity?.master_owner_id ?? null,
    thread_key: opportunity?.primary_thread_key ?? who.phone ?? null,
    assigned_operator: opportunity?.assigned_operator ?? null,
    call_reason: reasonKey,
    created_source: source,
    contact: token ? {} : who,
    created_by: source,
  });
  const nowIso = ctx.now().toISOString();
  if (opportunity) {
    await ctx.store.appendHistory({ opportunity_id: opportunity.id, event_type: 'seller_call_scheduled', actor: 'seller', source, created_at: nowIso, metadata: { calendar_event_id: call.id, start_at: call.start_at, reason: reasonKey } });
    await ctx.store.flagInbox(opportunity.primary_thread_key, nowIso, `Call scheduled: ${CALL_REASONS[reasonKey]}`);
  }
  if (who.email) await ctx.notify({ kind: 'call_scheduled', to: who.email, context: { start_at: call.start_at, timezone: call.timezone, reason: CALL_REASONS[reasonKey], name: who.name } });
  return { ok: true, call: { id: call.id, start_at: call.start_at, timezone: call.timezone, reason: CALL_REASONS[reasonKey], assigned: null }, linked: Boolean(opportunity) };
}

// ---------------------------------------------------------------------------
// Documents — only what an operator explicitly shared
// ---------------------------------------------------------------------------

export async function documentLink({ token, opportunityId, documentId } = {}, deps = {}) {
  const ctx = context(deps);
  const auth = await resolveSession(token, deps);
  const oppId = authorizedOpportunityId(auth, opportunityId);
  const share = await ctx.store.getShare(oppId, clean(documentId));
  if (!share?.attachment?.storage_bucket || !share.attachment.storage_path) throw new SellerPortalError('not_found', 404);
  const url = await ctx.store.signedUrl(share.attachment.storage_bucket, share.attachment.storage_path, SELLER_PORTAL_SIGNED_URL_SECONDS);
  return { ok: true, url, expires_in: SELLER_PORTAL_SIGNED_URL_SECONDS, filename: share.attachment.filename ?? null };
}

export async function shareDocument({ opportunityId, attachmentId, label, kind, operator, status = 'ready' } = {}, deps = {}) {
  const ctx = context(deps);
  if (!clean(operator) || !clean(label)) throw new SellerPortalError('invalid_share', 422);
  const share = await ctx.store.createShare({ opportunity_id: clean(opportunityId), attachment_id: clean(attachmentId), label: clean(label), document_kind: clean(kind) || 'other', seller_status: status, shared_by: clean(operator) });
  return { ok: true, share };
}
