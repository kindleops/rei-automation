// ─── bulk-follow-up-plan.js ──────────────────────────────────────────────────
// Assembles the operator-facing plan for a bulk "Conversation Restart".
//
// Loads canonical thread context, picks a FUS2 variant per seller (anti-repeat),
// renders through the canonical safety gates, and resolves an INDIVIDUAL
// schedule per recipient. Produces a plan only -- it inserts nothing.

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { resolveFromPhoneNumber } from "@/lib/domain/inbox/send-now-service.js";
import {
  loadFus2Templates,
  loadThreadTemplateHistory,
  selectFus2Template,
  buildRecipientPlan,
  resolveSellerLanguage,
  FUS2_OPERATOR_LABEL,
} from "@/lib/domain/inbox/fus2-follow-up-service.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Entity names must never become a greeting. 312 of the active threads resolve to
 * an owner like "2972 Sw 17 Street LLC", "Pim Six Corporation" or "Noel A Edwards
 * Rev Liv Tr", and taking the first token of those produces "Hi 2972," or
 * "Hi Pim," on a real SMS to a real owner. Returning "" instead routes the
 * recipient to NEED REVIEW, which is the correct outcome: a human should decide
 * how to address an entity.
 */
const ENTITY_NAME_PATTERN =
  /(\bllc\b|l\.l\.c|\binc\b|\bcorp\b|corporation|company|\bco\b|trust|\btr\b|rev liv|properties|holdings|group|partners|\blp\b|\bltd\b|estate|bank|associates|management|realty|investments?)/i;

function looksLikeEntity(value) {
  const raw = clean(value);
  if (!raw) return false;
  // Leading digit is an address-derived name ("2972 Sw 17 Street LLC").
  return /^\d/.test(raw) || ENTITY_NAME_PATTERN.test(raw);
}

function firstName(value) {
  const raw = clean(value);
  if (!raw) return "";
  if (looksLikeEntity(raw)) return "";
  return raw.split(/\s+/)[0];
}

/**
 * Per-thread context for personalization + scheduling.
 *
 * Names/addresses come from canonical_inbox_threads. Timezone and contact
 * window come from the thread's own send_queue history, so scheduling agrees
 * with how this seller was contacted before. Seller-facing AGENT IDENTITY comes
 * only from the master-owner assignment -- never from send history.
 */
