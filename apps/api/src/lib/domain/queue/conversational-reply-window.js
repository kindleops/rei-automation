// ─── conversational-reply-window.js ──────────────────────────────────────────
// OWNER DECISION 2026-10-10 (binding): a reply to a seller who JUST texted us
// sends immediately, at any hour. Everything we START — first touches,
// follow-ups, nurture, campaign touches — stays inside the recipient-local
// 08:00–21:00 contact window, unchanged.
//
// INCIDENT 2026-10-10 02:36Z: a Dallas seller texted at 9:36pm CT; the
// auto-reply (template 1009) was queued at once, then the runner's resume
// drain saw a due row outside the local window and re-planned it to 08:22 the
// next morning. A reply to a live conversation is not cold outreach.
//
// A reply is CONVERSATIONAL / IN-SESSION when ALL hold:
//   1. it answers one specific inbound message_events row — an inbound-linked
//      auto-reply, or an operator manual reply that carries the inbound id;
//   2. it was queued within `conversational_reply_window_minutes` (system_control,
//      default 30) of that inbound — and, at dispatch, the session is still
//      inside that window (a reply that sat in a paused queue is backlog);
//   3. it is not a follow-up, nurture or campaign touch.
// A reply queued after the window (held for review and released later, a
// recovery replay of an old inbound) falls back to the normal window.
//
// This ONLY lifts the contact-window deferral. Opt-out / suppression / STOP,
// the legal-threat Needs Review hold, persona and language rules and template
// governance (sms_templates only) all still run on the row, unchanged.
//
// Pure module: no I/O except the optional system_control getter.

import { isManualInboxSend, isInboundAutoReply } from "@/lib/domain/queue/is-manual-inbox-send.js";

export const CONVERSATIONAL_REPLY_WINDOW_KEY = "conversational_reply_window_minutes";
export const DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES = 30;
/** Hard ceiling: a mis-set value can never turn "in session" into "all night". */
export const MAX_CONVERSATIONAL_REPLY_WINDOW_MINUTES = 120;
export const CONTACT_WINDOW_BYPASS_IN_SESSION = "in_session_reply";
export const CONVERSATIONAL_REPLY_WINDOW_VERSION = "conversational_reply_window.v1.2026-10-10";

const clean = (v) => String(v ?? "").trim();
const lower = (v) => clean(v).toLowerCase();
const meta = (row) => (row && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {});

/** A system_control value → window minutes. Blank / invalid / ≤0 → default; capped. */
export function resolveConversationalReplyWindowMinutes(value) {
  const n = Math.trunc(Number(clean(value)));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES;
  return Math.min(n, MAX_CONVERSATIONAL_REPLY_WINDOW_MINUTES);
}

/** Read the window from system_control (read-only). Any failure → the code default. */
export async function loadConversationalReplyWindowMinutes({ getSystemValue = null } = {}) {
  if (typeof getSystemValue !== "function") return DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES;
  try {
    return resolveConversationalReplyWindowMinutes(await getSystemValue(CONVERSATIONAL_REPLY_WINDOW_KEY));
  } catch {
    return DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES;
  }
}

const OUTREACH_KIND = /follow|nurture|campaign|opener|first_touch|reengage|re_engage|restart|drip|cadence|bulk/;

/** Follow-up / nurture / campaign touch — something WE started. Never in-session. */
export function isOutreachTouch(row = {}) {
  const m = meta(row);
  // NB: seller-flow auto-replies are written with message_type "Follow-Up", so
  // message_type is NOT a kind signal — except the bulk "Conversation Restart"
  // shape (manual_scheduled_reply, the 2026-09-11 incident), which is outreach.
  if (lower(row.message_type || m.message_type) === "manual_scheduled_reply") return true;
  const kinds = [row.type, row.send_kind, m.type, m.send_kind, m.source, m.action_type, m.origin_surface, m.created_from]
    .map(lower)
    .filter(Boolean);
  if (kinds.some((k) => OUTREACH_KIND.test(k))) return true;
  if (clean(m.followup_reason) || clean(m.nurture_reason) || clean(m.followup_id)) return true;
  const key = lower(row.queue_key || row.queue_id || m.queue_key);
  if (/^(acq-followup|followup|follow_up|nurture|campaign|fus2|bulk)[:_-]/.test(key)) return true;
  const qc = m.queue_context && typeof m.queue_context === "object" ? m.queue_context : {};
  if (row.is_first_touch === true || m.is_first_touch === true || qc.is_first_touch === true) return true;
  if (qc.is_follow_up === true || qc.is_reengagement === true || m.is_follow_up === true) return true;
  // Structural signals below describe the feeder's rows. The seller-flow
  // immediate reply shape (isInboundAutoReply) is answered by its explicit
  // kind signals above only — it can inherit the thread's campaign anchors.
  if (isInboundAutoReply(row)) return false;
  // A campaign touch carries its campaign target (the feeder's anchor). A bare
  // campaign_id is NOT a signal: auto-replies carry the thread's campaign.
  if (clean(row.campaign_target_id) || clean(m.campaign_target_id)) return true;
  // touch_number on a reply-shaped row is a thread counter (queue_message
  // stamps next-touch on replies too); only a campaign candidate snapshot or
  // a non-reply row makes it a touch kind.
  const snapshot_touch = Number(m.candidate_snapshot?.touch_number);
  if (Number.isFinite(snapshot_touch) && snapshot_touch >= 1) return true;
  if (!isReplyShape(row)) {
    const touch = Number(row.touch_number ?? m.touch_number);
    if (Number.isFinite(touch) && touch >= 1) return true;
  }
  return false;
}

