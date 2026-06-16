import crypto from "node:crypto";

import { supabase as defaultSupabase } from "../lib/supabase/client.js";
import {
  getBrevoHealth,
  sendBrevoTransactionalEmail,
} from "../lib/domain/email/brevo-provider.js";

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

function mapMessage(row = {}) {
  const status = lower(row.status);
  return {
    id: clean(row.id || row.message_id),
    direction: lower(row.direction) === "inbound" ? "inbound" : "outbound",
    from_address: normalizeEmail(row.from_email || row.from_address),
    to_address: normalizeEmail(row.to_email || row.to_address || row.email_address),
    subject: clean(row.subject),
    body_preview: messagePreview(row.body_preview || row.text_body || row.html_body),
    body_html: clean(row.html_body || row.body_html) || null,
    sent_at: clean(row.sent_at || row.created_at) || null,
    opened: Boolean(row.opened_at || status === "opened"),
    clicked: Boolean(row.clicked_at || status === "clicked"),
    bounced: Boolean(row.bounced_at || status === "bounced" || status === "failed"),
    status,
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

export async function getEmailRecords(filters = {}) {
  const db = getDb();
  const limit = asLimit(filters.limit, 100, 1000);
  const offset = asOffset(filters.offset);

  let query = db
    .from("v_email_records")
    .select("*", { count: "exact" })
    .order("email_rank", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  const search = clean(filters.search || filters.q);
  if (search) {
    const like = `%${search.replace(/[,%()]/g, " ")}%`;
    query = query.or(`email.ilike.${like},owner_name.ilike.${like},property_address.ilike.${like}`);
  }

  if (clean(filters.market) && lower(filters.market) !== "all") {
    query = query.eq("market", clean(filters.market));
  }

  if (clean(filters.suppression) && lower(filters.suppression) !== "all") {
    query = query.eq("suppression_status", lower(filters.suppression));
  }

  if (clean(filters.confidence) && lower(filters.confidence) !== "all") {
    query = query.eq("email_match_confidence", lower(filters.confidence));
  }

  if (clean(filters.eligibility) && lower(filters.eligibility) !== "all") {
    query = lower(filters.eligibility) === "eligible"
      ? query.eq("suppression_status", "none")
      : query.not("suppression_status", "eq", "none");
  }

  const { data, error, count } = await query;
  if (error) {
    return {
      ok: false,
      error: "email_records_query_failed",
      message: clean(error?.message) || "email_records_query_failed",
      records: [],
    };
  }

  const records = (data || []).map(mapRecord);
  return {
    ok: true,
    records,
    count: count ?? records.length,
    limit,
    offset,
  };
}

export async function getEmailOverview() {
  const [recordsResult, health] = await Promise.all([
    getEmailRecords({ limit: 5000 }),
    getBrevoHealth(),
  ]);

  const db = getDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const records = recordsResult.ok ? recordsResult.records : [];
  const [{ data: eventRows = [] } = {}, { data: messageRows = [] } = {}] = await Promise.all([
    db.from("email_events").select("event_type, email_address, created_at").gte("created_at", todayIso).limit(1000),
    db.from("email_messages").select("direction, status, sent_at, created_at").gte("created_at", todayIso).limit(1000),
  ]).catch(() => [{ data: [] }, { data: [] }]);

  const suppressed = records.filter((row) => row.suppression_status !== "none").length;
  const bounced = records.filter((row) => row.suppression_status === "bounced").length;
  const unsubscribed = records.filter((row) => row.suppression_status === "unsubscribed").length;
  const sentToday = (messageRows || []).filter((row) => lower(row.direction) === "outbound").length;
  const repliesToday =
    (messageRows || []).filter((row) => lower(row.direction) === "inbound").length ||
    (eventRows || []).filter((row) => lower(row.event_type) === "replied").length;

  return {
    ok: true,
    total_emails: records.length,
    email_eligible: records.filter((row) => row.eligibility === "eligible").length,
    high_confidence: records.filter((row) => row.email_match_confidence === "high").length,
    suppressed,
    bounced,
    unsubscribed,
    sent_today: sentToday,
    replies_today: repliesToday,
    ready_for_campaign: records.filter(
      (row) => row.eligibility === "eligible" && row.suppression_status === "none"
    ).length,
    brevo_status: health.connected ? "connected" : health.missing?.length ? "disconnected" : "degraded",
    brevo_health: health,
    records_warning: recordsResult.ok ? null : recordsResult.message,
    last_updated: nowIso(),
  };
}

export async function getEmailThreads(filters = {}) {
  const db = getDb();
  const limit = asLimit(filters.limit, 100, 500);
  const folder = lower(filters.folder || "all");

  const { data, error } = await db
    .from("email_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit * 5);

  if (error) {
    return {
      ok: false,
      error: "email_threads_query_failed",
      message: clean(error?.message) || "email_threads_query_failed",
      threads: [],
    };
  }

  const byThread = new Map();
  for (const row of data || []) {
    const key = clean(row.thread_id || row.id);
    if (!key) continue;
    const existing = byThread.get(key);
    if (!existing) {
      byThread.set(key, {
        ...row,
        message_count: 1,
        folder: lower(row.direction) === "inbound" ? "new_replies" : lower(row.status) || "all",
      });
    } else {
      existing.message_count += 1;
    }
  }

  let threads = Array.from(byThread.values()).map(mapThreadRow);
  if (folder && folder !== "all") threads = threads.filter((thread) => thread.folder === folder);

  const search = lower(filters.search || filters.q);
  if (search) {
    threads = threads.filter((thread) => {
      return (
        lower(thread.email_address).includes(search) ||
        lower(thread.subject).includes(search) ||
        lower(thread.prospect_name).includes(search)
      );
    });
  }

  return {
    ok: true,
    threads: threads.slice(0, limit),
    count: threads.length,
  };
}

export async function getEmailThread(threadId) {
  const db = getDb();
  const normalizedThreadId = clean(threadId);
  if (!normalizedThreadId) {
    return { ok: false, error: "missing_thread_id", messages: [] };
  }

  const { data, error } = await db
    .from("email_messages")
    .select("*")
    .eq("thread_id", normalizedThreadId)
    .order("created_at", { ascending: true });

  if (error) {
    return {
      ok: false,
      error: "email_thread_query_failed",
      message: clean(error?.message) || "email_thread_query_failed",
      messages: [],
    };
  }

  const messages = (data || []).map(mapMessage);
  const latest = messages[messages.length - 1] || null;

  return {
    ok: true,
    thread: latest
      ? {
          ...mapThreadRow({
            ...data[data.length - 1],
            thread_id: normalizedThreadId,
            message_count: messages.length,
          }),
          messages,
          property_context: null,
          prospect_context: null,
          ai_summary: null,
          sms_thread_id: null,
        }
      : null,
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

  const { data, error } = await db.from("email_drafts").insert(draft).select("*").maybeSingle();
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
    draft: data || draft,
    message: "Draft saved",
  };
}

async function lookupSenderByColumn(db, column, value) {
  if (!clean(value)) return null;
  const { data, error } = await db
    .from("email_senders")
    .select("*")
    .eq(column, value)
    .eq("is_active", true)
    .maybeSingle();

  if (error) return null;
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

async function insertEmailMessage(db, row) {
  const { data, error } = await db.from("email_messages").insert(row).select("*").maybeSingle();
  if (error) return { ok: false, error };
  return { ok: true, message: data || row };
}

async function updateEmailMessage(db, id, patch) {
  if (!id) return { ok: false, error: "missing_message_id" };
  const { error } = await db.from("email_messages").update(patch).eq("id", id);
  return { ok: !error, error };
}

async function upsertEmailEvent(db, row) {
  const { error } = await db.from("email_events").upsert(row, { onConflict: "event_key" });
  if (!error) return { ok: true };

  const legacyRow = {
    event_key: row.event_key,
    brevo_message_id: row.brevo_message_id || row.provider_message_id || null,
    email_address: row.email_address,
    event_type: row.event_type,
    subject: row.subject || null,
    template_key: row.template_key || null,
    campaign_key: row.campaign_key || null,
    raw_payload: row.raw_payload || {},
    created_at: row.created_at || nowIso(),
  };
  const retry = await db.from("email_events").upsert(legacyRow, { onConflict: "event_key" });
  return { ok: !retry.error, error: retry.error || error };
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

  const sender = await resolveSenderIdentity(payload);
  if (!sender.ok) {
    return { ok: false, sent: false, error: sender.reason || "sender_identity_missing" };
  }

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

  const db = getDb();
  const threadId = clean(payload.thread_id) || `email:${recipient.email}`;
  const sendEnabled = bool(process.env.EMAIL_SEND_ENABLED);
  const dryRun = Boolean(options.dry_run || !sendEnabled);
  const messageRow = {
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
  const requestedEvent = {
    event_key: eventKey("manual_email_requested", {
      messageId,
      to: recipient.email,
      subject,
      at: nowIso(),
    }),
    provider: "brevo",
    message_id: messageId || null,
    email_address: recipient.email,
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

  const { error } = await db
    .from("email_messages")
    .update(patch)
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
  let query = db
    .from("email_templates")
    .select("*")
    .order("template_key", { ascending: true })
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
    id: clean(row.id || row.template_key),
    name: clean(row.name || row.stage_label || row.template_key),
    category: lower(row.category || row.use_case || "first_touch"),
    template_key: clean(row.template_key),
    subject: clean(row.subject),
    body_preview: messagePreview(row.text_body || row.html_body),
    body: clean(row.html_body || row.text_body),
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
