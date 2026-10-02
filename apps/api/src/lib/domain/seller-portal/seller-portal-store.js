/**
 * Seller portal — persistence store.
 *
 * Reads are projections of canonical tables (acquisition_opportunities,
 * seller_offers, offerr_evaluation_requests/offerr_evaluations, closing_cases,
 * closing_milestones, closing_title_issues, email_attachments,
 * external_seller_intake_submissions). Writes touch only the seller-portal
 * tables, calendar_manual_events, acquisition_opportunity_history (append),
 * and the canonical inbox "needs attention" flags so operations see seller
 * activity in the tools they already use.
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

    // --- calls ----------------------------------------------------------------
    listCalls: (oppId) => many(db().from('calendar_manual_events').select('id, start_at, timezone, status, call_reason, assigned_operator, created_at').eq('event_type', 'manual_call').eq('opportunity_id', oppId).order('start_at'), 'call_read_failed'),
    listCallsBetween: (startIso, endIso) => many(db().from('calendar_manual_events').select('start_at').eq('event_type', 'manual_call').eq('status', 'scheduled').gte('start_at', startIso).lt('start_at', endIso), 'call_read_failed'),
    async insertCall(row) {
      const { data, error } = await db().from('calendar_manual_events').insert(row).select('id, start_at, timezone, status, call_reason, assigned_operator').single();
      if (error) fail('call_write_failed', error);
      return data;
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
    async signedUrl(bucket, path, seconds) {
      const { data, error } = await db().storage.from(bucket).createSignedUrl(path, seconds);
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
    identities: [], grants: [], codes: [], sessions: [], calls: [], messages: [], shares: [], history: [], inboxFlags: [],
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
    listCalls: async (oid) => s.calls.filter((c) => c.opportunity_id === oid),
    listCallsBetween: async (a, b) => s.calls.filter((c) => c.status === 'scheduled' && c.start_at >= a && c.start_at < b),
    async insertCall(row) { const r = { id: id(), ...row }; s.calls.push(r); return r; },
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
    async createShare(row) { const r = { id: id(), ...row }; s.shares.push(r); return { id: r.id }; },
    signedUrl: async (bucket, path, seconds) => `memory://${bucket}/${path}?expires=${seconds}`,
    async appendHistory(row) { s.history.push(row); },
    async flagInbox(threadKey, at) { if (threadKey) s.inboxFlags.push({ threadKey, at }); },
  };
}