export async function loadThreadContexts(threadKeys = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const keys = [...new Set(threadKeys.map(clean).filter(Boolean))];
  const contexts = new Map();
  if (!keys.length) return contexts;

  /**
   * Same split-identity problem as the agent lookup below: 937 phone numbers carry
   * two thread rows, one bare 10-digit and one E.164, and only one of the twins
   * holds the names. An exact `.in("thread_key", keys)` reads whichever twin the
   * client sent, which for the inbox is the hollow one — every name column null.
   * That is why 2,234 active threads reported "missing seller first name" when
   * 2,148 of them have a usable name one row over.
   *
   * Match canonical_e164 as well and keep whichever row actually carries a name.
   */
  const digitsOfKey = (value) => String(value || "").replace(/[^0-9]/g, "").slice(-10);
  const digitsToKey = new Map();
  for (const key of keys) {
    const d = digitsOfKey(key);
    if (d.length === 10 && !digitsToKey.has(d)) digitsToKey.set(d, key);
  }

  const selectCols =
    "thread_key,canonical_e164,prospect_first_name,prospect_name,owner_name,seller_display_name,property_address_full";

  const byKey = await supabase
    .from("canonical_inbox_threads")
    .select(selectCols)
    .in("thread_key", keys);

  let rows = byKey.data || [];
  if (digitsToKey.size) {
    const byPhone = await supabase
      .from("canonical_inbox_threads")
      .select(selectCols)
      .in("canonical_e164", [...digitsToKey.keys()].map((d) => `+1${d}`));
    rows = rows.concat(byPhone.data || []);
  }

  for (const row of rows) {
    const key = digitsToKey.get(digitsOfKey(row.canonical_e164 || row.thread_key)) || clean(row.thread_key);
    if (!key) continue;
    const resolvedName = firstName(
      row.prospect_first_name || row.prospect_name || row.seller_display_name || row.owner_name,
    );
    const existing = contexts.get(key);
    // Twins are the same conversation. Keep the one that actually resolved a name
    // and an address; a hollow row must never overwrite a populated one.
    if (existing && existing.seller_first_name && !resolvedName) continue;
    if (existing && existing.property_address && !clean(row.property_address_full)) continue;
    contexts.set(key, {
      thread_key: key,
      seller_first_name: resolvedName || (existing?.seller_first_name || ""),
      property_address: clean(row.property_address_full) || (existing?.property_address || ""),
      timezone: null,
      contact_window: null,
      agent_name: null,
      agent_family: null,
      master_owner_id: null,
    });
  }

  // ── Assigned agent ────────────────────────────────────────────────────────
  // The agent assigned to a seller lives on the MASTER OWNER
  // (master_owners.agent_persona, e.g. "Helen Crawford"), reached through
  // inbox_thread_state.master_owner_id. That is the assignment of record and it
  // covers ~99% of threads; the sending number is NOT a proxy for it (a single
  // number has carried seven different agents). personalizeTemplate applies
  // firstNameOnly(), so "Helen Crawford" renders as "Helen".
  /**
   * Resolve by PHONE DIGITS, not by exact thread_key.
   *
   * 937 of 8,839 phone numbers in inbox_thread_state carry TWO rows for the same
   * conversation: one keyed bare 10-digit ("2523140557") and one keyed E.164
   * ("+12523140557"). They are NOT equivalent — the bare-keyed row holds the real
   * master_owner and agent_persona, while its E.164 twin resolves to an owner with
   * no persona at all. Verified against production:
   *     2523140557 -> Scott Harper       +12523140557 -> null
   *     3107222747 -> Nathan Brooks      +13107222747 -> null
   *     2063359131 -> Greg Martin        +12063359131 -> null
   * The inbox surfaces the hollow twin, so an exact `.in("thread_key", keys)` looked
   * up the agent-less row and sent the recipient to NEED REVIEW as "No agent assigned
   * to this seller" — when the seller demonstrably has one. It is the same identity
   * split that prints a phone number where a name belongs on those rows.
   *
   * Matching canonical_e164 as well, and keeping whichever row actually carries an
   * owner, makes this immune to which twin the client happened to send. Nothing is
   * merged or written here; the duplicate rows remain and cleaning them up is a
   * separate data decision.
   */
  const digitsOf = (value) => String(value || "").replace(/[^0-9]/g, "").slice(-10);
  const digitsToRequestedKey = new Map();
  for (const key of keys) {
    const d = digitsOf(key);
    if (d.length === 10 && !digitsToRequestedKey.has(d)) digitsToRequestedKey.set(d, key);
  }
  const e164Candidates = [...digitsToRequestedKey.keys()].map((d) => `+1${d}`);

  let stateRows = [];
  {
    const byKey = await supabase
      .from("inbox_thread_state")
      .select("thread_key,canonical_e164,master_owner_id")
      .in("thread_key", keys);
    stateRows = byKey.data || [];

    if (e164Candidates.length) {
      const byPhone = await supabase
        .from("inbox_thread_state")
        .select("thread_key,canonical_e164,master_owner_id")
        .in("canonical_e164", e164Candidates);
      stateRows = stateRows.concat(byPhone.data || []);
    }
  }

  /**
   * Collect EVERY candidate owner per requested key rather than taking the first.
   * The twins do not merely differ in key shape — they point at DIFFERENT
   * master_owners, and only one of the two carries a persona (verified above:
   * +12523140557's owner has none, 2523140557's owner is Scott Harper). Taking the
   * first row bearing an owner would still pick the hollow one about half the time,
   * so the winner is chosen below, after the personas are known.
   */
  const ownerCandidatesByKey = new Map();
  const ownerIds = [];
  for (const row of stateRows) {
    const ownerId = clean(row.master_owner_id);
    if (!ownerId) continue;
    const requestedKey = digitsToRequestedKey.get(digitsOf(row.canonical_e164 || row.thread_key));
    if (!requestedKey) continue;
    const list = ownerCandidatesByKey.get(requestedKey) || [];
    if (!list.includes(ownerId)) {
      list.push(ownerId);
      ownerCandidatesByKey.set(requestedKey, list);
      ownerIds.push(ownerId);
    }
  }

  if (ownerIds.length) {
    const { data: owners } = await supabase
      .from("master_owners")
      .select("master_owner_id,agent_persona,agent_family,best_language")
      .in("master_owner_id", [...new Set(ownerIds)]);

    const agentByOwner = new Map();
    for (const row of owners || []) {
      const id = clean(row.master_owner_id);
      if (id) agentByOwner.set(id, {
        agent_persona: clean(row.agent_persona),
        agent_family: clean(row.agent_family),
        best_language: clean(row.best_language),
      });
    }
    // Pick the candidate that actually carries a persona. Falls back to the first
    // candidate so behaviour is unchanged for the ~89% of threads with a single row.
    const ownerByThread = new Map();
    for (const [key, candidates] of ownerCandidatesByKey.entries()) {
      const withPersona = candidates.find((id) => clean(agentByOwner.get(id)?.agent_persona));
      ownerByThread.set(key, withPersona || candidates[0]);
    }

    for (const [key, ownerId] of ownerByThread.entries()) {
      const ctx = contexts.get(key);
      const assigned = agentByOwner.get(ownerId);
      if (!ctx || !assigned) continue;
      ctx.agent_name = assigned.agent_persona || null;
      ctx.agent_family = assigned.agent_family || null;
      // Seller language and agent identity ride on the same master-owner row
      // but are INDEPENDENT: agent_family ("Spanish Local") describes the
      // AGENT and is never read as a signal about the seller.
      ctx.best_language = assigned.best_language || null;
      ctx.master_owner_id = ownerId;
    }
  }

  // Timezone / contact window come from the thread's own send history.
  //
  // agent_name is DELIBERATELY NOT read here. send_queue history is a record of
  // who texted this seller before, which is not the same thing as who is
  // assigned to them now -- treating it as identity would let a stale or
  // reassigned agent sign a message. The master-owner assignment above is the
  // sole source of seller-facing identity; if it is absent, agent_name stays
  // unresolved and renderSafeTemplate routes the recipient to NEED REVIEW.
  // (send_queue remains the history source for TEMPLATE anti-repeat, which is
  // a different question and lives in loadThreadTemplateHistory.)
  const { data: queueRows } = await supabase
    .from("send_queue")
    .select("thread_key,timezone,contact_window,created_at")
    .in("thread_key", keys)
    .order("created_at", { ascending: false });

  for (const row of queueRows || []) {
    const key = clean(row.thread_key);
    const ctx = contexts.get(key);
    if (!ctx) continue;
    // Most recent non-null wins; rows arrive newest-first.
    if (!ctx.timezone && clean(row.timezone)) ctx.timezone = clean(row.timezone);
    if (!ctx.contact_window && clean(row.contact_window)) ctx.contact_window = clean(row.contact_window);
  }

  for (const key of keys) {
    if (!contexts.has(key)) {
      // No canonical row at all -- still returned, and it will fail eligibility
      // on missing variables rather than being silently dropped.
      contexts.set(key, { thread_key: key, seller_first_name: "", property_address: "", timezone: null, contact_window: null, agent_name: null });
    }
  }
  return contexts;
}

