// ─── nurture-render-context.js ───────────────────────────────────────────────
// Render context for deferred seller nurture follow-ups (30-day "not
// interested" re-engage and the other nurture_<intent> rows).
//
// DEFECT THIS EXISTS FOR (2026-10-08 nurture revalidation): the inbound
// orchestrator scheduled nurture rows with only ids — no seller first name, no
// property address, no sender, no language, no agent. At send time the
// deferred resolver then skipped every template that greets the seller by name
// and fell to the S1 "Thanks for confirming…" copy, and the send guard blocked
// on missing_seller_first_name. Every pending nurture in production (96 on
// 2026-10-08) carried that gap.
//
// One resolution, two callers:
//   • schedule time — seller-followup-scheduler persists the context on the row;
//   • send time     — resolve-deferred-queue-message re-resolves anything still
//                     missing from the thread / property before rendering.
// Sources are the thread's own history, never a guess:
//   seller_first_name  the single person-shaped first name already used on this
//                      phone's SENT rows (two different names ⇒ none). Never a
//                      phone number, never an entity.
//   property_address   the row's, else the last sent outbound's for the same
//                      property, else the canonical property street address.
//   from_phone_number  the thread's sticky number (inbox_thread_state.our_number),
//                      else the inbound's own "to" number, else the last outbound's.
//   language           the seller's reply text (identifyReplyLanguage), else the
//                      last outbound's language; unknown stays unknown (null).
//   agent_name         the persona of the last sent outbound on this thread.
// Read-only. Any lookup failure leaves that field unresolved — it never throws.

import { identifyReplyLanguage } from "@/lib/domain/classification/seller-reply-language.js";
import { confidentFirstName } from "@/lib/domain/seller-flow/no-response-followup.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";
import { resolveOutboundPersona, shownPersonas } from "@/lib/domain/outbound/outbound-persona.js";

export const NURTURE_RENDER_CONTEXT_VERSION = "nurture_render_context_v1_2026_10_08";

/**
 * Nurture intent → ordered approved template use cases. A 30-day nurture is a
 * re-engagement ("{first}, just checking back on {address}…"), so it never
 * falls to the S1 first-touch `consider_selling` pool ("Thanks for
 * confirming…"): a row that cannot render its family pauses for review.
 */
export const NURTURE_TEMPLATE_FAMILIES = Object.freeze({
  not_interested: Object.freeze(["consider_selling_follow_up", "not_ready"]),
});

function clean(value) {
  return String(value ?? "").trim();
}

/** Intents whose rows render from a nurture family (not stage / no-response rows). */
export function isNurtureIntent(intent) {
  const key = clean(intent).toLowerCase();
  return Boolean(key) && key !== "stage_no_reply";
}

/** Which render fields a row still lacks. Pure. */
export function missingNurtureContextFields(row = {}) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const missing = [];
  if (!confidentFirstName(row.seller_first_name || metadata.seller_first_name)) missing.push("seller_first_name");
  if (!clean(row.property_address)) missing.push("property_address");
  if (!clean(row.from_phone_number)) missing.push("from_phone_number");
  if (!clean(row.language || metadata.language)) missing.push("language");
  if (!clean(row.agent_name)) missing.push("agent_name");
  return missing;
}

/** The single confident first name across sent rows, else null. Pure. */
export function singleSentFirstName(sent_rows = []) {
  const names = new Map();
  for (const row of sent_rows || []) {
    const first = confidentFirstName(row?.seller_first_name);
    if (first) names.set(first.toLowerCase(), first);
  }
  return names.size === 1 ? [...names.values()][0] : null;
}

/**
 * Pure builder: merge what the caller already knows (`known`) with the
 * thread/property facts. Known values win; facts only fill gaps.
 */
