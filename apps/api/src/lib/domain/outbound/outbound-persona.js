/**
 * OUTBOUND PERSONA — the ONE resolver every outbound renderer uses (hotfix 8.4.8).
 *
 * THE INCIDENT (2026-10-08). ~75% of campaign targets have no master_owner_id,
 * so the owner-persona join found nothing and the feeder's hardcoded literal
 * fallback rendered "this is Alex" for every one of them. The NAME Alex is a
 * legitimate persona (sellers who already heard from Alex keep Alex); the
 * defect is the hardcoded fallback that assigned it without any decision.
 *
 * RESOLUTION ORDER (owner decision 2026-10-08):
 *   1. THREAD (established) — the persona this phone has already been shown
 *      (seller-visible sends: send_queue.agent_name / metadata.agent_persona /
 *      the name our delivered body signed with). Any name, including Alex.
 *      Two different names already shown -> CONFLICT: never auto-switch; the
 *      caller holds the row for owner review.
 *   2. CAMPAIGN  — an explicit campaigns.agent_persona (NULL today).
 *   3. OWNER     — master_owners.agent_persona (the existing assignment).
 *   4. EXISTING DISTRIBUTION — for a first touch with none of the above, the
 *      existing master_owners persona assignment distribution (overall, or for
 *      the seller's best_language when owners of that language exist), picked
 *      by a stable hash of the thread key so the same phone always lands on
 *      the same persona. No new pool, no new restriction.
 * There is NO literal default. If nothing resolves the caller must not render.
 */

import { extractSenderName, normalizeReplyText } from "@/lib/domain/classification/reply-disposition-signals.js";

// How our ACTIVE templates sign in every language (sms_templates, 2026-10-08):
// "ana Michael", "je suis …", "Michael hier", "wo shi …", "… desu". The
// classifier's extractSenderName covers EN/ES/PT/VI only; persona continuity
// must recognise every language we send in, or a non-English thread would be
// re-signed with a different name. Used only here (classification unchanged).
const NAME = "([A-Z][A-Za-z'-]{1,20})";
const MULTILINGUAL_SIGNATURE_RES = [
  // prefix signatures, case-sensitive so a seller named "Ana" or "1 Main St" never reads as a signature
  new RegExp(`(?:^|[\\s,،.!?])(?:ana|je suis|Je suis|c'est|C'est|ich bin|Ich bin|hier ist|Hier ist|eimai|Eimai|ani|sono|Sono|wo shi|Wo shi|eto|Eto|tu|sou|Sou|é o|É o)\\s+${NAME}(?=$|[\\s.,!?;:،])`),
  new RegExp(`\\bmain\\s+${NAME}\\s+hoon\\b`),
  // suffix signatures ("Michael hier", "Michael desu")
  new RegExp(`(?:^|[\\s,،])${NAME}\\s+(?:huna|ici|hier|edo|po|yahan|qui|desu|yeoyo|imnida|zai|tutaj|zdes|đây|day|aqui|aquí|here)(?=$|[\\s.,!?;:،])`),
];
const NOT_A_NAME = new Set(["there", "again", "neighbor", "friend", "sir", "madam", "maam", "team", "folks", "all", "i", "im", "we"]);

/** The name our outbound body signed with, in any language we send in. */
export function extractSignedPersonaName(body = "") {
  const classic = extractSenderName(body);
  if (classic) return classic;
  const raw = normalizeReplyText(body);
  for (const re of MULTILINGUAL_SIGNATURE_RES) {
    const m = re.exec(raw);
    if (m && /^[A-Z]/.test(m[1]) && !NOT_A_NAME.has(m[1].toLowerCase())) return m[1];
  }
  return null;
}
import { PERSONA_DISTRIBUTION } from "@/lib/domain/outbound/outbound-persona-distribution.generated.js";

const clean = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const PERSONA_UNRESOLVED = "persona_unresolved";
export const PERSONA_CONFLICT = "persona_conflict";

export const PERSONA_SOURCE = Object.freeze({
  THREAD: "thread_established",
  CAMPAIGN: "campaign_agent_persona",
  OWNER: "master_owners.agent_persona",
  DISTRIBUTION: "master_owners_distribution",
});

/** Seller-visible outbound statuses: the persona on these rows was SHOWN. */
export const SHOWN_STATUSES = Object.freeze(["sent", "delivered"]);

export function personaFirstName(persona) {
  const first = clean(persona).replace(/\s+/g, " ").split(" ")[0] || "";
  return /\p{L}/u.test(first) && first.length >= 2 ? first : "";
}