/** A reply shape: an inbound-linked auto-reply, or an operator manual reply. */
export function isReplyShape(row = {}) {
  if (isInboundAutoReply(row)) return true;
  if (isManualInboxSend(row)) return true;
  const kinds = [row.type, meta(row).type].map(lower);
  return kinds.some((k) => k === "auto_reply" || k === "reply" || k === "inbox_reply" || k === "manual_reply");
}

const looksLikePhone = (v) => /^\+?\d{10,15}$/.test(clean(v));

/** The inbound message_events id this row answers (never a phone number). */
export function resolveInboundMessageEventId(row = {}) {
  const m = meta(row);
  for (const v of [
    m.inbound_message_event_id,
    m.conversational_reply?.inbound_message_event_id,
    row.source_event_id,
    m.source_event_id,
    m.inbound_event_id,
    m.queue_context?.inbound_message_event_id,
    m.queue_context?.source_event_id,
    row.inbound_message_id,
    m.inbound_message_id,
  ]) {
    const id = clean(v);
    if (id && !looksLikePhone(id)) return id;
  }
  // The seller-flow immediate reply key: inbound_auto_reply:<inbound event id>:<template>:<phone>.
  const key = clean(row.queue_key || row.queue_id || m.queue_key);
  const from_key = key.startsWith("inbound_auto_reply:") ? clean(key.split(":")[1]) : "";
  if (from_key && !looksLikePhone(from_key)) return from_key;
  return null;
}

/** When the inbound arrived. Stamped rows carry it; legacy immediate auto-replies anchor on created_at. */
export function resolveInboundReceivedAt(row = {}) {
  const m = meta(row);
  for (const v of [m.inbound_received_at, m.conversational_reply?.inbound_received_at, m.queue_context?.inbound_received_at, m.authorized_received_at]) {
    if (Number.isFinite(Date.parse(clean(v)))) return { at: clean(v), basis: "inbound_received_at" };
  }
  // Legacy rows (written before the stamp): the seller-flow immediate reply is
  // inserted synchronously with the inbound, so created_at is the anchor the
  // previous freshness rule already used. Only that exact shape gets it.
  if (isInboundAutoReply(row) && Number.isFinite(Date.parse(clean(row.created_at)))) {
    return { at: clean(row.created_at), basis: "row_created_at" };
  }
  return { at: null, basis: null };
}

const minutesBetween = (later, earlier) => (Date.parse(later) - Date.parse(earlier)) / 60_000;
const round1 = (n) => Math.round(n * 10) / 10;

function verdict(in_session, reason, extra = {}) {
  return { in_session, reason, version: CONVERSATIONAL_REPLY_WINDOW_VERSION, ...extra };
}

/**
 * Pure core. queued_at = when the reply was queued; now = dispatch instant
 * (omit / pass queued_at at queue time).
 */
export function evaluateConversationalReply({
  is_reply = false,
  is_outreach = false,
  inbound_message_event_id = null,
  inbound_received_at = null,
  queued_at = null,
  now = null,
  window_minutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES,
  inbound_basis = "inbound_received_at",
} = {}) {
  const window = resolveConversationalReplyWindowMinutes(window_minutes);
  if (is_outreach) return verdict(false, "outreach_touch", { window_minutes: window });
  if (!is_reply) return verdict(false, "not_a_reply", { window_minutes: window });
  const inbound_id = clean(inbound_message_event_id) || null;
  if (!inbound_id) return verdict(false, "no_inbound_linkage", { window_minutes: window });
  const inbound_at = clean(inbound_received_at);
  if (!Number.isFinite(Date.parse(inbound_at))) {
    return verdict(false, "inbound_time_unknown", { window_minutes: window, inbound_message_event_id: inbound_id });
  }
  const queued = Number.isFinite(Date.parse(clean(queued_at))) ? clean(queued_at) : null;
  if (!queued) return verdict(false, "queued_time_unknown", { window_minutes: window, inbound_message_event_id: inbound_id });
  const at_send = Number.isFinite(Date.parse(clean(now))) ? clean(now) : queued;
  const age_at_queue = minutesBetween(queued, inbound_at);
  const age_at_send = minutesBetween(at_send, inbound_at);
  const base = {
    window_minutes: window,
    inbound_message_event_id: inbound_id,
    inbound_received_at: inbound_at,
    inbound_basis,
    inbound_age_minutes: round1(age_at_send),
    inbound_age_minutes_at_queue: round1(age_at_queue),
  };
  // A small negative age is clock skew between the webhook and the DB; a
  // large one is a data error and fails closed.
  if (age_at_queue < -2 || age_at_send < -2) return verdict(false, "inbound_after_reply", base);
  if (age_at_queue > window) return verdict(false, "queued_after_session_window", base);
  if (age_at_send > window) return verdict(false, "session_window_elapsed_before_dispatch", base);
  return verdict(true, CONTACT_WINDOW_BYPASS_IN_SESSION, base);
}

