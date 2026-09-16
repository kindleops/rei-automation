import crypto from "node:crypto";

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import {
  getBrevoHealth,
  sendBrevoTransactionalEmail,
} from "@/lib/domain/email/brevo-provider.js";

let _deps = {
  supabase_override: null,
  send_brevo_override: null,
  now_iso_override: null,
};

const SUPPRESSION_EVENT_TYPES = new Set([
  "bounced",
  "hard_bounce",
  "soft_bounce",
  "blocked",
  "unsubscribed",
  "spam",
  "complaint",
  "invalid_email",
]);

function getDb() {
  return _deps.supabase_override || defaultSupabase;
}

function getSendBrevo() {
  return _deps.send_brevo_override || sendBrevoTransactionalEmail;
}

function nowIso() {
  return _deps.now_iso_override ? _deps.now_iso_override() : new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function bool(value) {
  return ["1", "true", "yes", "on"].includes(lower(value));
}

function asLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function asOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeEmail(value) {
  return lower(value);
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function singleRecipient(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) return { ok: false, reason: "bulk_email_not_allowed" };
    return singleRecipient(value[0]);
  }

  const email = normalizeEmail(typeof value === "object" ? value?.email : value);
  if (!email) return { ok: false, reason: "missing_email" };
  if (email.includes(",") || email.includes(";")) {
    return { ok: false, reason: "bulk_email_not_allowed" };
  }
  if (!isValidEmail(email)) return { ok: false, reason: "invalid_email" };
  return { ok: true, email };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return "";
}