/** A usable persona value (any real name) -> { persona, first_name } or null. */
export function personaValue(value) {
  const persona = clean(value).replace(/\s+/g, " ");
  const first_name = personaFirstName(persona);
  return first_name ? { persona, first_name } : null;
}

/** FNV-1a 32-bit — stable across runtimes. */
export function stablePersonaHash(key) {
  let h = 0x811c9dc5;
  const s = String(key);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable thread key: the 10-digit phone when the key is a phone, else the key. */
export function personaStableKey(value) {
  const raw = clean(value);
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10 && /^[+\d\s().-]+$/.test(raw)) return digits;
  return raw;
}

function weightedEntries(map) {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map)
    .map(([name, weight]) => [clean(name), Number(weight) || 0])
    .filter(([name, weight]) => personaFirstName(name) && weight > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function distributionFor(language, distribution) {
  const lang = clean(language).toLowerCase();
  if (lang) {
    for (const [key, map] of Object.entries(distribution?.by_language || {})) {
      if (key.toLowerCase() === lang) {
        const entries = weightedEntries(map);
        if (entries.length) return { entries, bucket: key };
      }
    }
  }
  return { entries: weightedEntries(distribution?.all), bucket: "all" };
}

/** Deterministic weighted pick from the existing distribution. */
export function distributionPersona(stableKey, language, distribution = PERSONA_DISTRIBUTION) {
  const key = personaStableKey(stableKey);
  if (!key) return null;
  const { entries, bucket } = distributionFor(language, distribution);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return null;
  let point = stablePersonaHash(`persona-v1:${key}`) % total;
  for (const [name, weight] of entries) {
    if (point < weight) return { persona: name, first_name: personaFirstName(name), bucket };
    point -= weight;
  }
  return null;
}

/**
 * THE resolver. Pure and synchronous.
 * @param {object} input
 * @param {string|string[]} [input.thread_persona] persona(s) already shown on the thread
 * @param {string} [input.campaign_persona]
 * @param {string} [input.owner_persona]
 * @param {string} [input.stable_key] thread key (E.164) or target identity
 * @param {string} [input.language] seller best_language
 */
export function resolveOutboundPersona({
  thread_persona = null,
  campaign_persona = null,
  owner_persona = null,
  stable_key = null,
  language = null,
  distribution = PERSONA_DISTRIBUTION,
} = {}) {
  const ok = (match, source, extra = {}) => ({
    ok: true,
    persona: match.persona,
    agent_name: match.first_name,
    first_name: match.first_name,
    source,
    ...extra,
  });

  const shown = (Array.isArray(thread_persona) ? thread_persona : [thread_persona]).map(personaValue).filter(Boolean);
  const shownFirst = [...new Set(shown.map((m) => m.first_name.toLowerCase()))];
  if (shownFirst.length > 1) {
    return { ok: false, reason: PERSONA_CONFLICT, detail: "multiple_personas_already_shown", shown: [...new Set(shown.map((m) => m.first_name))] };
  }
  if (shown.length) return ok(shown[0], PERSONA_SOURCE.THREAD);

  const campaign = personaValue(campaign_persona);
  if (campaign) return ok(campaign, PERSONA_SOURCE.CAMPAIGN);
  const owner = personaValue(owner_persona);
  if (owner) return ok(owner, PERSONA_SOURCE.OWNER);

  const picked = distributionPersona(stable_key, language, distribution);
  if (!picked) return { ok: false, reason: PERSONA_UNRESOLVED, detail: personaStableKey(stable_key) ? "distribution_unavailable" : "no_stable_key" };
  return ok(picked, PERSONA_SOURCE.DISTRIBUTION, { distribution_bucket: picked.bucket });
}

/** The persona a queue row recorded or signed with, or null. */
export function personaFromQueueRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  for (const candidate of [meta.agent_persona, row.agent_persona, row.agent_name, meta.agent_name]) {
    const m = personaValue(candidate);
    if (m) return m;
  }
  const signed = extractSignedPersonaName(row?.message_body || row?.message_text || "");
  return signed ? personaValue(signed) : null;
}

/** All distinct personas (by first name) shown on a set of seller-visible rows, newest first. */
export function shownPersonas(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const m = personaFromQueueRow(row);
    if (!m) continue;
    const k = m.first_name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m.persona);
  }
  return out;
}

export function phoneVariants(value) {
  const key = personaStableKey(value);
  if (!/^\d{10}$/.test(key)) return clean(value) ? [clean(value)] : [];
  return [`+1${key}`, `1${key}`, key];
}

/**
 * Established personas for many phones: Map(10-digit key -> string[] personas
 * already shown, newest first). Read errors THROW (callers fail closed).
 */