export function buildNurtureRenderContext({
  known = {},
  sent_rows_newest_first = [],
  thread_state = null,
  property = null,
  reply_text = null,
  intent = null,
} = {}) {
  const sent = Array.isArray(sent_rows_newest_first) ? sent_rows_newest_first : [];
  const property_id = clean(known.property_id);
  const same_property = sent.filter((r) => !property_id || !clean(r?.property_id) || clean(r.property_id) === property_id);
  const last = same_property[0] || sent[0] || null;

  const known_first = confidentFirstName(known.seller_first_name);
  const seller_first_name = known_first || singleSentFirstName(sent);

  const property_address =
    clean(known.property_address) ||
    clean(same_property.find((r) => clean(r?.property_address))?.property_address) ||
    clean(property?.property_address) ||
    clean(property?.property_address_full) ||
    null;

  const sticky = normalizePhone(thread_state?.our_number) || null;
  const from_phone_number =
    normalizePhone(known.from_phone_number) || sticky || normalizePhone(known.inbound_to) || normalizePhone(last?.from_phone_number) || null;
  const from_source = normalizePhone(known.from_phone_number)
    ? "caller"
    : sticky
      ? "thread_sticky"
      : normalizePhone(known.inbound_to)
        ? "inbound_to"
        : from_phone_number
          ? "last_outbound"
          : null;
  const textgrid_number_id =
    clean(known.textgrid_number_id) ||
    (from_phone_number && normalizePhone(last?.from_phone_number) === from_phone_number ? clean(last?.textgrid_number_id) : "") ||
    null;

  const reply_language = identifyReplyLanguage(reply_text);
  const language = clean(known.language) || reply_language || clean(last?.language) || null;
  const language_source = clean(known.language)
    ? "caller"
    : reply_language
      ? "seller_reply"
      : language
        ? "last_outbound"
        : "unknown";

  // PERSONA (hotfix 8.4.8): the persona already shown on this thread (sent
  // rows) wins — any name, Alex included; two different shown personas is a
  // conflict and resolves nothing (held for review). With nothing shown, the
  // caller's / owner's / existing-distribution persona. Never a literal default.
  const persona = resolveOutboundPersona({
    thread_persona: shownPersonas(sent),
    owner_persona: clean(known.agent_name) || null,
    stable_key: clean(known.thread_key) || clean(sent[0]?.to_phone_number) || null,
    language,
  });
  const agent_name = persona.ok ? persona.first_name : null;
  const timezone = clean(known.timezone) || clean(last?.timezone) || null;
  const market = clean(known.market) || clean(last?.market) || null;

  const family = NURTURE_TEMPLATE_FAMILIES[clean(intent).toLowerCase()] || null;

  return {
    seller_first_name: seller_first_name || null,
    property_address,
    from_phone_number,
    textgrid_number_id,
    language,
    agent_name,
    timezone,
    market,
    nurture_render_context: {
      version: NURTURE_RENDER_CONTEXT_VERSION,
      template_use_case: family ? family[0] : null,
      template_family: family ? [...family] : null,
      language_source,
      sender_source: from_source,
      first_name_source: known_first ? "caller" : seller_first_name ? "sent_rows_single_name" : "unresolved",
    },
  };
}

async function safe(build) {
  try {
    const { data, error } = await build();
    if (error) return null;
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Loader + builder. `thread_key` is the seller phone. Every read is optional:
 * a failed read leaves the field to the next source (or null).
 */
export async function loadNurtureRenderContext(
  supabase,
  { thread_key, property_id = null, inbound_message_event_id = null, reply_text = null, known = {}, intent = null } = {}
) {
  const phone = normalizePhone(thread_key) || clean(thread_key);
  if (!supabase || !phone) {
    return buildNurtureRenderContext({ known: { ...known, property_id }, reply_text, intent });
  }

  const sentQuery = () => {
    let q = supabase
      .from("send_queue")
      .select("seller_first_name,property_address,property_id,from_phone_number,textgrid_number_id,agent_name,language,timezone,market,sent_at,to_phone_number,metadata,message_body")
      .eq("to_phone_number", phone)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false });
    if (typeof q.limit === "function") q = q.limit(25);
    return q;
  };
  const need_reply = !clean(known.language) && !clean(reply_text) && clean(inbound_message_event_id);

  const [sent, thread, property, inbound] = await Promise.all([
    safe(sentQuery),
    safe(() => supabase.from("inbox_thread_state").select("our_number").eq("thread_key", phone).maybeSingle()),
    clean(property_id) && !clean(known.property_address)
      ? safe(() => supabase.from("properties").select("property_address,property_address_full").eq("property_id", clean(property_id)).maybeSingle())
      : Promise.resolve(null),
    need_reply
      ? safe(() => supabase.from("message_events").select("message_body").eq("id", clean(inbound_message_event_id)).maybeSingle())
      : Promise.resolve(null),
  ]);

  return buildNurtureRenderContext({
    known: { ...known, property_id, thread_key: clean(known.thread_key) || phone },
    sent_rows_newest_first: Array.isArray(sent) ? sent : [],
    thread_state: thread && typeof thread === "object" ? thread : null,
    property: property && typeof property === "object" ? property : null,
    reply_text: clean(reply_text) || clean(inbound?.message_body) || null,
    intent,
  });
}