/**
 * Active sender registry, loaded once per plan.
 *
 * A historical conversation number is only usable if it is STILL a registered
 * active sender: a number the seller once recognised but that has since been
 * released or suspended is not a valid line to text from.
 */
async function loadActiveSenderNumbers(supabase) {
  try {
    const { data } = await supabase
      .from("textgrid_numbers")
      .select("phone_number,status,daily_limit,messages_sent_today")
      .eq("status", "active");
    const set = new Set();
    for (const row of data || []) {
      const num = clean(row.phone_number);
      if (!num) continue;
      // Respect the registry's own operational ceiling.
      const sent = Number(row.messages_sent_today);
      const cap = Number(row.daily_limit);
      if (Number.isFinite(sent) && Number.isFinite(cap) && cap > 0 && sent >= cap) continue;
      set.add(num);
    }
    return set;
  } catch {
    // Unreadable registry => no number can be validated => NEED REVIEW rather
    // than sending from an unverified line.
    return new Set();
  }
}

/**
 * Per-recipient sending line.
 *
 * Reuses the canonical resolver (send-now-service.resolveFromPhoneNumber),
 * which already walks thread state -> send_queue history -> message_events
 * (outbound from_phone_number, inbound to_phone_number) -> market registry.
 * This adds only the eligibility check the brief requires, and never invents a
 * default number: an unverifiable result becomes NEED REVIEW.
 *
 * Deliberately independent of agent identity and seller language. A number has
 * carried many agents historically; that does not make it an identity source.
 */
