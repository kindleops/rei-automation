/**
 * NEW REPLIES CLEANUP — the send_queue row for a cleanup reply, built to the
 * SAME runner invariants every non-exempt outbound row must satisfy.
 *
 * INCIDENT 2026-10-02 (~19:00Z). The cleanup queued 16 approved late replies
 * with a template_id but no metadata.candidate_snapshot and no seller name.
 * The runner's preclaim check (sms-engine preclaimInvalidQueueRowReason) only
 * waives the snapshot / seller-name requirement for operator inbox sends and
 * unknown-inbound auto-replies; every other outbound row must carry
 *   template reference -> candidate_snapshot -> seller first name.
 * All 16 were paused paused_invalid_queue_row / missing_candidate_snapshot.
 *
 * The fix is NOT a runner exemption. A cleanup reply is not an operator send
 * (the operator exemption also waives the contact window), so it is built the
 * way the Inbox operator send builds its row (dashboard inboxData.ts
 * buildQueuePersonalization: a candidate_snapshot carrying the thread's
 * owner/property/phone identity + the resolved seller first name), using the
 * server's canonical name resolver (feeder resolveSellerIdentity) — and then
 * checked against the runner's OWN functions before anything is written:
 *   validateSendQueueRowPreclaim   the exact preclaim validity check
 *   evaluateContactWindow          the runner's recipient-zone window (D10)
 *   blank-greeting guard           process-send-queue + providers/textgrid
 *   evaluateTemplateAssetGuard     template x property compatibility
 * A row that would fail any of them is HELD with that reason, never queued.
 */
import {
  validateSendQueueRowPreclaim,
  evaluateContactWindow,
  resolveQueueSellerFirstName,
} from "@/lib/supabase/sms-engine.js";
import { isManualInboxSend, isUnknownAutoReply } from "@/lib/domain/queue/is-manual-inbox-send.js";
import { resolveSellerIdentity } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { calculateOwnerProspectAlignment } from "@/lib/identity/ownerProspectAlignment.js";

const clean = (v) => String(v ?? "").trim();

export const phoneKeyVariants = (k) => {
  const d = clean(k).replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return [...new Set([clean(k), t, `1${t}`, `+1${t}`])].filter(Boolean);
};