export async function loadThreadPersonas(supabase, phones = [], { chunkSize = 150 } = {}) {
  const out = new Map();
  if (!supabase || typeof supabase.from !== "function") return out;
  const keys = [...new Set(phones.map(personaStableKey).filter((k) => /^\d{10}$/.test(k)))];
  for (let i = 0; i < keys.length; i += chunkSize) {
    const slice = keys.slice(i, i + chunkSize);
    const variants = slice.flatMap((k) => [`+1${k}`, `1${k}`, k]);
    const { data, error } = await supabase
      .from("send_queue")
      .select("to_phone_number,thread_key,queue_status,agent_name,metadata,message_body,created_at")
      .in("to_phone_number", variants)
      .in("queue_status", SHOWN_STATUSES)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    const rowsByKey = new Map();
    for (const row of Array.isArray(data) ? data : []) {
      const k = personaStableKey(row.to_phone_number || row.thread_key);
      if (!/^\d{10}$/.test(k)) continue;
      // Re-checked here, not only in the query: only a seller-visible send establishes a persona.
      if (!SHOWN_STATUSES.includes(clean(row.queue_status).toLowerCase())) continue;
      if (!rowsByKey.has(k)) rowsByKey.set(k, []);
      rowsByKey.get(k).push(row);
    }
    for (const [k, rows] of rowsByKey) {
      const personas = shownPersonas(rows);
      if (personas.length) out.set(k, personas);
    }
  }
  return out;
}

/**
 * One thread's persona with I/O (established -> owner -> distribution). Never
 * throws; an unreadable history resolves NOTHING (fail closed — a reply must
 * not rename a conversation it cannot see).
 */
export async function resolveThreadPersona({
  supabase = null,
  thread_key = null,
  owner_persona = null,
  master_owner_id = null,
  language = null,
} = {}) {
  let thread_persona = [];
  if (thread_key && supabase) {
    try {
      const map = await loadThreadPersonas(supabase, [thread_key]);
      thread_persona = map.get(personaStableKey(thread_key)) || [];
    } catch {
      return { ok: false, reason: PERSONA_UNRESOLVED, detail: "thread_history_unreadable" };
    }
  }
  let owner = owner_persona;
  if (!thread_persona.length && !clean(owner) && clean(master_owner_id) && supabase) {
    try {
      const { data } = await supabase
        .from("master_owners")
        .select("master_owner_id,agent_persona")
        .eq("master_owner_id", clean(master_owner_id))
        .limit(1);
      owner = (Array.isArray(data) ? data[0] : data)?.agent_persona || null;
    } catch {
      owner = null;
    }
  }
  return resolveOutboundPersona({ thread_persona, owner_persona: owner, stable_key: thread_key, language });
}

/**
 * Returns `context` with summary.agent_name set by the resolver. A context that
 * already carries an agent name keeps it (the caller resolved it). With
 * nothing resolvable the name stays empty and the render fails closed.
 */
export async function hydrateContextPersona({ supabase = null, context = null, threadKey = null, masterOwnerId = null, language = null } = {}) {
  const base = context && typeof context === "object" ? context : {};
  const summary = base.summary || {};
  if (clean(summary.agent_first_name) || clean(summary.agent_name)) return base;
  const resolved = await resolveThreadPersona({
    supabase,
    thread_key: threadKey,
    master_owner_id: masterOwnerId || base?.ids?.master_owner_id || null,
    language: language || summary.language_preference || summary.language || null,
  });
  if (!resolved.ok) {
    return { ...base, summary: { ...summary, agent_name: "", agent_first_name: "", agent_persona_status: resolved.reason } };
  }
  return {
    ...base,
    summary: {
      ...summary,
      agent_name: resolved.agent_name,
      agent_first_name: resolved.agent_name,
      agent_persona: resolved.persona,
      agent_persona_source: resolved.source,
    },
  };
}

/**
 * Sync persona for a renderer holding a prior queue row (follow-up, deferred
 * render, retry): the row's own persona, else owner, else the distribution
 * persona for the thread. Returns the resolver result.
 */
export function resolveRowPersona(row = {}, { thread_key = null, owner_persona = null, language = null } = {}) {
  const fromRow = personaFromQueueRow(row || {});
  return resolveOutboundPersona({
    thread_persona: fromRow?.persona || null,
    owner_persona,
    stable_key: thread_key || row?.thread_key || row?.to_phone_number || null,
    language: language || row?.language || null,
  });
}

/** First name to sign a row-derived render with, or null (=> the render fails closed). */
export function agentNameForRow(row = {}, opts = {}) {
  const resolved = resolveRowPersona(row, opts);
  return resolved.ok ? resolved.first_name : null;
}

export default resolveOutboundPersona;