async function resolveSenderForRecipient({ threadKey, toPhone, activeSenders }, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  let resolved = null;
  try {
    resolved = await resolveFromPhoneNumber({
      thread_key: threadKey,
      to_phone_number: toPhone,
      supabase,
    });
  } catch {
    resolved = null;
  }
  const number = clean(resolved);
  if (!number) return { ok: false, reason: "no_eligible_sender_number" };
  if (!activeSenders.has(number)) {
    return { ok: false, reason: "no_eligible_sender_number", stale_number: true };
  }
  return { ok: true, from_phone_number: number };
}

/**
 * @param {string[]} threadKeys  Selected threads.
 *
 * Note there is deliberately NO agent-name override. {{agent_name}} always
 * resolves to the agent assigned to that seller.
 */
export async function buildBulkFollowUpPlan({ threadKeys = [], now = new Date() } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const keys = [...new Set(threadKeys.map(clean).filter(Boolean))];
  if (!keys.length) {
    return { ok: false, error: "no_recipients_selected", label: FUS2_OPERATOR_LABEL };
  }

  const templateResult = await loadFus2Templates({ supabase });
  if (!templateResult.ok) {
    return { ok: false, error: templateResult.error, label: FUS2_OPERATOR_LABEL };
  }

  const [contexts, history, activeSenders] = await Promise.all([
    loadThreadContexts(keys, { supabase }),
    loadThreadTemplateHistory(keys, { supabase }),
    loadActiveSenderNumbers(supabase),
  ]);

  const recipients = [];
  for (const key of keys) {
    const ctx = contexts.get(key) || { thread_key: key };
    // Language follows the SELLER. Candidates are scoped to the seller's own
    // language BEFORE ranking, and a KNOWN language never silently degrades to
    // English: "we have no information" and "we know this seller reads Spanish"
    // are different facts, and only the first one justifies English copy.
    const { language, known } = resolveSellerLanguage(ctx.best_language);
    const candidates = templateResult.byLanguage.get(language) || [];

    if (!candidates.length) {
      recipients.push({
        thread_key: key,
        seller_name: ctx.seller_first_name || null,
        property_address: ctx.property_address || null,
        template_id: null,
        eligible: false,
        reason: "no_fus2_template_for_language",
        seller_language: language,
        language_known: known,
        assigned_agent_name: ctx.agent_name || null,
      });
      continue;
    }

    const selection = selectFus2Template({
      templates: candidates,
      usedTemplateIds: history.get(key) || [],
      context: { language },
    });

    // Sending line, resolved server-side per recipient. Bulk recipients may
    // legitimately resolve to DIFFERENT numbers -- continuity is per
    // conversation, not per batch.
    const sender = await resolveSenderForRecipient(
      { threadKey: key, toPhone: key, activeSenders },
      { supabase },
    );
    if (!sender.ok) {
      recipients.push({
        thread_key: key,
        seller_name: ctx.seller_first_name || null,
        property_address: ctx.property_address || null,
        template_id: null,
        eligible: false,
        reason: sender.reason,
        seller_language: language,
        assigned_agent_name: ctx.agent_name || null,
      });
      continue;
    }

    const plan = buildRecipientPlan({
      thread: ctx,
      template: selection.ok ? selection.template : null,
      // The agent ASSIGNED TO THIS SELLER, and nothing else. A batch-level name
      // must never speak for a seller: the templates say "this is {{agent_name}}",
      // so borrowing another agent's name misrepresents who is texting them.
      // No assignment => no agent_name => renderSafeTemplate rejects the
      // recipient into NEED REVIEW, which is the correct outcome.
      agentName: ctx.agent_name,
      now,
    });

    recipients.push({
      ...plan,
      assigned_agent_name: ctx.agent_name || null,
      from_phone_number: sender.from_phone_number,
      seller_language: language,
      language_known: known,
      rotation_reason: selection.rotation_reason || null,
      variants_exhausted: selection.exhausted === true,
    });
  }

  const eligible = recipients.filter((r) => r.eligible);
  const needsReview = recipients.filter((r) => !r.eligible);

  return {
    ok: true,
    label: FUS2_OPERATOR_LABEL,
    timing: "best_local_time",
    selected_count: recipients.length,
    eligible_count: eligible.length,
    needs_review_count: needsReview.length,
    template_pool_size: templateResult.templates.length,
    language_breakdown: eligible.reduce((acc, r) => {
      const l = r.seller_language || "Unknown";
      acc[l] = (acc[l] || 0) + 1;
      return acc;
    }, {}),
    distinct_templates_selected: new Set(eligible.map((r) => r.template_id).filter(Boolean)).size,
    recipients,
  };
}

export default buildBulkFollowUpPlan;