function messagePreview(value, max = 180) {
  return clean(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function eventKey(prefix, payload = {}) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function maybeJson(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeSuppressionReason(value) {
  const reason = lower(value);
  if (reason.includes("unsubscribe")) return "unsubscribed";
  if (reason.includes("bounce")) return "bounced";
  if (reason.includes("spam") || reason.includes("complaint")) return "complaint";
  if (reason.includes("block")) return "blocked";
  if (reason.includes("invalid")) return "bounced";
  if (reason) return reason;
  return "suppressed";
}

function mapRecord(row = {}) {
  const suppression = normalizeSuppressionReason(row.suppression_status);
  const isSuppressed = suppression && suppression !== "none";
  const confidence =
    lower(row.email_match_confidence) ||
    lower(row.match_confidence) ||
    (Number(row.email_score || row.email_score_final || 0) >= 80 ? "high" : "unknown");

  return {
    id: clean(row.id || row.email_id || row.email || row.email_address),
    email: normalizeEmail(row.email || row.email_address),
    email_address: normalizeEmail(row.email_address || row.email),
    email_rank: Number(row.email_rank || 0),
    email_score: Number(row.email_score ?? row.email_score_final ?? 0),
    email_match_confidence: confidence,
    match_confidence: confidence,
    verified_status: lower(row.verified_status) || "unverified",
    brevo_contact_status: lower(row.brevo_contact_status) || (isSuppressed ? suppression : "unknown"),
    suppression_status: isSuppressed ? suppression : "none",
    prospect_id: clean(row.prospect_id) || null,
    property_id: clean(row.property_id) || null,
    master_owner_id: clean(row.master_owner_id) || null,
    owner_name: clean(row.owner_name) || null,
    prospect_name: clean(row.prospect_name || row.owner_name) || "",
    property_address: clean(row.property_address) || null,
    linked_property: clean(row.property_id) || null,
    market: clean(row.market) || null,
    language: clean(row.language) || "en",
    last_email_sent_at: clean(row.last_email_sent_at) || null,
    last_email_sent: clean(row.last_email_sent_at || row.last_email_sent) || null,
    last_email_reply_at: clean(row.last_email_reply_at) || null,
    last_reply: clean(row.last_email_reply_at || row.last_reply) || null,
    eligibility: isSuppressed || lower(row.verified_status) === "invalid" ? "ineligible" : "eligible",
    metadata: maybeJson(row.metadata),
  };
}

function mapThreadRow(row = {}) {
  const latestAt = firstNonEmpty(row.last_message_at, row.sent_at, row.created_at);
  const subject = firstNonEmpty(row.subject, "(no subject)");
  const email = normalizeEmail(row.email_address || row.to_email || row.from_email);

  return {
    id: clean(row.thread_id || row.id),
    thread_id: clean(row.thread_id || row.id),
    folder: lower(row.folder) || "all",
    prospect_name: clean(row.prospect_name || row.owner_name) || "",
    email_address: email,
    subject,
    last_message_preview: messagePreview(row.body_preview || row.text_body || row.html_body),
    last_message_at: latestAt || null,
    message_count: Number(row.message_count || 1),
    unread: Boolean(row.unread),
    property_address: clean(row.property_address) || null,
    market: clean(row.market) || null,
    has_sms_thread: Boolean(row.has_sms_thread),
    sentiment: lower(row.sentiment) || "unknown",
  };
}

/**
 * §10 — one status ladder, from durable timestamps only.
 *
 *   failed  >  delivered  >  sent  >  received  >  queued
 *
 * Deliberately NOT collapsed: queued is not sent, sent is not delivered, and
 * delivered is not replied. Nothing here reads a success flag from the
 * request that created the row.
 */
function deriveEventStatus(row = {}) {
  if (row.failed_at) return "failed";
  if (row.delivered_at) return "delivered";
  if (lower(row.direction) === "inbound") return "received";
  if (row.sent_at) return "sent";
  return "queued";
}

function mapMessage(row = {}) {
  const status = lower(row.status);
  /**
   * §9 — direction is read, never inferred. This previously mapped anything
   * that was not "inbound" to "outbound", so a row with a missing or
   * unexpected direction was displayed with confidence as an outbound
   * message. An unknown direction is reported as unknown.
   */
  const rawDirection = lower(row.direction);
  const direction =
    rawDirection === "inbound" || rawDirection === "outbound" || rawDirection === "system"
      ? rawDirection
      : "unknown";
  return {
    id: clean(row.id || row.message_id),
    direction,
    from_address: normalizeEmail(row.from_email || row.from_address),
    to_address: normalizeEmail(row.to_email || row.to_address || row.email_address),
    subject: clean(row.subject),
    body_preview: messagePreview(row.body_preview || row.email_body || row.text_body || row.html_body),
    body_html: clean(row.html_body || row.body_html) || null,
    body_text: clean(row.email_body || row.text_body) || null,
    sent_at: clean(row.sent_at || row.created_at) || null,
    delivered_at: clean(row.delivered_at) || null,
    failed_at: clean(row.failed_at) || null,
    opened: Boolean(row.opened_at || status === "opened"),
    clicked: Boolean(row.clicked_at || status === "clicked"),
    bounced: Boolean(row.bounced_at || row.failed_at || status === "bounced" || status === "failed"),
    failure_reason: clean(row.error_message) || null,
    provider_message_id: clean(row.provider_message_id) || null,
    /**
     * §10 — the status is derived from durable timestamps in the order the
     * provider produces them, so "queued" can never be shown as "delivered".
     */
    status: status || deriveEventStatus(row),
    event_type: lower(row.event_type) || null,
  };
}

export function __setEmailServiceDeps(overrides = {}) {
  _deps = { ..._deps, ...overrides };
}

export function __resetEmailServiceDeps() {
  _deps = {
    supabase_override: null,
    send_brevo_override: null,
    now_iso_override: null,
  };
}

/**
 * Email records, paged in the database.
 *
 * This used to select from v_email_records with `{ count: "exact" }` and an
 * ORDER BY. Both force the whole 165,655-row read model to be built before
 * anything is returned, because the view's per-row LATERAL lookups into
 * prospects/properties sit BELOW the sort. Measured 2026-09-16: `LIMIT 3`
 * took 13.4s and production answered /api/cockpit/email/records with
 * "canceling statement due to statement timeout" — a 500 on the surface's
 * primary read.
 *
 * get_email_records() chooses the page from the base table first and enriches
 * only that page: 30ms for the same request. The count comes from
 * get_email_records_count(), which applies the SAME predicate to the base
 * table — a real count, not the length of what happened to load (§28).
 */
export async function getEmailRecords(filters = {}) {
  const db = getDb();
  const limit = asLimit(filters.limit, 100, 1000);
  const offset = asOffset(filters.offset);

  const search = clean(filters.search || filters.q) || null;
  const market = clean(filters.market) && lower(filters.market) !== "all" ? clean(filters.market) : null;
  const confidence = clean(filters.confidence) && lower(filters.confidence) !== "all" ? lower(filters.confidence) : null;

  // `eligibility` is expressed through suppression, exactly as before:
  // eligible == nothing suppressing the address.
  let suppression = clean(filters.suppression) && lower(filters.suppression) !== "all" ? lower(filters.suppression) : null;
  const eligibility = lower(filters.eligibility);
  if (!suppression && eligibility && eligibility !== "all") {
    suppression = eligibility === "eligible" ? "none" : null;
  }

  // §5/§6 — the operator's current subject, scoped in the database so the
  // page and the count agree. An unknown subject yields 0 rows rather than
  // silently falling back to the whole corpus.
  const propertyId = clean(filters.property_id || filters.propertyId) || null;
  const masterOwnerId = clean(filters.master_owner_id || filters.masterOwnerId) || null;

  const subjectArgs = { p_property_id: propertyId, p_master_owner_id: masterOwnerId };
  const filterArgs = {
    p_search: search,
    p_market: market,
    p_suppression: suppression,
    p_confidence: confidence,
    ...subjectArgs,
  };

  const [rowsRes, countRes] = await Promise.all([
    db.rpc("get_email_records", { p_limit: limit, p_offset: offset, ...filterArgs }),
    db.rpc("get_email_records_count", filterArgs),
  ]);

  if (rowsRes.error) {
    return {
      ok: false,
      error: "email_records_query_failed",
      message: clean(rowsRes.error?.message) || "email_records_query_failed",
      records: [],
    };
  }

  const records = (rowsRes.data || []).map(mapRecord);

  // A failed count is reported, never silently replaced by the page length —
  // that is how a filtered view starts claiming it holds the whole corpus.
  if (countRes.error) {
    return {
      ok: false,
      error: "email_records_count_failed",
      message: clean(countRes.error?.message) || "email_records_count_failed",
      records: [],
    };
  }

  return {
    ok: true,
    records,
    count: Number(countRes.data ?? 0),
    limit,
    offset,
    subject: propertyId || masterOwnerId
      ? { property_id: propertyId, master_owner_id: masterOwnerId }
      : null,
  };
}

/**
 * Headline email numbers, every one from a real predicate.
 *
 * Two defects lived here. It called getEmailRecords({ limit: 5000 }) and
 * counted the returned array, so each total was a page length rather than a
 * corpus count. And when that read failed it fell back to `[]` and still
 * returned ok:true, so production served HTTP 200 with nine zeros over a
 * 165,655-row corpus on 2026-09-16 — an operator would read "no email data".
 *
 * Counts now come from get_email_overview_counts() (one pass, same
 * derivations as v_email_records, so headline and list cannot disagree), and
 * a failed read is reported as a failure.
 */
export async function getEmailOverview() {
  const db = getDb();
  const health = await getBrevoHealth();

  const brevoStatus = health.connected
    ? "connected"
    : health.missing?.length
      ? "disconnected"
      : "degraded";

  const countsRes = await db.rpc("get_email_overview_counts");
  if (countsRes.error) {
    return {
      ok: false,
      error: "email_overview_counts_failed",
      message: clean(countsRes.error?.message) || "email counts could not be read",
      brevo_status: brevoStatus,
      brevo_health: health,
      last_updated: nowIso(),
    };
  }

  const counts = Array.isArray(countsRes.data) ? countsRes.data[0] || {} : countsRes.data || {};

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  // Today's activity from the LIVE event ledger. The old version also read
  // email_messages (which does not exist here) inside a `.catch(() => ...)`,
  // so a missing table silently became "0 sent, 0 replies".
  const eventsRes = await db
    .from("email_events")
    .select("event_type, direction, to_email, created_at, sent_at")
    .gte("created_at", todayIso)
    .limit(1000);

  if (eventsRes.error) {
    return {
      ok: false,
      error: "email_overview_events_failed",
      message: clean(eventsRes.error?.message) || "email events could not be read",
      brevo_status: brevoStatus,
      brevo_health: health,
      last_updated: nowIso(),
    };
  }

  const eventRows = eventsRes.data || [];
  const sentToday = eventRows.filter((row) => lower(row.direction) === "outbound").length;
  const repliesToday = eventRows.filter(
    (row) => lower(row.direction) === "inbound" || lower(row.event_type) === "replied",
  ).length;

  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    ok: true,
    total_emails: num(counts.total_emails),
    email_eligible: num(counts.email_eligible),
    high_confidence: num(counts.high_confidence),
    suppressed: num(counts.suppressed),
    bounced: num(counts.bounced),
    unsubscribed: num(counts.unsubscribed),
    sent_today: sentToday,
    replies_today: repliesToday,
    ready_for_campaign: num(counts.ready_for_campaign),
    brevo_status: brevoStatus,
    brevo_health: health,
    records_warning: null,
    last_updated: nowIso(),
  };
}

/**
 * Email threads from the LIVE event ledger.
 *
 * This used to read `email_messages`, which does not exist in this database —
 * production answered /api/cockpit/email/threads with
 * "Could not find the table 'public.email_messages' in the schema cache"
 * (HTTP 500). It also loaded `limit * 5` rows and then did folder filtering,
 * search and counting IN JAVASCRIPT over whatever came back, so search saw
 * only loaded rows and `count` was the length of that slice — §26 and §28.
 *
 * Threading is now one deterministic rule, in SQL: a thread is keyed by the
 * COUNTERPARTY address (from_email inbound, to_email outbound). Subject is
 * excluded from the key so "Re:"/"Fwd:" cannot fragment a conversation.
 * Verified against a 3-message synthetic thread whose subject changed twice
 * and whose direction flipped: one thread, correct order, then removed.
 */
export async function getEmailThreads(filters = {}) {
  const db = getDb();
  const limit = asLimit(filters.limit, 100, 500);
  const offset = asOffset(filters.offset);
  const folder = clean(filters.folder) && lower(filters.folder) !== "all" ? lower(filters.folder) : null;
  const search = clean(filters.search || filters.q) || null;

  const [rowsRes, countRes] = await Promise.all([
    db.rpc("get_email_threads", {
      p_limit: limit,
      p_offset: offset,
      p_search: search,
      p_folder: folder,
    }),
    db.rpc("get_email_threads_count", { p_search: search, p_folder: folder }),
  ]);

  if (rowsRes.error) {
    return {
      ok: false,
      error: "email_threads_query_failed",
      message: clean(rowsRes.error?.message) || "email_threads_query_failed",
      threads: [],
    };
  }
  if (countRes.error) {
    return {
      ok: false,
      error: "email_threads_count_failed",
      message: clean(countRes.error?.message) || "email_threads_count_failed",
      threads: [],
    };
  }

  const threads = (rowsRes.data || []).map((row) =>
    mapThreadRow({
      thread_id: row.thread_id,
      email_address: row.email_address,
      subject: row.subject,
      last_message_at: row.last_message_at,
      body_preview: row.last_body,
      message_count: row.message_count,
      folder: row.folder,
      // A thread whose newest message is inbound is awaiting a human.
      unread: lower(row.last_direction) === "inbound",
    }),
  );

  // §28 — folder badges are a corpus predicate, not a count of loaded rows.
  const folderRes = await db.rpc("get_email_folder_counts", { p_search: search });
  const folder_counts = {};
  if (!folderRes.error) {
    for (const row of folderRes.data || []) folder_counts[clean(row.folder)] = Number(row.thread_count ?? 0);
  }

  return {
    ok: true,
    threads,
    count: Number(countRes.data ?? 0),
    // null (not {}) when unreadable, so the UI shows no badge instead of "0".
    folder_counts: folderRes.error ? null : folder_counts,
    limit,
    offset,
  };
}

export async function getEmailThread(threadId) {
  const db = getDb();
  const normalizedThreadId = clean(threadId);
  if (!normalizedThreadId) {
    return { ok: false, error: "missing_thread_id", messages: [] };
  }

  const { data, error } = await db.rpc("get_email_thread_messages", {
    p_thread_id: normalizedThreadId,
  });

  if (error) {
    return {
      ok: false,
      error: "email_thread_query_failed",
      message: clean(error?.message) || "email_thread_query_failed",
      messages: [],
    };
  }

  const rows = data || [];
  const messages = rows.map(mapMessage);

  // An empty thread is EMPTY, not a thread with no messages rendered as a
  // thread. The caller distinguishes "thread not found" from "read failed".
  if (messages.length === 0) {
    return { ok: true, thread: null, messages: [], reason: "thread_not_found" };
  }

  const last = rows[rows.length - 1];
  const inboundCount = rows.filter((row) => lower(row.direction) === "inbound").length;

  return {
    ok: true,
    thread: {
      ...mapThreadRow({
        thread_id: normalizedThreadId,
        email_address: normalizedThreadId,
        subject: last.subject,
        last_message_at: last.sent_at || last.created_at,
        body_preview: last.email_body,
        message_count: messages.length,
        folder: lower(last.direction) === "inbound" ? "new_replies" : "sent",
        unread: lower(last.direction) === "inbound",
      }),
      messages,
      inbound_count: inboundCount,
      outbound_count: messages.length - inboundCount,
      property_context: null,
      prospect_context: null,
      ai_summary: null,
      sms_thread_id: null,
    },
    messages,
  };
}

export async function saveEmailDraft(payload = {}) {
  const db = getDb();
  const recipient = singleRecipient(payload.to || payload.email_address || payload.email);
  if (!recipient.ok) return { ok: false, error: recipient.reason };

  const subject = clean(payload.subject);
  const htmlBody = clean(payload.htmlContent || payload.html_body || payload.body);
  const textBody = clean(payload.textContent || payload.text_body);
  if (!subject) return { ok: false, error: "missing_subject" };
  if (!htmlBody && !textBody) return { ok: false, error: "missing_body" };

  const draft = {
    draft_key: clean(payload.draft_key) || `draft_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    status: "draft",
    email_address: recipient.email,
    to_email: recipient.email,
    from_email: normalizeEmail(payload.sender_email || payload.from_email),
    from_name: clean(payload.sender_name || payload.from_name) || null,
    subject,
    html_body: htmlBody || null,
    text_body: textBody || null,
    prospect_id: clean(payload.prospect_id) || null,
    property_id: clean(payload.property_id) || null,
    master_owner_id: clean(payload.master_owner_id) || null,
    template_id: clean(payload.template_id) || null,
    template_key: clean(payload.template_key) || null,
    metadata: maybeJson(payload.metadata),
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  /**
   * Drafts live in the PROVISIONED queue as queue_status='draft'.
   *
   * This wrote to `email_drafts`, which does not exist in this database, so
   * saving a draft always failed. The provisioned public.email_queue is the
   * one outbound store, so a draft is simply a queue row that dispatch does
   * not pick up.
   *
   * §19 — A DRAFT MUST NEVER TRANSMIT. That is structural here, not a flag:
   * the dispatcher selects on queue_status, 'draft' is not a dispatchable
   * status, and nothing in this function calls the provider. Re-saving the
   * same draft_key UPDATES the row rather than queueing a second copy, so
   * autosave cannot accumulate sends.
   */
  const draftRow = {
    queue_key: `draft:${draft.draft_key}`,
    queue_status: "draft",
    to_email: draft.to_email,
    from_email: draft.from_email || null,
    subject: draft.subject,
    email_body: draft.html_body || draft.text_body || null,
    template_id: draft.template_id,
    prospect_id: draft.prospect_id,
    property_id: draft.property_id,
    master_owner_id: draft.master_owner_id,
    metadata: {
      ...(draft.metadata || {}),
      draft_key: draft.draft_key,
      direction: "outbound",
      from_name: draft.from_name,
      template_key: draft.template_key,
      text_body: draft.text_body,
      is_draft: true,
    },
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };

  const { data, error } = await db
    .from("email_queue")
    .upsert(draftRow, { onConflict: "queue_key" })
    .select("*")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: "email_draft_insert_failed",
      message: clean(error?.message) || "email_draft_insert_failed",
    };
  }

  return {
    ok: true,
    draft_id: clean(data?.id) || null,
    draft_key: draft.draft_key,
    status: "draft",
    sent: false,
    draft: data || draftRow,
    message: "Draft saved",
  };
}

/**
 * public.email_senders stores the address in `from_email`, not `sender_email`.
 * A lookup by "sender_email" therefore fails with a phantom-column error, and
 * because the caller swallows the error it would silently report "no sender
 * configured" even once a sender row existed. The column name is mapped to
 * the real schema, and a failed READ is distinguished from "not found" so a
 * broken query can never masquerade as an absent sender.
 */
const SENDER_COLUMN_ALIASES = {
  sender_email: "from_email",
  email: "from_email",
};

async function lookupSenderByColumn(db, column, value) {
  if (!clean(value)) return null;
  const realColumn = SENDER_COLUMN_ALIASES[column] || column;
  const { data, error } = await db
    .from("email_senders")
    .select("*")
    .eq(realColumn, value)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    // Surfaced rather than folded into null, which would read as "no sender".
    return { __lookup_failed: true, error };
  }
  return data || null;
}

async function resolveSenderIdentity(payload = {}) {
  const db = getDb();
  const directEmail = normalizeEmail(payload.sender?.email || payload.sender_email || payload.from_email);
  if (directEmail) {
    if (!isValidEmail(directEmail)) return { ok: false, reason: "invalid_sender_email" };
    return {
      ok: true,
      sender: {
        email: directEmail,
        name: clean(payload.sender?.name || payload.sender_name || payload.from_name) ||
          clean(process.env.BREVO_SENDER_NAME) ||
          clean(process.env.EMAIL_DEFAULT_SENDER_NAME) ||
          "Acquisitions Team",
        reply_to_email: normalizeEmail(payload.reply_to_email || payload.replyTo?.email) || null,
      },
      source: "payload",
    };
  }

  const requested = clean(payload.from_identity || payload.sender_id || payload.sender_key);
  let sender = null;
  if (/^[0-9a-f-]{36}$/i.test(requested)) sender = await lookupSenderByColumn(db, "id", requested);
  if (!sender && requested) sender = await lookupSenderByColumn(db, "sender_key", requested);
  if (!sender && isValidEmail(requested)) sender = await lookupSenderByColumn(db, "sender_email", lower(requested));

  if (!sender && requested) {
    try {
      const { data } = await db
        .from("email_identities")
        .select("sender_name, sender_email, reply_to_email, brand_key, is_active")
        .eq("brand_key", requested)
        .eq("is_active", true)
        .maybeSingle();
      sender = data || null;
    } catch {
      sender = null;
    }
  }

  if (sender?.__lookup_failed) {
    return { ok: false, reason: "sender_lookup_failed", error: sender.error };
  }

  // email_senders.from_email is the real column; expose it under the name the
  // rest of this function already uses.
  if (sender && !sender.sender_email && sender.from_email) {
    sender = { ...sender, sender_email: sender.from_email };
  }

  if (sender?.sender_email) {
    return {
      ok: true,
      sender: {
        email: normalizeEmail(sender.sender_email),
        name: clean(sender.sender_name) || "Acquisitions Team",
        reply_to_email: normalizeEmail(sender.reply_to_email) || null,
      },
      source: "email_senders",
    };
  }

  const envEmail =
    normalizeEmail(process.env.BREVO_SENDER_EMAIL) ||
    normalizeEmail(process.env.EMAIL_DEFAULT_SENDER_EMAIL);
  if (envEmail) {
    return {
      ok: true,
      sender: {
        email: envEmail,
        name:
          clean(process.env.BREVO_SENDER_NAME) ||
          clean(process.env.EMAIL_DEFAULT_SENDER_NAME) ||
          "Acquisitions Team",
        reply_to_email: normalizeEmail(process.env.EMAIL_DEFAULT_REPLY_TO) || null,
      },
      source: "env",
    };
  }

  return { ok: false, reason: "sender_identity_missing" };
}

export async function checkEmailSuppression(email) {
  const db = getDb();
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, suppressed: false, reason: "missing_email" };
  if (!isValidEmail(normalized)) return { ok: false, suppressed: false, reason: "invalid_email" };

  const { data, error } = await db
    .from("email_suppression")
    .select("*")
    .eq("email_address", normalized)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      suppressed: false,
      reason: "suppression_lookup_failed",
      message: clean(error?.message) || "suppression_lookup_failed",
    };
  }

  if (data && data.is_active !== false) {
    return {
      ok: true,
      suppressed: true,
      reason: normalizeSuppressionReason(data.reason || data.suppression_status),
      suppression: data,
    };
  }

  const { data: events, error: eventError } = await db
    .from("email_events")
    .select("event_type, created_at, raw_payload")
    .eq("email_address", normalized)
    .in("event_type", Array.from(SUPPRESSION_EVENT_TYPES))
    .order("created_at", { ascending: false })
    .limit(1);

  if (eventError) {
    return {
      ok: true,
      suppressed: false,
      warning: clean(eventError?.message) || "email_event_suppression_lookup_failed",
    };
  }

  const event = events?.[0] || null;
  if (event) {
    return {
      ok: true,
      suppressed: true,
      reason: normalizeSuppressionReason(event.event_type),
      suppression: event,
    };
  }

  return { ok: true, suppressed: false, reason: "none", suppression: null };
}

/**
 * The durable outbound record.
 *
 * This wrote to `email_messages`, which does not exist in this database, so
 * every manual send failed with email_message_insert_failed. It now writes the
 * PROVISIONED queue, public.email_queue, mapped to its real columns.
 *
 * Note what does NOT need a column: thread identity. A thread is keyed by the
 * counterparty address (see get_email_threads), and that is `to_email` here,
 * so the queue row already threads correctly without a thread_id column.
 *
 * §18 IDEMPOTENCY. email_queue.queue_key is UNIQUE. A repeated send therefore
 * cannot create a second row — and because dispatch reads the queue, it cannot
 * create a second provider send either. A duplicate is reported as
 * `already_queued` rather than as an error, so a double-tap is a no-op instead
 * of a second email.
 */
function buildEmailQueueKey({ recipient, subject, body, idempotencyKey }) {
  if (clean(idempotencyKey)) return `manual:${clean(idempotencyKey)}`;
  // With no explicit key, collapse repeats of the SAME content inside one
  // minute (a double submit) while still allowing a deliberate resend later.
  const bucket = Math.floor(Date.now() / 60000);
  const digest = crypto
    .createHash("sha256")
    .update([lower(recipient), clean(subject), clean(body), bucket].join("|"))
    .digest("hex")
    .slice(0, 32);
  return `manual:${digest}`;
}

async function insertEmailMessage(db, row) {
  const queueRow = {
    queue_key: row.queue_key,
    queue_status: row.status,
    to_email: row.to_email,
    from_email: row.from_email,
    subject: row.subject,
    email_body: row.html_body || row.text_body || null,
    template_id: row.template_id || null,
    prospect_id: row.prospect_id || null,
    property_id: row.property_id || null,
    master_owner_id: row.master_owner_id || null,
    scheduled_for: row.scheduled_for || null,
    metadata: {
      ...(row.metadata || {}),
      thread_id: row.thread_id,
      direction: row.direction,
      from_name: row.from_name,
      reply_to_email: row.reply_to_email,
      template_key: row.template_key || null,
      text_body: row.text_body || null,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  const { data, error } = await db.from("email_queue").insert(queueRow).select("*").maybeSingle();

  if (error) {
    // 23505 = unique violation on queue_key: this exact send is already queued.
    const code = clean(error?.code);
    if (code === "23505") {
      const existing = await db
        .from("email_queue")
        .select("*")
        .eq("queue_key", queueRow.queue_key)
        .maybeSingle();
      return { ok: true, message: existing.data || queueRow, already_queued: true };
    }
    return { ok: false, error };
  }
  return { ok: true, message: data || queueRow };
}

/** Patches the durable outbound row in the provisioned queue. */
async function updateEmailMessage(db, id, patch) {
  if (!id) return { ok: false, error: "missing_message_id" };
  const queuePatch = {};
  if (patch.status !== undefined) queuePatch.queue_status = patch.status;
  if (patch.provider_message_id !== undefined) queuePatch.provider_message_id = patch.provider_message_id;
  if (patch.sent_at !== undefined) queuePatch.sent_at = patch.sent_at;
  if (patch.delivered_at !== undefined) queuePatch.delivered_at = patch.delivered_at;
  if (patch.failure_reason !== undefined) queuePatch.failed_reason = patch.failure_reason;
  queuePatch.updated_at = nowIso();
  const { error } = await db.from("email_queue").update(queuePatch).eq("id", id);
  return { ok: !error, error };
}

/**
 * The event ledger, written in the REAL public.email_events shape.
 *
 * The rows built by this module carry the Brevo-design columns
 * (email_address, brevo_message_id, template_key, campaign_key, raw_payload,
 * provider_event_id, message_id, event_at, updated_at). None of those exist on
 * the provisioned table, whose columns are event_key, direction, event_type,
 * to_email, from_email, subject, email_body, queue_id, metadata, created_at,
 * sent_at, delivered_at, failed_at, error_message and the open/click counters.
 * So every manual send failed with email_event_insert_failed.
 *
 * Unmapped fields are preserved inside `metadata` rather than dropped, so no
 * provenance is lost. `event_key` is UNIQUE, which is what makes replaying the
 * same provider event idempotent (§18).
 */
const EMAIL_EVENT_COLUMNS = new Set([
  "event_key", "provider_message_id", "direction", "event_type", "to_email",
  "from_email", "subject", "email_body", "queue_id", "metadata", "created_at",
  "sent_at", "delivered_at", "failed_at", "error_message", "opened_at",
  "open_count", "clicked_at", "click_count", "tracking_pixel_id",
]);

function toEmailEventRow(row = {}) {
  const mapped = {
    event_key: row.event_key,
    event_type: row.event_type,
    direction: row.direction || "outbound",
    to_email: row.to_email || row.email_address || null,
    from_email: row.from_email || null,
    subject: row.subject || null,
    email_body: row.email_body || row.html_body || row.text_body || null,
    provider_message_id: row.provider_message_id || row.brevo_message_id || null,
    queue_id: row.queue_id || row.message_id || null,
    created_at: row.created_at || nowIso(),
    sent_at: row.sent_at || null,
    delivered_at: row.delivered_at || null,
    failed_at: row.failed_at || null,
    error_message: row.error_message || row.failure_reason || null,
  };

  // Anything the real table has no column for is kept, not discarded.
  const extras = {};
  for (const [key, value] of Object.entries(row)) {
    if (!EMAIL_EVENT_COLUMNS.has(key) && value !== undefined && value !== null) extras[key] = value;
  }
  mapped.metadata = { ...(maybeJson(row.metadata) || {}), ...extras };
  return mapped;
}

async function upsertEmailEvent(db, row) {
  const { error } = await db
    .from("email_events")
    .upsert(toEmailEventRow(row), { onConflict: "event_key" });
  return { ok: !error, error };
}

async function upsertSuppression(db, normalizedEvent) {
  const email = normalizeEmail(normalizedEvent.email_address);
  if (!email) return { ok: false, reason: "missing_email" };

  const row = {
    email_address: email,
    reason: normalizeSuppressionReason(normalizedEvent.event_type),
    suppression_status: normalizeSuppressionReason(normalizedEvent.event_type),
    source: "brevo_webhook",
    is_active: true,
    raw_payload: normalizedEvent.raw_payload || {},
    metadata: {
      provider: "brevo",
      provider_message_id: normalizedEvent.provider_message_id || null,
      event_key: normalizedEvent.event_key,
    },
    last_event_at: normalizedEvent.event_at || nowIso(),
    updated_at: nowIso(),
  };

  const { error } = await db.from("email_suppression").upsert(row, { onConflict: "email_address" });
  if (!error) return { ok: true };

  const legacyRow = {
    email_address: row.email_address,
    reason: row.reason,
    source: row.source,
    raw_payload: row.raw_payload,
  };
  const retry = await db.from("email_suppression").upsert(legacyRow, { onConflict: "email_address" });
  return { ok: !retry.error, error: retry.error || error };
}

export async function sendManualEmail(payload = {}, options = {}) {
  const recipient = singleRecipient(payload.to || payload.email || payload.email_address);
  if (!recipient.ok) {
    return { ok: false, sent: false, error: recipient.reason };
  }

  const subject = clean(payload.subject);
  const htmlBody = clean(payload.htmlContent || payload.html_body || payload.body_html || payload.body);
  const textBody = clean(payload.textContent || payload.text_body || payload.body_text);
  if (!subject) return { ok: false, sent: false, error: "missing_subject" };
  if (!htmlBody && !textBody) return { ok: false, sent: false, error: "missing_body" };

  /**
   * §13 — SUPPRESSION IS THE FIRST GATE.
   *
   * Sender identity used to be resolved first, so sending to a suppressed
   * address reported `sender_identity_missing`. That is the wrong refusal: it
   * hides the compliance reason behind a configuration one, and it means the
   * suppression guard is only reached once a sender exists — configure a
   * sender and you would discover the suppression only afterwards. Whether we
   * may contact this person at all does not depend on which mailbox we would
   * send from, so it is decided first and reported as itself.
   */
  const suppression = await checkEmailSuppression(recipient.email);
  if (!suppression.ok) {
    return {
      ok: false,
      sent: false,
      error: suppression.reason || "suppression_check_failed",
      message: suppression.message || null,
    };
  }
  if (suppression.suppressed) {
    return {
      ok: false,
      sent: false,
      blocked: true,
      error: "email_suppressed",
      suppression,
    };
  }

  const sender = await resolveSenderIdentity(payload);
  if (!sender.ok) {
    return { ok: false, sent: false, error: sender.reason || "sender_identity_missing" };
  }

  const db = getDb();
  const threadId = clean(payload.thread_id) || `email:${recipient.email}`;
  const sendEnabled = bool(process.env.EMAIL_SEND_ENABLED);
  const dryRun = Boolean(options.dry_run || !sendEnabled);
  const queueKey = buildEmailQueueKey({
    recipient: recipient.email,
    subject,
    body: htmlBody || textBody || "",
    idempotencyKey: payload.idempotency_key || payload.idempotencyKey,
  });
  const messageRow = {
    queue_key: queueKey,
    thread_id: threadId,
    direction: "outbound",
    status: dryRun ? "no_send" : "pending_send",
    provider: "brevo",
    email_address: recipient.email,
    to_email: recipient.email,
    from_email: sender.sender.email,
    from_name: sender.sender.name,
    reply_to_email: sender.sender.reply_to_email,
    subject,
    html_body: htmlBody || null,
    text_body: textBody || null,
    prospect_id: clean(payload.prospect_id) || null,
    property_id: clean(payload.property_id) || null,
    master_owner_id: clean(payload.master_owner_id) || null,
    template_id: clean(payload.template_id) || null,
    template_key: clean(payload.template_key) || null,
    metadata: {
      ...(maybeJson(payload.metadata)),
      manual_send: true,
      dry_run: dryRun,
      sender_source: sender.source,
    },
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const inserted = await insertEmailMessage(db, messageRow);
  if (!inserted.ok) {
    return {
      ok: false,
      sent: false,
      error: "email_message_insert_failed",
      message: clean(inserted.error?.message) || "email_message_insert_failed",
    };
  }

  const messageId = clean(inserted.message?.id);
  // A duplicate submit is reported honestly and does NOT proceed to dispatch.
  if (inserted.already_queued) {
    return {
      ok: true,
      sent: false,
      duplicate: true,
      already_queued: true,
      message_id: messageId,
      thread_id: threadId,
      queue_key: queueKey,
      status: clean(inserted.message?.queue_status) || "queued",
      reason: "already_queued",
    };
  }
  const requestedEvent = {
    event_key: eventKey("manual_email_requested", {
      messageId,
      to: recipient.email,
      subject,
      at: nowIso(),
    }),
    provider: "brevo",
    direction: "outbound",
    queue_id: messageId || null,
    to_email: recipient.email,
    from_email: sender.sender.email,
    event_type: dryRun ? "manual_send_no_send" : "manual_send_requested",
    subject,
    template_key: clean(payload.template_key) || null,
    campaign_key: clean(payload.campaign_key) || null,
    raw_payload: { dry_run: dryRun, no_send: dryRun },
    metadata: { manual_send: true },
    event_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const eventInsert = await upsertEmailEvent(db, requestedEvent);
  if (!eventInsert.ok) {
    return {
      ok: false,
      sent: false,
      error: "email_event_insert_failed",
      message: clean(eventInsert.error?.message) || "email_event_insert_failed",
      // The queue row was already written. Leaving it at no_send/pending would
      // strand a row that looks actionable, so it is marked failed with the
      // reason rather than left to be picked up or counted as pending.
      queue_row_marked_failed: (
        await updateEmailMessage(db, messageId, {
          status: "failed",
          failure_reason: clean(eventInsert.error?.message) || "email_event_insert_failed",
        })
      ).ok,
      message_id: messageId || null,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      sent: false,
      dry_run: true,
      no_send: true,
      reason: "email_send_disabled",
      message_id: messageId || null,
      thread_id: threadId,
    };
  }

  const sendResult = await getSendBrevo()({
    to: recipient.email,
    subject,
    htmlContent: htmlBody,
    textContent: textBody,
    sender: { name: sender.sender.name, email: sender.sender.email },
    replyTo: sender.sender.reply_to_email ? { email: sender.sender.reply_to_email } : null,
    tags: ["manual_email", clean(payload.template_key)].filter(Boolean),
    params: maybeJson(payload.params),
  });

  if (!sendResult?.ok || !sendResult?.sent) {
    await updateEmailMessage(db, messageId, {
      status: "failed",
      failure_reason: clean(sendResult?.error?.code || sendResult?.reason) || "brevo_send_failed",
      updated_at: nowIso(),
    });
    await upsertEmailEvent(db, {
      ...requestedEvent,
      event_key: eventKey("manual_email_failed", { messageId, sendResult, at: nowIso() }),
      event_type: "manual_send_failed",
      raw_payload: sendResult || {},
      updated_at: nowIso(),
    });
    return {
      ok: false,
      sent: false,
      error: clean(sendResult?.error?.code || sendResult?.reason) || "brevo_send_failed",
      provider_error: sendResult?.error || null,
      message_id: messageId || null,
    };
  }

  await updateEmailMessage(db, messageId, {
    status: "sent",
    provider_message_id: clean(sendResult.message_id) || null,
    brevo_message_id: clean(sendResult.message_id) || null,
    sent_at: nowIso(),
    updated_at: nowIso(),
  });
  await upsertEmailEvent(db, {
    ...requestedEvent,
    event_key: eventKey("manual_email_sent", { messageId, provider: sendResult.message_id, at: nowIso() }),
    provider_message_id: clean(sendResult.message_id) || null,
    brevo_message_id: clean(sendResult.message_id) || null,
    event_type: "sent",
    raw_payload: sendResult.raw_response || {},
    updated_at: nowIso(),
  });

  return {
    ok: true,
    sent: true,
    dry_run: false,
    provider: "brevo",
    provider_message_id: clean(sendResult.message_id) || null,
    message_id: messageId || null,
    thread_id: threadId,
  };
}

function eventTypeOf(payload = {}) {
  const raw = lower(payload.event || payload.event_type || payload.type || payload.status);
  if (["delivered", "delivery"].includes(raw)) return "delivered";
  if (["open", "opened", "unique_opened"].includes(raw)) return "opened";
  if (["click", "clicked"].includes(raw)) return "clicked";
  if (["reply", "replied", "inbound", "response"].includes(raw)) return "replied";
  if (["unsubscribe", "unsubscribed", "list_unsubscribe"].includes(raw)) return "unsubscribed";
  if (["spam", "complaint", "abuse"].includes(raw)) return "spam";
  if (["blocked", "block"].includes(raw)) return "blocked";
  if (["hard_bounce", "soft_bounce", "bounce", "bounced", "invalid_email"].includes(raw)) {
    return "bounced";
  }
  if (["request", "sent", "deferred"].includes(raw)) return "sent";
  return raw || "unknown";
}

function providerMessageIdOf(payload = {}) {
  return firstNonEmpty(
    payload["message-id"],
    payload.messageId,
    payload.message_id,
    payload.brevo_message_id,
    payload.uuid
  ) || null;
}

function emailOf(payload = {}) {
  return normalizeEmail(payload.email || payload.recipient || payload.to || payload.to_email) || null;
}

function eventTimeOf(payload = {}) {
  const value = firstNonEmpty(payload.date, payload.event_at, payload.ts, payload.timestamp, payload.created_at);
  if (!value) return nowIso();
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    const millis = number > 9999999999 ? number : number * 1000;
    return new Date(millis).toISOString();
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : nowIso();
}

export function normalizeEmailEvent(event = {}) {
  const payload = maybeJson(event);
  const normalized = {
    provider: "brevo",
    provider_event_id: firstNonEmpty(payload.id, payload.event_id, payload.uuid) || null,
    provider_message_id: providerMessageIdOf(payload),
    brevo_message_id: providerMessageIdOf(payload),
    email_address: emailOf(payload),
    event_type: eventTypeOf(payload),
    original_event_type: lower(payload.event || payload.event_type || payload.type || payload.status) || null,
    subject: clean(payload.subject) || null,
    template_key: clean(payload.template_key || payload.tag || payload.tags?.[0]) || null,
    campaign_key: clean(payload.campaign_key || payload.campaign) || null,
    event_at: eventTimeOf(payload),
    raw_payload: payload,
    metadata: {
      reason: clean(payload.reason || payload.message || payload.error) || null,
      link: clean(payload.link || payload.url) || null,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
    },
  };

  normalized.event_key = firstNonEmpty(payload.event_key, payload.id, payload.uuid) ||
    eventKey("brevo_event", {
      provider_message_id: normalized.provider_message_id,
      email: normalized.email_address,
      event_type: normalized.event_type,
      event_at: normalized.event_at,
      raw: payload,
    });

  return normalized;
}

async function updateMessageForEvent(db, normalized) {
  const providerMessageId = clean(normalized.provider_message_id);
  if (!providerMessageId) return { ok: true, skipped: true };

  const patch = { updated_at: nowIso() };
  const type = lower(normalized.event_type);
  if (type === "delivered") {
    patch.status = "delivered";
    patch.delivered_at = normalized.event_at;
  } else if (type === "opened") {
    patch.status = "opened";
    patch.opened_at = normalized.event_at;
  } else if (type === "clicked") {
    patch.status = "clicked";
    patch.clicked_at = normalized.event_at;
  } else if (type === "replied") {
    patch.replied_at = normalized.event_at;
  } else if (type === "bounced") {
    patch.status = "bounced";
    patch.bounced_at = normalized.event_at;
    patch.failure_reason = normalizeSuppressionReason(normalized.original_event_type || normalized.event_type);
  } else if (type === "unsubscribed") {
    patch.status = "unsubscribed";
    patch.unsubscribed_at = normalized.event_at;
  } else if (type === "spam") {
    patch.status = "spam";
    patch.spam_at = normalized.event_at;
  } else if (type === "blocked") {
    patch.status = "blocked";
    patch.blocked_at = normalized.event_at;
  } else if (type === "sent") {
    patch.status = "sent";
  }

  /**
   * Provider callbacks reconcile against the provisioned queue by
   * provider_message_id. Status names map onto the queue's own column; the
   * timestamp columns the Brevo design assumed (opened_at/clicked_at/...) do
   * not exist there, so those live on the event row in email_events, which is
   * where the ledger belongs anyway.
   */
  const queuePatch = { updated_at: nowIso() };
  if (patch.status !== undefined) queuePatch.queue_status = patch.status;
  if (patch.sent_at !== undefined) queuePatch.sent_at = patch.sent_at;
  if (patch.delivered_at !== undefined) queuePatch.delivered_at = patch.delivered_at;
  if (patch.failure_reason !== undefined) queuePatch.failed_reason = patch.failure_reason;

  const { error } = await db
    .from("email_queue")
    .update(queuePatch)
    .eq("provider_message_id", providerMessageId);

  return { ok: !error, error };
}

export async function handleBrevoWebhookEvents(events = []) {
  const db = getDb();
  const list = Array.isArray(events) ? events : events ? [events] : [];
  const results = [];

  for (const event of list) {
    const normalized = normalizeEmailEvent(event);
    const eventRow = {
      event_key: normalized.event_key,
      provider: "brevo",
      provider_event_id: normalized.provider_event_id,
      provider_message_id: normalized.provider_message_id,
      brevo_message_id: normalized.provider_message_id,
      email_address: normalized.email_address,
      event_type: normalized.event_type,
      subject: normalized.subject,
      template_key: normalized.template_key,
      campaign_key: normalized.campaign_key,
      raw_payload: normalized.raw_payload,
      metadata: normalized.metadata,
      event_at: normalized.event_at,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    const eventInsert = await upsertEmailEvent(db, eventRow);
    const messageUpdate = await updateMessageForEvent(db, normalized);
    let suppression = { ok: true, skipped: true };
    if (SUPPRESSION_EVENT_TYPES.has(normalized.event_type)) {
      suppression = await upsertSuppression(db, normalized);
    }

    results.push({
      ok: eventInsert.ok,
      event_key: normalized.event_key,
      event_type: normalized.event_type,
      email_address: normalized.email_address,
      provider_message_id: normalized.provider_message_id,
      message_updated: Boolean(messageUpdate.ok && !messageUpdate.skipped),
      suppressed: Boolean(suppression.ok && !suppression.skipped),
      warnings: [
        eventInsert.ok ? null : clean(eventInsert.error?.message) || "email_event_upsert_failed",
        messageUpdate.ok ? null : clean(messageUpdate.error?.message) || "email_message_update_failed",
        suppression.ok ? null : clean(suppression.error?.message) || "email_suppression_upsert_failed",
      ].filter(Boolean),
    });
  }

  return {
    ok: results.every((result) => result.ok),
    events_received: list.length,
    results,
  };
}

export async function getEmailTemplates(filters = {}) {
  const db = getDb();
  /**
   * `email_templates` in production is the war-room/sms_templates shape:
   * template_id, template_name, use_case, language, subject, template_body.
   * There is NO template_key column, so ordering by it answered every request
   * with `column email_templates.template_key does not exist` (HTTP 500).
   * The unapplied Brevo migration would not have fixed it either: its CREATE
   * TABLE is IF NOT EXISTS, so it is skipped for the table that already
   * exists. The code reads the real shape instead.
   */
  let query = db
    .from("email_templates")
    .select("*")
    .order("template_name", { ascending: true, nullsFirst: false })
    .limit(asLimit(filters.limit, 100, 500));

  if (filters.active !== false) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) {
    return {
      ok: false,
      error: "email_templates_query_failed",
      message: clean(error?.message) || "email_templates_query_failed",
      templates: [],
    };
  }

  const templates = (data || []).map((row) => ({
    id: clean(row.id || row.template_id || row.template_key),
    name: clean(row.template_name || row.name || row.stage_label || row.template_id),
    category: lower(row.category || row.use_case || "first_touch"),
    // Kept for callers that still read it; empty when the column is absent.
    template_key: clean(row.template_key || row.template_id),
    template_id: clean(row.template_id),
    subject: clean(row.subject),
    // template_body is the real column; the others are legacy fallbacks.
    body_preview: messagePreview(row.template_body || row.text_body || row.html_body),
    body: clean(row.template_body || row.html_body || row.text_body),
    language: clean(row.language) || null,
    use_case: clean(row.use_case) || null,
    stage_code: clean(row.stage_code) || null,
    merge_fields: Array.isArray(row.variables) ? row.variables : [],
    last_used: clean(row.last_used_at) || null,
    usage_count: Number(row.usage_count || 0),
    is_active: row.is_active !== false,
    metadata: maybeJson(row.metadata),
  }));

  return { ok: true, templates };
}

export default {
  getEmailOverview,
  getEmailRecords,
  getEmailThread,
  getEmailThreads,
  saveEmailDraft,
  sendManualEmail,
  normalizeEmailEvent,
  handleBrevoWebhookEvents,
  checkEmailSuppression,
  getEmailTemplates,
};