/** Send-time: is this queue row an in-session reply right now? */
export function evaluateInSessionReply(row = {}, { now = new Date().toISOString(), window_minutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES } = {}) {
  if (!row || typeof row !== "object") return verdict(false, "not_a_reply", { window_minutes: resolveConversationalReplyWindowMinutes(window_minutes) });
  const m = meta(row);
  const inbound = resolveInboundReceivedAt(row);
  return evaluateConversationalReply({
    is_reply: isReplyShape(row),
    is_outreach: isOutreachTouch(row),
    inbound_message_event_id: resolveInboundMessageEventId(row),
    inbound_received_at: inbound.at,
    inbound_basis: inbound.basis,
    queued_at: clean(m.conversational_reply?.queued_at) || clean(row.created_at) || clean(m.created_at) || null,
    now,
    window_minutes,
  });
}

/** Metadata recorded on a row that crosses the window as an in-session reply. */
export function buildInSessionBypassMetadata(evaluation = {}, { stage = "queued", at = null, queued_at = null } = {}) {
  if (evaluation?.in_session !== true) return {};
  return {
    contact_window_bypass: CONTACT_WINDOW_BYPASS_IN_SESSION,
    contact_window_bypass_inbound_message_event_id: evaluation.inbound_message_event_id || null,
    contact_window_bypass_inbound_age_minutes: evaluation.inbound_age_minutes ?? null,
    conversational_reply: {
      stage,
      at: at || null,
      ...(queued_at ? { queued_at } : {}),
      inbound_message_event_id: evaluation.inbound_message_event_id || null,
      inbound_received_at: evaluation.inbound_received_at || null,
      inbound_basis: evaluation.inbound_basis || null,
      inbound_age_minutes: evaluation.inbound_age_minutes ?? null,
      inbound_age_minutes_at_queue: evaluation.inbound_age_minutes_at_queue ?? null,
      window_minutes: evaluation.window_minutes ?? null,
      version: CONVERSATIONAL_REPLY_WINDOW_VERSION,
    },
  };
}

const LABEL_TO_IANA = {
  eastern: "America/New_York", central: "America/Chicago", mountain: "America/Denver",
  pacific: "America/Los_Angeles", alaska: "America/Anchorage", hawaii: "Pacific/Honolulu",
};

/** true / false when the zone is known; null when it is not (never a guess). */
export function isOutsideLocalContactWindow(at, timezone, { start_hour = 8, end_hour = 21 } = {}) {
  const raw = clean(timezone);
  const zone = LABEL_TO_IANA[raw.toLowerCase()] || raw;
  if (!zone.includes("/")) return null;
  const ms = Date.parse(clean(at));
  if (!Number.isFinite(ms)) return null;
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).formatToParts(new Date(ms)).find((p) => p.type === "hour")?.value
    ) % 24;
    return hour < start_hour || hour >= end_hour;
  } catch {
    return null;
  }
}

/**
 * Queue-time stamp for a reply to an inbound (the scheduling layers). Always
 * records the inbound time + the queue-time verdict so the send-time gate can
 * prove "queued within the window"; adds the contact_window_bypass marker when
 * the reply is in session AND the recipient is outside the local window now.
 */
export function buildQueueTimeConversationalReplyMetadata({
  inbound_message_event_id = null,
  inbound_received_at = null,
  queued_at = new Date().toISOString(),
  timezone = null,
  window_minutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES,
  is_outreach = false,
} = {}) {
  const evaluation = evaluateConversationalReply({
    is_reply: true,
    is_outreach,
    inbound_message_event_id,
    inbound_received_at,
    queued_at,
    now: queued_at,
    window_minutes,
  });
  const outside = isOutsideLocalContactWindow(queued_at, timezone);
  return {
    evaluation,
    outside_contact_window: outside,
    metadata: {
      inbound_received_at: clean(inbound_received_at) || null,
      ...(evaluation.in_session && outside === true
        ? buildInSessionBypassMetadata(evaluation, { stage: "queued", at: queued_at, queued_at })
        : {
            conversational_reply: {
              stage: "queued",
              at: queued_at,
              queued_at,
              in_session: evaluation.in_session === true,
              reason: evaluation.reason,
              inbound_message_event_id: evaluation.inbound_message_event_id || clean(inbound_message_event_id) || null,
              inbound_received_at: clean(inbound_received_at) || null,
              inbound_age_minutes_at_queue: evaluation.inbound_age_minutes_at_queue ?? null,
              window_minutes: evaluation.window_minutes ?? null,
              version: CONVERSATIONAL_REPLY_WINDOW_VERSION,
            },
          }),
    },
  };
}

export default evaluateInSessionReply;