// The send-time blank-greeting guards, verbatim (pinned by a parity test):
//   process-send-queue.js  BLANK_GREETING_GUARD_RE / BLANK_GREETING_INLINE_RE
//   providers/textgrid.js  BLANK_GREETING_RE
// A body that matches is refused at send time even with a real name on the
// row, so a row carrying it is held here instead of queued to fail.
export const RUNNER_BLANK_GREETING_GUARD_RE = /^(hi|hey|hello|hola|ola|marhaba)\s*,/i;
export const RUNNER_BLANK_GREETING_INLINE_RE = /(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/;

export function hitsBlankGreetingGuard(body) {
  const text = clean(body);
  return RUNNER_BLANK_GREETING_GUARD_RE.test(text) || RUNNER_BLANK_GREETING_INLINE_RE.test(text);
}

/**
 * Resolve the seller identity for a thread with the canonical resolver.
 * `sources` = { phone, prospect, master_owner, thread_state } rows (any may be null).
 */
export function resolveCleanupSellerIdentity(sources = {}) {
  const phone = sources.phone || {};
  const prospect = sources.prospect || {};
  const owner = sources.master_owner || {};
  const threadState = sources.thread_state || {};
  const candidate = {
    prospect_first_name: clean(prospect.first_name) || null,
    prospect_display_name: clean(prospect.full_name) || null,
    prospect_full_name: clean(prospect.full_name) || null,
    owner_display_name: clean(owner.display_name || phone.owner_display_name || prospect.owner_display_name) || null,
    master_owner_display_name: clean(owner.display_name) || null,
    seller_full_name: clean(threadState.seller_display_name) || null,
    phone_first_name: clean(phone.phone_first_name) || null,
    phone_full_name: clean(phone.phone_full_name) || null,
  };
  candidate.identity_alignment = calculateOwnerProspectAlignment({
    masterOwnerName: candidate.master_owner_display_name,
    ownerDisplayName: candidate.owner_display_name,
    prospectFullName: candidate.prospect_full_name,
    phoneFullName: candidate.phone_full_name,
    canonicalProspectId: clean(phone.canonical_prospect_id) || null,
    primaryProspectId: clean(phone.primary_prospect_id) || null,
    phoneId: clean(phone.phone_id) || null,
    sellerFullName: candidate.seller_full_name,
  });
  const identity = resolveSellerIdentity(candidate);
  return {
    ...identity,
    candidate,
    phone_id: clean(phone.phone_id) || null,
    prospect_id: clean(prospect.prospect_id || phone.primary_prospect_id || phone.canonical_prospect_id) || null,
    identity_alignment_status: candidate.identity_alignment?.status || null,
  };
}

/**
 * Read the thread's identity sources (read-only). Any read error -> null, so
 * the caller HOLDS (fail closed).
 */
export async function loadCleanupSellerIdentity(db, { thread_key, master_owner_id = null } = {}) {
  try {
    const keys = phoneKeyVariants(thread_key);
    const [phones, state] = await Promise.all([
      db.from("phones")
        .select("phone_id,master_owner_id,primary_prospect_id,canonical_prospect_id,phone_first_name,phone_full_name,owner_display_name")
        .in("canonical_e164", keys)
        .limit(20),
      db.from("inbox_thread_state").select("thread_key,seller_display_name,prospect_id").in("thread_key", keys).limit(5),
    ]);
    if (phones.error || state.error) return null;
    const phoneRows = phones.data || [];
    const phone = phoneRows.find((p) => master_owner_id && clean(p.master_owner_id) === clean(master_owner_id)) || phoneRows[0] || null;
    const thread_state = (state.data || [])[0] || null;
    const prospectId = clean(phone?.primary_prospect_id || phone?.canonical_prospect_id || thread_state?.prospect_id);
    const ownerId = clean(master_owner_id || phone?.master_owner_id);
    const [prospect, owner] = await Promise.all([
      prospectId
        ? db.from("prospects").select("prospect_id,first_name,full_name,owner_display_name,master_owner_id").eq("prospect_id", prospectId).limit(1)
        : Promise.resolve({ data: [] }),
      ownerId
        ? db.from("master_owners").select("master_owner_id,display_name").eq("master_owner_id", ownerId).limit(1)
        : Promise.resolve({ data: [] }),
    ]);
    if (prospect.error || owner.error) return null;
    return resolveCleanupSellerIdentity({
      phone,
      prospect: (prospect.data || [])[0] || null,
      master_owner: (owner.data || [])[0] || null,
      thread_state,
    });
  } catch {
    return null;
  }
}

/**
 * The send_queue payload for one cleanup reply. Pure.
 */
export function buildCleanupReplyRow({
  thread = {},
  property = {},
  market = null,
  template,
  rendered_text,
  sender,
  timezone,
  identity,
  category = null,
  source,
  dedupe_key,
  queue_key = dedupe_key,
  now,
  extra_metadata = {},
}) {
  const threadKey = clean(thread.thread_key);
  const state = clean(property.state) || null;
  const zip = clean(property.zip) || null;
  const candidate = identity?.candidate || {};
  const candidate_snapshot = {
    // Same shape as the Inbox operator send's snapshot (inboxData.ts).
    phone_id: identity?.phone_id || null,
    best_phone_id: identity?.phone_id || null,
    property_id: clean(thread.property_id) || null,
    master_owner_id: clean(thread.master_owner_id) || null,
    prospect_id: identity?.prospect_id || null,
    canonical_phone_masked: threadKey ? `${threadKey.slice(0, 2)}******${threadKey.slice(-2)}` : null,
    seller_market: clean(market) || null,
    seller_state: state,
    property_address_state: state,
    property_address_zip: zip,
    // A late reply on an existing conversation, never a first touch.
    touch_number: 2,
    is_first_touch: false,
    seller_first_name: clean(identity?.seller_first_name) || null,
    seller_full_name: clean(identity?.seller_full_name) || null,
    seller_name_source: identity?.seller_name_source || null,
    identity_alignment_status: identity?.identity_alignment_status || null,
    owner_display_name: candidate.owner_display_name || null,
    master_owner_display_name: candidate.master_owner_display_name || null,
    prospect_first_name: candidate.prospect_first_name || null,
    prospect_full_name: candidate.prospect_full_name || null,
    phone_first_name: candidate.phone_first_name || null,
    phone_full_name: candidate.phone_full_name || null,
    template_use_case: template.use_case || null,
    template_key: template.template_id,
  };
  return {
    queue_key,
    queue_id: queue_key,
    dedupe_key,
    thread_key: threadKey,
    to_phone_number: threadKey,
    from_phone_number: sender.phone_number,
    textgrid_number_id: sender.item_id || sender.textgrid_number_id || null,
    queue_status: "queued",
    scheduled_for: now,
    scheduled_for_utc: now,
    type: "outbound",
    message_type: "reengagement",
    message_body: rendered_text,
    rendered_message: rendered_text,
    template_id: template.template_id,
    selected_template_id: template.template_id,
    template_source: "sms_templates",
    use_case_template: template.use_case,
    language: template.language,
    touch_number: 2,
    master_owner_id: clean(thread.master_owner_id) || null,
    property_id: clean(thread.property_id) || null,
    prospect_id: identity?.prospect_id || null,
    phone_id: identity?.phone_id || null,
    seller_first_name: clean(identity?.seller_first_name) || null,
    seller_display_name: clean(identity?.seller_display_name) || null,
    property_address_state: state,
    property_address_zip: zip,
    timezone,
    market: clean(market) || null,
    source,
    metadata: {
      source,
      repair_tag: source,
      cleanup_category: category,
      selected_template_id: template.template_id,
      template_language: template.language || null,
      seller_first_name: clean(identity?.seller_first_name) || null,
      is_first_touch: false,
      sender_selection: { engine: "supabase_candidate_feeder.chooseTextgridNumber", reason: sender.selection_reason || null },
      recipient_timezone: timezone,
      candidate_snapshot,
      ...extra_metadata,
    },
  };
}

/**
 * Run the row through the runner's own checks. Pure (no I/O). Every check
 * runs, so a report shows ALL that fail; `reason` is the first.
 * @returns {{ ok: boolean, reason: string|null, failures: string[], window: object|null }}
 */
export function checkCleanupRowAgainstRunner(row, { now } = {}) {
  const failures = [];
  // The cleanup row must never ride an exemption: those waive the checks below.
  if (isManualInboxSend(row)) failures.push("row_classified_as_manual_inbox_send");
  if (isUnknownAutoReply(row)) failures.push("row_classified_as_unknown_auto_reply");
  // The preclaim check needs a row id; the real id is assigned on insert.
  const probe = { ...row, id: row.id || "cleanup-preinsert-probe" };
  const preclaim = validateSendQueueRowPreclaim(probe, now);
  if (!preclaim.ok) failures.push(preclaim.reason);
  if (!clean(resolveQueueSellerFirstName(probe)) && !failures.includes("missing_seller_first_name")) failures.push("missing_seller_first_name");
  const window = evaluateContactWindow(probe, { now });
  if (window?.hold === true) failures.push(window.reason || "recipient_timezone_unresolved");
  else if (window?.allowed !== true) failures.push(window?.reason || "outside_contact_window");
  if (hitsBlankGreetingGuard(row.message_body)) failures.push("blank_greeting_guard");
  return { ok: failures.length === 0, reason: failures[0] || null, failures, window };
}
