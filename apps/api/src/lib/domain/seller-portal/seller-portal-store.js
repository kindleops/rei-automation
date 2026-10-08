/**
 * Seller portal — persistence store.
 *
 * Reads are projections of canonical tables (acquisition_opportunities,
 * seller_offers, offerr_evaluation_requests/offerr_evaluations, closing_cases,
 * closing_milestones, closing_title_issues, email_attachments,
 * external_seller_intake_submissions, email_threads). Writes touch only the
 * seller-portal tables, acquisition_opportunity_history (append), and the
 * canonical inbox "needs attention" flags so operations see seller activity
 * in the tools they already use. Calls live in the shared scheduling core.
 *
 * Every method returns plain data or throws `SellerPortalStoreError`; the
 * service maps those to stable error codes. The in-memory store implements the
 * identical interface and is the behavioural reference for tests.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

export class SellerPortalStoreError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, error) => {
  throw new SellerPortalStoreError(code, error?.message || String(error || ''));
};

export function createSupabaseSellerPortalStore(deps = {}) {
  const db = () => deps.db ?? deps.supabase ?? getDefaultSupabaseClient();

  async function one(query, code) {
    const { data, error } = await query.maybeSingle();
    if (error) fail(code, error);
    return data ?? null;
  }
  async function many(query, code) {
    const { data, error } = await query;
    if (error) fail(code, error);
    return data ?? [];
  }

  return {
    kind: 'supabase',

    // --- identity -----------------------------------------------------------
    findIdentityByEmail: (email) => one(db().from('seller_portal_identities').select('*').eq('email', email), 'identity_read_failed'),
    findIdentityById: (id) => one(db().from('seller_portal_identities').select('*').eq('id', id), 'identity_read_failed'),
    async createIdentity(row) {
      const { data, error } = await db().from('seller_portal_identities').upsert(row, { onConflict: 'email', ignoreDuplicates: false }).select('*').single();
      if (error) fail('identity_write_failed', error);
      return data;
    },
    async touchSignIn(id, at) {
      const { error } = await db().from('seller_portal_identities').update({ last_sign_in_at: at }).eq('id', id);
      if (error) fail('identity_write_failed', error);
    },
    listGrants: (identityId) => many(db().from('seller_portal_grants').select('*').eq('identity_id', identityId).is('revoked_at', null), 'grant_read_failed'),
    async createGrant(row) {
      const { error } = await db().from('seller_portal_grants').upsert(row, { onConflict: 'identity_id,opportunity_id', ignoreDuplicates: true });
      if (error) fail('grant_write_failed', error);
    },
    /** Accepted Prominent intake submissions with this email that produced an opportunity. */
    findIntakeClaims: (email) => many(
      db().from('external_seller_intake_submissions')
        .select('id, lead_id, seller_display_name, seller_phone, property_address, created_at')
        .eq('status', 'accepted').ilike('seller_email', email).not('lead_id', 'is', null),
      'intake_read_failed',
    ),

    // --- codes and sessions -------------------------------------------------
    async insertCode(row) {
      const { error } = await db().from('seller_portal_login_codes').insert(row);
      if (error) fail('code_write_failed', error);
    },
    countCodesSince: async (identityId, sinceIso) => {
      const { count, error } = await db().from('seller_portal_login_codes').select('id', { count: 'exact', head: true }).eq('identity_id', identityId).gte('created_at', sinceIso);
      if (error) fail('code_read_failed', error);
      return count ?? 0;
    },
    latestOpenCode: (identityId, nowIso) => one(
      db().from('seller_portal_login_codes').select('*').eq('identity_id', identityId).is('consumed_at', null).gt('expires_at', nowIso).order('created_at', { ascending: false }).limit(1),
      'code_read_failed',
    ),
    async updateCode(id, patch) {
      const { error } = await db().from('seller_portal_login_codes').update(patch).eq('id', id);
      if (error) fail('code_write_failed', error);
    },
    async insertSession(row) {
      const { error } = await db().from('seller_portal_sessions').insert(row);
      if (error) fail('session_write_failed', error);
    },
    findSession: (tokenHash) => one(db().from('seller_portal_sessions').select('*').eq('token_hash', tokenHash), 'session_read_failed'),
    async updateSession(id, patch) {
      const { error } = await db().from('seller_portal_sessions').update(patch).eq('id', id);
      if (error) fail('session_write_failed', error);
    },

    // --- canonical reads ----------------------------------------------------
    getOpportunity: (id) => one(db().from('acquisition_opportunities').select('id, acquisition_stage, opportunity_status, primary_thread_key, primary_property_id, master_owner_id, property_address_full, seller_display_name, assigned_operator, source_submission_id, created_at, updated_at').eq('id', id), 'opportunity_read_failed'),
    getIntakeSubmission: (id) => (id ? one(db().from('external_seller_intake_submissions').select('id, seller_display_name, seller_phone, seller_email, property_address').eq('id', id), 'intake_read_failed') : null),
    listOffers: (oppId) => many(db().from('seller_offers').select('offer_id, offer_version, offer_type, direction, purchase_price, closing_date, closing_term, emd_amount, emd_term, status, sent_at, accepted_at').eq('opportunity_id', oppId), 'offer_read_failed'),
    async listEvaluations(oppId) {
      const requests = await many(db().from('offerr_evaluation_requests').select('id').eq('acquisition_opportunity_id', oppId), 'estimate_read_failed');
      if (!requests.length) return [];
      return many(db().from('offerr_evaluations').select('id, seller_projection, expires_at, computed_at, created_at').in('request_id', requests.map((r) => r.id)), 'estimate_read_failed');
    },
    getClosingCase: (oppId) => one(db().from('closing_cases').select('*').eq('opportunity_id', oppId).order('created_at', { ascending: false }).limit(1), 'closing_read_failed'),
    listMilestones: (caseId) => many(db().from('closing_milestones').select('milestone_type, occurred_at').eq('closing_case_id', caseId), 'closing_read_failed'),
    listTitleIssues: (caseId) => many(db().from('closing_title_issues').select('issue_type, description, status, owner, opened_at').eq('closing_case_id', caseId), 'closing_read_failed'),

    // --- sign-in hardening ------------------------------------------------------
    async audit(row) {
      const { error } = await db().from('seller_portal_audit_events').insert(row);
      if (error) fail('audit_write_failed', error);
    },
    async countThrottle(bucket, keyHash, sinceIso) {
      const { count, error } = await db().from('seller_portal_throttle').select('id', { count: 'exact', head: true }).eq('bucket', bucket).eq('key_hash', keyHash).gte('created_at', sinceIso);
      if (error) fail('throttle_read_failed', error);
      return count ?? 0;
    },
    async recordThrottle(bucket, keyHash, at) {
      const { error } = await db().from('seller_portal_throttle').insert({ bucket, key_hash: keyHash, ...(at ? { created_at: at } : {}) });
      if (error) fail('throttle_write_failed', error);
    },
    async pruneThrottle(beforeIso) {
      const { error } = await db().from('seller_portal_throttle').delete().lt('created_at', beforeIso);
      if (error) fail('throttle_write_failed', error);
    },
    /** Flips consumed_at from null exactly once; a concurrent second use gets false. */
    async consumeCode(id, at) {
      const { data, error } = await db().from('seller_portal_login_codes').update({ consumed_at: at }).eq('id', id).is('consumed_at', null).select('id').maybeSingle();
      if (error) fail('code_write_failed', error);
      return Boolean(data);
    },
    async incrementCodeAttempts(id, current) {
      const { error } = await db().from('seller_portal_login_codes').update({ attempts: current + 1 }).eq('id', id).eq('attempts', current);
      if (error) fail('code_write_failed', error);
    },
    async consumeOpenCodes(identityId, at) {
      const { error } = await db().from('seller_portal_login_codes').update({ consumed_at: at }).eq('identity_id', identityId).is('consumed_at', null);
      if (error) fail('code_write_failed', error);
    },
    listActiveSessions: (identityId, nowIso) => many(db().from('seller_portal_sessions').select('id, created_at').eq('identity_id', identityId).is('revoked_at', null).gt('expires_at', nowIso).order('created_at', { ascending: false }), 'session_read_failed'),
    async revokeSessions(ids, reason, at) {
      if (!ids.length) return;
      const { error } = await db().from('seller_portal_sessions').update({ revoked_at: at, revoked_reason: reason }).in('id', ids).is('revoked_at', null);
      if (error) fail('session_write_failed', error);
    },
    async revokeAllSessions(identityId, reason, at) {
      const { error } = await db().from('seller_portal_sessions').update({ revoked_at: at, revoked_reason: reason }).eq('identity_id', identityId).is('revoked_at', null);
      if (error) fail('session_write_failed', error);
    },

    // --- lifecycle notifications ---------------------------------------------
    async listIdentitiesForOpportunity(oppId) {
      const grants = await many(db().from('seller_portal_grants').select('identity:seller_portal_identities(id, email, display_name, status)').eq('opportunity_id', oppId).is('revoked_at', null), 'grant_read_failed');
      return grants.map((g) => g.identity).filter((i) => i && i.status === 'active');
    },
    /**
     * Returns the claimed row, or null when this (event, seller) was already
     * sent or deliberately skipped. A FAILED earlier attempt is reclaimable,
     * so a transient provider error does not lose the notification forever.
     */
    async claimNotification(row) {
      const { data, error } = await db().from('seller_portal_notifications').insert(row).select('id').maybeSingle();
      if (error?.code === '23505') {
        const { data: retry, error: e2 } = await db().from('seller_portal_notifications').update({ status: 'pending', reason: null }).eq('dedupe_key', row.dedupe_key).eq('status', 'failed').select('id').maybeSingle();
        if (e2) fail('notification_write_failed', e2);
        return retry ?? null;
      }
      if (error) fail('notification_write_failed', error);
      return data;
    },
    async updateNotification(id, patch) {
      const { error } = await db().from('seller_portal_notifications').update(patch).eq('id', id);
      if (error) fail('notification_write_failed', error);
    },

    // --- messages -------------------------------------------------------------
    listMessages: (oppId) => many(db().from('seller_portal_messages').select('id, author_kind, author_operator, body, created_at').eq('opportunity_id', oppId).order('created_at'), 'message_read_failed'),
    async insertMessage(row) {
      const { data, error } = await db().from('seller_portal_messages').upsert(row, { onConflict: 'opportunity_id,idempotency_key', ignoreDuplicates: false }).select('id, author_kind, author_operator, body, created_at').single();
      if (error) fail('message_write_failed', error);
      return data;
    },
    async markRead(oppId, field, at) {
      const { error } = await db().from('seller_portal_messages').update({ [field]: at }).eq('opportunity_id', oppId).is(field, null);
      if (error) fail('message_write_failed', error);
    },

    // --- documents ------------------------------------------------------------
    listShares: (oppId) => many(db().from('seller_portal_document_shares').select('id, label, document_kind, seller_status, shared_at, attachment:email_attachments(filename, content_type, size_bytes)').eq('opportunity_id', oppId).is('revoked_at', null).order('shared_at', { ascending: false }), 'document_read_failed'),
    getShare: (oppId, shareId) => one(db().from('seller_portal_document_shares').select('id, attachment:email_attachments(storage_bucket, storage_path, filename)').eq('opportunity_id', oppId).eq('id', shareId).is('revoked_at', null), 'document_read_failed'),
    async createShare(row) {
      const { data, error } = await db().from('seller_portal_document_shares').upsert(row, { onConflict: 'opportunity_id,attachment_id' }).select('id').single();
      if (error) fail('document_write_failed', error);
      return data;
    },
    listSharesForOps: (oppId) => many(db().from('seller_portal_document_shares').select('id, attachment_id, label, document_kind, seller_status, shared_by, shared_at, revoked_at, revoked_by').eq('opportunity_id', oppId).order('shared_at', { ascending: false }), 'document_read_failed'),
    async revokeShare(oppId, shareId, by, at) {
      const { data, error } = await db().from('seller_portal_document_shares').update({ revoked_at: at, revoked_by: by }).eq('opportunity_id', oppId).eq('id', shareId).is('revoked_at', null).select('id').maybeSingle();
      if (error) fail('document_write_failed', error);
      return Boolean(data);
    },
    /**
     * Stored files that belong to this deal and may be shown to its seller:
     * routed to the opportunity or its closing case, or received on the closing
     * case's title/seller threads. Buyer-side threads are excluded outright.
     */
    async listShareableAttachments(oppId) {
      const cols = 'id, filename, content_type, size_bytes, doc_type, created_at, routed_entity_type, routed_entity_id, thread_id';
      const closing = await one(db().from('closing_cases').select('closing_case_id').eq('opportunity_id', oppId).order('created_at', { ascending: false }).limit(1), 'closing_read_failed');
      const caseId = closing?.closing_case_id;
      const threads = caseId ? await many(db().from('email_threads').select('id, category').eq('closing_case_id', caseId), 'thread_read_failed') : [];
      const allowedThreads = threads.filter((t) => t.category !== 'buyer').map((t) => t.id);
      const buyerThreads = new Set(threads.filter((t) => t.category === 'buyer').map((t) => t.id));
      const [toOpp, toCase, onThreads] = await Promise.all([
        many(db().from('email_attachments').select(cols).eq('routed_entity_type', 'opportunity').eq('routed_entity_id', oppId).eq('fetch_status', 'stored'), 'document_read_failed'),
        caseId ? many(db().from('email_attachments').select(cols).eq('routed_entity_type', 'closing_case').eq('routed_entity_id', caseId).eq('fetch_status', 'stored'), 'document_read_failed') : [],
        allowedThreads.length ? many(db().from('email_attachments').select(cols).in('thread_id', allowedThreads).eq('fetch_status', 'stored'), 'document_read_failed') : [],
      ]);
      const seen = new Set();
      return [...toOpp, ...toCase, ...onThreads]
        .filter((a) => !buyerThreads.has(a.thread_id))
        .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
        .map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type, size_bytes: a.size_bytes, doc_type: a.doc_type, received_at: a.created_at }));
    },

    // --- operations: seller conversations ------------------------------------
    async listSellerConversations({ unreadOnly = false, limit = 100 } = {}) {
      let q = db().from('seller_portal_messages').select('opportunity_id, author_kind, body, created_at, operator_read_at').order('created_at', { ascending: false }).limit(1000);
      if (unreadOnly) q = q.eq('author_kind', 'seller').is('operator_read_at', null);
      const rows = await many(q, 'message_read_failed');
      const byOpp = new Map();
      for (const m of rows) {
        const c = byOpp.get(m.opportunity_id) ?? { opportunity_id: m.opportunity_id, last_at: m.created_at, last_author: m.author_kind, preview: m.body.slice(0, 160), unread: 0 };
        if (m.author_kind === 'seller' && !m.operator_read_at) c.unread++;
        byOpp.set(m.opportunity_id, c);
      }
      const list = [...byOpp.values()].slice(0, limit);
      if (!list.length) return [];
      const opps = await many(db().from('acquisition_opportunities').select('id, property_address_full, seller_display_name, acquisition_stage, opportunity_status, assigned_operator').in('id', list.map((c) => c.opportunity_id)), 'opportunity_read_failed');
      return list.map((c) => ({ ...c, opportunity: opps.find((o) => o.id === c.opportunity_id) ?? null }));
    },
    /** Short-lived, served as an attachment with the stored content type. */
    async signedUrl(bucket, path, seconds, downloadName) {
      const { data, error } = await db().storage.from(bucket).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
      if (error || !data?.signedUrl) fail('document_link_failed', error);
      return data.signedUrl;
    },

    // --- operations signals (canonical tools) --------------------------------
    async appendHistory(row) {
      const { error } = await db().from('acquisition_opportunity_history').insert(row);
      if (error) fail('history_write_failed', error);
    },
    async flagInbox(threadKey, at, preview) {
      if (!threadKey) return;
      const { error } = await db().from('inbox_thread_state').update({ is_read: false, next_action: 'seller_portal_activity', next_action_at: at, updated_at: at, latest_message_body: preview }).eq('thread_key', threadKey);
      if (error) fail('inbox_write_failed', error);
    },
  };
}

/** In-memory twin. Seed with { opportunities, offers, evaluations, closings, ... }. */
export function createInMemorySellerPortalStore(seed = {}) {
  const s = {
    identities: [], grants: [], codes: [], sessions: [], messages: [], shares: [], history: [], inboxFlags: [],
    throttle: [], audits: [], notifications: [], threads: [],
    opportunities: [], intake: [], offers: [], evaluations: [], closings: [], milestones: [], titleIssues: [], attachments: [],
    ...structuredClone(seed),
  };
  const id = () => globalThis.crypto.randomUUID();
  return {
    kind: 'memory',
    state: s,
    findIdentityByEmail: async (email) => s.identities.find((r) => r.email === email) ?? null,
    findIdentityById: async (iid) => s.identities.find((r) => r.id === iid) ?? null,
    async createIdentity(row) {
      const existing = s.identities.find((r) => r.email === row.email);
      if (existing) return existing;
      const created = { id: id(), status: 'active', created_at: new Date().toISOString(), ...row };
      s.identities.push(created);
      return created;
    },
    async touchSignIn(iid, at) { const r = s.identities.find((x) => x.id === iid); if (r) r.last_sign_in_at = at; },
    listGrants: async (iid) => s.grants.filter((g) => g.identity_id === iid && !g.revoked_at),
    async createGrant(row) { if (!s.grants.some((g) => g.identity_id === row.identity_id && g.opportunity_id === row.opportunity_id)) s.grants.push({ id: id(), ...row }); },
    findIntakeClaims: async (email) => s.intake.filter((r) => r.status === 'accepted' && r.lead_id && String(r.seller_email || '').toLowerCase() === email),
    async insertCode(row) { s.codes.push({ id: id(), attempts: 0, consumed_at: null, created_at: new Date().toISOString(), ...row }); },
    countCodesSince: async (iid, since) => s.codes.filter((c) => c.identity_id === iid && c.created_at >= since).length,
    latestOpenCode: async (iid, nowIso) => [...s.codes].reverse().find((c) => c.identity_id === iid && !c.consumed_at && c.expires_at > nowIso) ?? null,
    async updateCode(cid, patch) { Object.assign(s.codes.find((c) => c.id === cid) ?? {}, patch); },
    async insertSession(row) { s.sessions.push({ id: id(), ...row }); },
    findSession: async (h) => s.sessions.find((x) => x.token_hash === h) ?? null,
    async updateSession(sid, patch) { Object.assign(s.sessions.find((x) => x.id === sid) ?? {}, patch); },
    getOpportunity: async (oid) => s.opportunities.find((o) => o.id === oid) ?? null,
    getIntakeSubmission: async (iid) => s.intake.find((r) => r.id === iid) ?? null,
    listOffers: async (oid) => s.offers.filter((o) => o.opportunity_id === oid),
    listEvaluations: async (oid) => s.evaluations.filter((e) => e.acquisition_opportunity_id === oid),
    getClosingCase: async (oid) => s.closings.find((c) => c.opportunity_id === oid) ?? null,
    listMilestones: async (cid) => s.milestones.filter((m) => m.closing_case_id === cid),
    listTitleIssues: async (cid) => s.titleIssues.filter((m) => m.closing_case_id === cid),
    async audit(row) { s.audits.push({ created_at: new Date().toISOString(), ...row }); },
    countThrottle: async (bucket, key, since) => s.throttle.filter((t) => t.bucket === bucket && t.key_hash === key && t.created_at >= since).length,
    async recordThrottle(bucket, key, at) { s.throttle.push({ bucket, key_hash: key, created_at: at ?? new Date().toISOString() }); },
    async pruneThrottle(before) { s.throttle = s.throttle.filter((t) => t.created_at >= before); },
    async consumeCode(cid, at) {
      await new Promise((r) => setImmediate(r));
      const c = s.codes.find((x) => x.id === cid);
      if (!c || c.consumed_at) return false;
      c.consumed_at = at;
      return true;
    },
    async incrementCodeAttempts(cid, current) { const c = s.codes.find((x) => x.id === cid); if (c && (c.attempts ?? 0) === current) c.attempts = current + 1; },
    async consumeOpenCodes(iid, at) { s.codes.filter((c) => c.identity_id === iid && !c.consumed_at).forEach((c) => { c.consumed_at = at; }); },
    listActiveSessions: async (iid, nowIso) => s.sessions.filter((x) => x.identity_id === iid && !x.revoked_at && x.expires_at > nowIso).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    async revokeSessions(ids, reason, at) { s.sessions.filter((x) => ids.includes(x.id) && !x.revoked_at).forEach((x) => { x.revoked_at = at; x.revoked_reason = reason; }); },
    async revokeAllSessions(iid, reason, at) { s.sessions.filter((x) => x.identity_id === iid && !x.revoked_at).forEach((x) => { x.revoked_at = at; x.revoked_reason = reason; }); },
    listIdentitiesForOpportunity: async (oid) => s.grants.filter((g) => g.opportunity_id === oid && !g.revoked_at).map((g) => s.identities.find((i) => i.id === g.identity_id)).filter((i) => i && i.status === 'active'),
    async claimNotification(row) {
      const prior = s.notifications.find((n) => n.dedupe_key === row.dedupe_key);
      if (prior?.status === 'failed') { prior.status = 'pending'; return { id: prior.id }; }
      if (prior) return null;
      const r = { id: id(), status: 'pending', ...row };
      s.notifications.push(r);
      return { id: r.id };
    },
    async updateNotification(nid, patch) { Object.assign(s.notifications.find((n) => n.id === nid) ?? {}, patch); },
    listMessages: async (oid) => s.messages.filter((m) => m.opportunity_id === oid),
    async insertMessage(row) {
      const dup = row.idempotency_key && s.messages.find((m) => m.opportunity_id === row.opportunity_id && m.idempotency_key === row.idempotency_key);
      if (dup) return dup;
      const r = { id: id(), created_at: new Date().toISOString(), ...row };
      s.messages.push(r);
      return r;
    },
    async markRead(oid, field, at) { s.messages.filter((m) => m.opportunity_id === oid && !m[field]).forEach((m) => { m[field] = at; }); },
    listShares: async (oid) => s.shares.filter((x) => x.opportunity_id === oid && !x.revoked_at).map((x) => ({ ...x, attachment: s.attachments.find((a) => a.id === x.attachment_id) ?? null })),
    getShare: async (oid, sid) => {
      const x = s.shares.find((r) => r.opportunity_id === oid && r.id === sid && !r.revoked_at);
      return x ? { id: x.id, attachment: s.attachments.find((a) => a.id === x.attachment_id) ?? null } : null;
    },
    async createShare(row) {
      const existing = s.shares.find((x) => x.opportunity_id === row.opportunity_id && x.attachment_id === row.attachment_id);
      if (existing) { Object.assign(existing, row); return { id: existing.id }; }
      const r = { id: id(), ...row };
      s.shares.push(r);
      return { id: r.id };
    },
    listSharesForOps: async (oid) => s.shares.filter((x) => x.opportunity_id === oid),
    async revokeShare(oid, sid, by, at) {
      const x = s.shares.find((r) => r.opportunity_id === oid && r.id === sid && !r.revoked_at);
      if (!x) return false;
      x.revoked_at = at; x.revoked_by = by;
      return true;
    },
    listShareableAttachments: async (oid) => {
      const caseId = s.closings.find((c) => c.opportunity_id === oid)?.closing_case_id;
      const buyer = new Set(s.threads.filter((t) => t.category === 'buyer').map((t) => t.id));
      const caseThreads = new Set(s.threads.filter((t) => caseId && t.closing_case_id === caseId && t.category !== 'buyer').map((t) => t.id));
      return s.attachments.filter((a) => a.fetch_status !== 'pending' && !buyer.has(a.thread_id) && ((a.routed_entity_type === 'opportunity' && a.routed_entity_id === oid) || (caseId && a.routed_entity_type === 'closing_case' && a.routed_entity_id === caseId) || caseThreads.has(a.thread_id)));
    },
    async listSellerConversations({ unreadOnly = false } = {}) {
      const byOpp = new Map();
      for (const m of [...s.messages].reverse()) {
        if (unreadOnly && !(m.author_kind === 'seller' && !m.operator_read_at)) continue;
        const c = byOpp.get(m.opportunity_id) ?? { opportunity_id: m.opportunity_id, last_at: m.created_at, last_author: m.author_kind, preview: m.body.slice(0, 160), unread: 0 };
        if (m.author_kind === 'seller' && !m.operator_read_at) c.unread++;
        byOpp.set(m.opportunity_id, c);
      }
      return [...byOpp.values()].map((c) => ({ ...c, opportunity: s.opportunities.find((o) => o.id === c.opportunity_id) ?? null }));
    },
    signedUrl: async (bucket, path, seconds, name) => `memory://${bucket}/${path}?expires=${seconds}${name ? `&download=${encodeURIComponent(name)}` : ''}`,
    async appendHistory(row) { s.history.push(row); },
    async flagInbox(threadKey, at) { if (threadKey) s.inboxFlags.push({ threadKey, at }); },
  };
}
