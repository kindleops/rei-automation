#!/usr/bin/env node
/**
 * DAILY REPLY-QUALITY REVIEW — read-only.
 *
 * Every real seller reply becomes review + regression data for the auto-reply
 * system. For each inbound seller message in a local-date window it joins:
 *   - message_events (detected_intent, auto_reply_status, auto_reply_queue_id,
 *     classification_confidence, language)
 *   - automation_events `inbound_message_received` (classification, ambiguity
 *     flags, automation decision, stage before/after)
 *   - Seller Autopilot events on the thread right after it (reason codes such
 *     as template_render_failed)
 *   - the send_queue reply rows (send_queue.inbound_message_id = message id)
 *   - the preceding outbound question (campaign / auto-reply / operator) and
 *     its use case
 * and buckets every reply: AUTO_OK, AUTO_PENDING, AUTO_FAILED, REVIEW,
 * SUPPRESSED_OK, NO_REPLY_BY_DESIGN, SUSPECT (heuristic disagreement).
 *
 * Then (unless --no-replay) it replays each SUSPECT/REVIEW row through the
 * classifier at the CURRENT checkout as a pure function on the REDACTED text:
 * buildConversationContext over an in-memory double of the real prior rows →
 * classify(heuristicOnly) → executeInboundAutomationDecision(dryRun) via
 * replayInboundCase. Network is disabled during replay. Nothing is written to
 * the database; the DB session is READ ONLY with statement_timeout 30s.
 *
 * Output is redacted: phone numbers masked, names → placeholder "Pat",
 * street names → placeholder streets, seller names shown as initials only.
 *
 * Usage (from apps/api; the @/ alias needs the ops loader):
 *   SUPABASE_DB_URL=… nice -n 15 node --import ./scripts/register-aliases-ops.mjs \
 *     scripts/ops/reply-quality-report.mjs [--date YYYY-MM-DD | --today | --from D --to D]
 *     [--tz America/Chicago] [--emit-fixtures] [--out report.txt] [--no-replay]
 *     [--db-url-file /tmp/.dburl]
 *
 * Default window: yesterday in --tz (default America/Chicago), whole local day.
 * --emit-fixtures writes CANDIDATE fixtures (no expected label) for SUSPECT and
 * REVIEW rows to tests/fixtures/reply-quality/<from-date>.json.
 *
 * Daily schedule (not wired — run manually or from a future cron at ~12:00 UTC,
 * outside the 05:00–08:59 and 09:15–11:59 UTC heavy windows):
 *   cd apps/api && nice -n 15 node --import ./scripts/register-aliases-ops.mjs \
 *     scripts/ops/reply-quality-report.mjs --emit-fixtures --out ../../tmp/reply-quality/$(date -v-1d +%F).txt
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── args ────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// ─── time windows ────────────────────────────────────────────────────────────
function tzOffsetMs(utcMs, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}
export function localMidnightUtc(dateStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return new Date(t);
}
export function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function fmtLocal(iso, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

// ─── redaction ───────────────────────────────────────────────────────────────
const PLACEHOLDER_STREETS = ["Main St", "Oak Ave", "Maple Dr", "Cedar Ln", "Pine Rd", "Elm St", "Birch Ct", "Willow Way"];
const STREET_SUFFIX =
  "(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pl|Place|Trl|Trail|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Loop|Run|Pass|Row|Sq|Square)";
const STREET_RE = new RegExp(
  `\\b(\\d{1,6})\\s+((?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9'.\\-]+\\s+){0,4}?${STREET_SUFFIX})\\b\\.?`,
  "gi"
);
const PHONE_RE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s"”]+|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|ly)\/[^\s"”]*/gi;
const GREETING_RE = /\b(Hi|Hey|Hello|Hola|Buenas|Good (?:morning|afternoon|evening)|Dear)([,\s]+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ'\-]+)/g;
const SELF_NAME_RE = /\b(this is|i am|i'm|my name is|soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ'\-]+)(\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'\-]+)?/gi;
const REFERRAL_NAME_RE = /\b(talk to|speak (?:to|with)|ask for|contact|call|text|reach)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ'\-]+)((?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'\-]+){0,2})/g;
const NOT_NAMES = new Set(["the", "a", "not", "no", "yes", "still", "interested", "selling", "sorry", "busy", "el", "la", "dueño", "dueno", "owner", "here", "fine", "good", "ok", "okay", "alex"]);

export function initials(name) {
  if (/\d/.test(String(name || ""))) return "—";
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return parts.slice(0, 3).map((p) => `${p[0].toUpperCase()}.`).join("");
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function redactText(text, { names = [], addresses = [] } = {}) {
  let out = String(text ?? "");
  out = out.replace(URL_RE, (u) => {
    const digits = (u.match(/\d/g) || []).length;
    return `https://example.com/listing/${digits ? "1".padEnd(digits, "0") : "x"}`;
  });
  out = out.replace(EMAIL_RE, "seller@example.com");
  out = out.replace(PHONE_RE, (p) => {
    // Format-preserving mask: the last ten digits become 555-010-0199.
    const digits = p.replace(/\D/g, "");
    const fake = `${digits.length > 10 ? "1" : ""}5550100199`;
    let i = 0;
    return p.replace(/\d/g, () => fake[i++] ?? "0");
  });
  // Known street names (from the property address of record) first, then any address-shaped span.
  let streetIdx = 0;
  for (const addr of addresses) {
    const m = String(addr || "").match(new RegExp(`^\\s*\\d{1,6}\\s+(.+?${STREET_SUFFIX})\\b`, "i"));
    if (m && m[1].length > 3) {
      const ph = PLACEHOLDER_STREETS[streetIdx++ % PLACEHOLDER_STREETS.length];
      out = out.replace(new RegExp(escapeRe(m[1]), "gi"), ph);
      const core = m[1].replace(new RegExp(`\\s+${STREET_SUFFIX}$`, "i"), "").trim();
      if (core.length > 3) out = out.replace(new RegExp(`\\b${escapeRe(core)}\\b`, "gi"), ph.split(" ")[0]);
    }
  }
  out = out.replace(STREET_RE, (full, num, street) =>
    PLACEHOLDER_STREETS.some((p) => street.toLowerCase() === p.toLowerCase())
      ? full
      : `${num} ${PLACEHOLDER_STREETS[streetIdx++ % PLACEHOLDER_STREETS.length]}`
  );
  for (const n of names) {
    for (const part of String(n || "").split(/\s+/)) {
      if (part.length < 2 || NOT_NAMES.has(part.toLowerCase())) continue;
      out = out.replace(new RegExp(`(?<![\\p{L}])${escapeRe(part)}(?![\\p{L}])`, "giu"), "Pat");
    }
  }
  out = out.replace(GREETING_RE, (full, g, sep, name) => (NOT_NAMES.has(name.toLowerCase()) ? full : `${g}${sep}Pat`));
  out = out.replace(REFERRAL_NAME_RE, (full, lead, first) => (NOT_NAMES.has(first.toLowerCase()) ? full : `${lead} Pat`));
  out = out.replace(SELF_NAME_RE, (full, lead, first, last) => {
    if (NOT_NAMES.has(first.toLowerCase())) return full;
    return `${lead} Pat${last && !NOT_NAMES.has(last.trim().toLowerCase()) ? "" : last || ""}`;
  });
  return out;
}

// ─── heuristics (SUSPECT) ────────────────────────────────────────────────────
const OPT_OUT_WORDS =
  /\b(stop|unsubscribe|remove me|take me off|do ?n[o']?t (?:text|contact|message)|quit (?:texting|messaging)|no more (?:texts|messages)|lose (?:this|my) number|delete (?:this|my) number|leave me alone|cancel)\b|molest|no me (?:escrib|mand|textee)|ya no me|d[eé]j(?:e|en|a|ar)(?:me)? (?:de|en paz)|no (?:escriba|manden)|basta|quita(?:r)? mi n[uú]mero|borra(?:r)? mi n[uú]mero|te (?:bloqueo|blokeo)|block(?:ing)? (?:you|this|your)/i;
const PRICE_LIKE = /\$\s?\d|\b\d{2,4}(?:\.\d+)?\s?(?:k|K|grand|thousand|mil)\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{6,7}\b|\b\d+(?:\.\d+)?\s?(?:million|mill|m)\b/i;
const BARE_AFFIRM = /^\s*(y(?:es|ea|eah|ep|up|essir)|si|sí|correct|that'?s me|i do|i am|affirmative|ok(?:ay)?|sure|absolutely|yes ma'?am|yes sir)[\s.!]*$/i;
const NOT_SELLING = /\b(not (?:sell|selling|for sale|interested in selling|looking to sell)|no (?:vendo|está a la venta|esta a la venta)|won'?t sell|never sell(?:ing)?|don'?t want to sell)\b|\bnot sel/i;
const OFFER_REQUEST = /\b(send (?:me )?(?:a |an |your )?(?:bid|offer|number|price)|make (?:me )?(?:an |a )?offer|offer me|what(?:'s| is| would)? (?:your|ur|the) (?:offer|bid|price)|how much (?:would|will|are|can|do) you|what (?:would|will|can) you (?:offer|pay|give)|(?:you|u|do you) (?:like|want(?:na)?|wanna) (?:to )?buy|cu[aá]nto (?:me )?(?:ofrece|pagar|dar[ií]a|dar[ií]an))\b/i;
// Recognizable meanings that should not land in `unclear` (expected label in the flag).
const UNCLEAR_MEANINGS = [
  { code: "spanish_not_for_sale_unclear", expect: "not_interested", intents: ["not_interested"], re: /no (?:est[aá]|ta) en (?:venta|banta|benta|bventa)|no (?:vendo|bendo)|(?:qui[eé]n|wuien|kien) te dijo que (?:est[aá]|esta) en venta/i },
  { code: "non_owner_unclear", expect: "property_specific_non_owner|wrong_number|wrong_person", intents: ["property_specific_non_owner", "wrong_number", "wrong_person", "non_owner"], re: /nunca (?:tuve|he tenido|fui (?:el )?due[nñ]o)|no tengo (?:ninguna|esa) propiedad|no soy (?:el |la )?due[nñ][oa]|not the owner|(?:don'?t|do not|never) own(?:ed)?/i },
  { code: "hostile_unclear", expect: "hostile_or_legal", intents: ["hostile_or_legal"], re: /chinga|pendej|cabr[oó]n|tu madre|fuck|eat (?:dog )?shit|\bdie\b|go to hell|vete a la/i },
  { code: "purpose_question_unclear", expect: "who_is_this", intents: ["who_is_this", "purpose_question", "how_got_number"], re: /why (?:are|r) (?:you|u) asking|how'?d? (?:did )?(?:you|u) get (?:my|this) number|who (?:is|are) (?:this|you)|qui[eé]n (?:eres|es|habla)|c[oó]mo (?:conseguiste|obtuviste|tienes) mi n[uú]mero|en qu[eé] te puedo (?:ayudar|alludar|alludes)|\balludar\b|para qu[eé]/i },
  { code: "conditional_interest_unclear", expect: "open_to_offer|asks_offer|consider_selling", intents: ["open_to_offer", "asks_offer", "conditional_interest", "latent_interest", "consider_selling", "offer_request", "ownership_confirmed"], re: /tal vez|quiz[aá]s|depende|si es (?:una )?buena (?:propuesta|oferta)|podr[ií]a considerar|for the right price|depends on (?:the )?(?:price|offer)|maybe/i },
  { code: "thanks_only_to_review", expect: "acknowledgement", intents: ["acknowledgement"], re: /^\s*(?:muchas )?(?:gracias|grasias|thanks|thank you|thx|ty)[\s.!]*$/i },
  { code: "transferred_to_family_unclear", expect: "former_owner_respondent", intents: ["former_owner_respondent", "property_sold"], re: /(?:gave|have|left|transferred|deeded) the house to my (?:son|daughter|kids|wife|husband)|le (?:di|dej[eé]) la casa a/i },
];
const SPANISH_MARKERS = /\b(s[ií]|est[aá]|venta|banta|vendo|bendo|gracias|grasias|tengo|tuve|propiedad|quita|n[uú]mero|mejor|tal vez|propuesta|podr[ií]a|considerar|qu[eé]|ya|mi|tu|te|due[nñ]o|casa|madre|esa|direcci[oó]n|nunca|ninguna|claro|se[nñ]or|puedo|ayudar|alludar|alludes|blokeo|bloqueo|contactos|vend[ií]|dijo|quien|wuien|porque|por qu[eé])\b/gi;
export function spanishMarkerCount(text) {
  return new Set((String(text || "").match(SPANISH_MARKERS) || []).map((w) => w.toLowerCase())).size;
}
const BARE_NO = /^\s*(?:no|nope|nah)[\s.!]*$/i;
const TAPBACK = /^\s*(?:​|‌)?\s*(?:Liked|Loved|Laughed at|Emphasized|Questioned|Disliked|Removed|Reacted|[\p{Extended_Pictographic}​‌️\s]+(?:to|from)\s*[“"])/u;

const LAYERED_INTENTS = new Set(["property_specific_non_owner", "wrong_number", "wrong_person", "executor_heir_respondent", "former_owner_respondent", "sold_property", "property_sold", "not_interested", "non_owner_referral"]);
const PRICE_INTENTS = new Set(["asking_price_provided", "price_provided", "counter_offer", "price_given", "asking_price", "seller_counter"]);
const OPT_OUT_INTENTS = new Set(["opt_out"]);
const SUPPRESS_INTENTS = new Set(["opt_out", "not_interested", "wrong_number", "property_sold", "hostile_or_legal", "former_owner_respondent"]);

function lc(v) {
  return String(v ?? "").trim().toLowerCase();
}

export function suspectFlags(row) {
  const body = String(row.body || "");
  const intent = lc(row.intent);
  const flags = [];
  if (TAPBACK.test(body)) return flags; // reactions are not seller text
  if (OPT_OUT_WORDS.test(body) && !OPT_OUT_INTENTS.has(intent)) flags.push({ code: "optout_words_not_optout", expect: "opt_out" });
  const noUrl = body.replace(URL_RE, " ");
  if (URL_RE.test(body) && (PRICE_INTENTS.has(intent) || row.price_parsed)) flags.push({ code: "url_read_as_price", expect: "not_price" });
  URL_RE.lastIndex = 0;
  if (PRICE_LIKE.test(noUrl) && !PRICE_INTENTS.has(intent) && !OPT_OUT_INTENTS.has(intent)) flags.push({ code: "price_like_without_price_intent", expect: "asking_price_provided" });
  if (BARE_AFFIRM.test(body) && (row.base === "REVIEW" || intent === "unclear")) flags.push({ code: "bare_affirmative_to_review", expect: "affirmative_bound_to_question" });
  if (NOT_SELLING.test(body) && (intent === "unclear" || intent === "ownership_confirmed")) flags.push({ code: "explicit_not_selling_unclear", expect: "not_interested" });
  if (OFFER_REQUEST.test(body) && (intent === "unclear" || row.base === "REVIEW")) flags.push({ code: "offer_request_unclear", expect: "offer_request" });
  if (NOT_SELLING.test(body) && PRICE_INTENTS.has(intent)) flags.push({ code: "not_selling_read_as_price", expect: "not_price" });
  if (intent === "unclear" || row.base === "REVIEW") {
    for (const m of UNCLEAR_MEANINGS) if (m.re.test(body) && !m.intents.includes(intent)) flags.push({ code: m.code, expect: m.expect, intents: m.intents });
  }
  if (spanishMarkerCount(body) >= 2 && lc(row.reply_language || row.classified_language) === "english" && ["AUTO_OK", "AUTO_FAILED", "REVIEW", "AUTO_PENDING"].includes(row.base))
    flags.push({ code: "spanish_text_detected_english", expect: "language:Spanish" });
  if (BARE_NO.test(body) && intent === "unclear" && row.prior?.use_case === "ownership_check")
    flags.push({ code: "bare_no_to_ownership_held", expect: "policy:LC_BARE_NO_OWNERSHIP_MODE" });
  if (row.prior?.kind === "operator" && BARE_AFFIRM.test(body) && intent === "ownership_confirmed" && row.prior?.use_case && row.prior.use_case !== "ownership_check")
    flags.push({ code: "operator_question_affirmative_as_ownership", expect: `bound_to_${row.prior.use_case}` });
  if (row.reply_language && row.seller_reply_language && lc(row.reply_language) !== lc(row.seller_reply_language))
    flags.push({ code: "reply_language_mismatch", expect: `reply_in_${row.seller_reply_language}` });
  if (intent === "not_interested" && !row.followup_scheduled && !row.suppression_applied)
    flags.push({ code: "not_interested_without_30d_nurture", expect: "nurture_followup_30d" });
  return flags;
}

// ─── bucketing ───────────────────────────────────────────────────────────────
const DELIVERED = new Set(["delivered"]);
const IN_FLIGHT = new Set(["sent", "queued", "scheduled", "pending", "processing", "sending", "approved"]);
const FAILED = /fail|block|error|undeliver|reject|expired/;
const STATUS_RANK = (s) => (DELIVERED.has(s) ? 0 : s === "sent" ? 1 : IN_FLIGHT.has(s) ? 2 : FAILED.test(s) ? 3 : 4);

export function baseBucket(row) {
  const intent = lc(row.intent);
  const reply = row.reply; // best reply row or null
  if (reply) {
    const s = lc(reply.queue_status);
    if (DELIVERED.has(s)) return { bucket: "AUTO_OK", reason: `${reply.use_case || "reply"} delivered` };
    if (IN_FLIGHT.has(s)) return { bucket: "AUTO_PENDING", reason: `${reply.use_case || "reply"} ${s}` };
    if (FAILED.test(s)) return { bucket: "AUTO_FAILED", reason: `${reply.use_case || "reply"} ${s}${reply.failed_reason ? `: ${reply.failed_reason}` : ""}` };
    if (s === "cancelled") {
      if (lc(reply.cancellation_reason) === "superseded_by_newer_inbound")
        return { bucket: "NO_REPLY_BY_DESIGN", reason: `${reply.use_case || "reply"} cancelled: superseded by the seller's newer message` };
      if (row.superseded_by_later_reply) return { bucket: "AUTO_OK", reason: `${reply.use_case || "reply"} cancelled; superseded by the burst's delivered reply` };
      return { bucket: "AUTO_FAILED", reason: `${reply.use_case || "reply"} cancelled${reply.paused_reason || reply.blocked_reason ? `: ${reply.paused_reason || reply.blocked_reason}` : ""}` };
    }
  }
  const renderFail = row.autopilot.find((e) => /render/i.test(e.reason || ""));
  if (renderFail) return { bucket: "AUTO_FAILED", reason: `${renderFail.reason} (${renderFail.template_use_case || "?"})` };
  if (row.should_queue_reply && !reply) {
    const why = row.autopilot.find((e) => e.reason)?.reason || row.audit_reason || "no queue row";
    return { bucket: "AUTO_FAILED", reason: `reply chosen, not queued: ${why}` };
  }
  if (SUPPRESS_INTENTS.has(intent)) {
    const how = [row.suppression_applied && "suppressed", row.followup_scheduled && "30d nurture", row.review_requested && "review"].filter(Boolean).join("+");
    if (intent === "opt_out" && row.suppression_applied) return { bucket: "SUPPRESSED_OK", reason: `opt_out → ${how}` };
    if (intent === "not_interested" && (row.followup_scheduled || row.suppression_applied)) return { bucket: "SUPPRESSED_OK", reason: `not_interested → ${how}` };
    if (intent === "wrong_number" && (row.suppression_applied || row.blocked)) return { bucket: "SUPPRESSED_OK", reason: `wrong_number → ${how || "blocked"}` };
  }
  if (!String(row.body || "").trim()) return { bucket: "REVIEW", reason: "empty / media-only inbound" };
  if (row.is_tapback) return { bucket: "NO_REPLY_BY_DESIGN", reason: "reaction / tapback" };
  if (row.human_review || row.review_requested) {
    return { bucket: "REVIEW", reason: row.review_reason || row.audit_reason || "human review" };
  }
  if (intent === "acknowledgement") return { bucket: "NO_REPLY_BY_DESIGN", reason: "acknowledgement" };
  return { bucket: "REVIEW", reason: `no reply, no review flag (${row.audit_reason || "no decision recorded"})` };
}

// ─── in-memory supabase double for buildConversationContext (replay) ────────
export function memorySupabase(tables) {
  return {
    from(table) {
      const filters = [];
      let order = null;
      const rows = () => {
        let out = (tables[table] || []).slice();
        for (const f of filters) out = out.filter(f);
        if (order) out.sort((a, b) => (String(a[order.col]) < String(b[order.col]) ? -1 : 1) * (order.asc ? 1 : -1));
        return out;
      };
      const cmp = (col, op, v) => (r) => {
        const a = r[col];
        if (a == null) return false;
        const x = Date.parse(a), y = Date.parse(v);
        const [l, rr] = Number.isFinite(x) && Number.isFinite(y) ? [x, y] : [a, v];
        return op === "gt" ? l > rr : op === "lt" ? l < rr : op === "lte" ? l <= rr : l >= rr;
      };
      const b = {
        select: () => b,
        eq: (c, v) => (filters.push((r) => String(r[c]) === String(v)), b),
        in: (c, vs) => (filters.push((r) => vs.map(String).includes(String(r[c]))), b),
        not: (c, op, v) => (filters.push((r) => (op === "is" && v === null ? r[c] != null : String(r[c]) !== String(v))), b),
        gt: (c, v) => (filters.push(cmp(c, "gt", v)), b),
        lt: (c, v) => (filters.push(cmp(c, "lt", v)), b),
        lte: (c, v) => (filters.push(cmp(c, "lte", v)), b),
        gte: (c, v) => (filters.push(cmp(c, "gte", v)), b),
        order: (c, o = {}) => ((order = { col: c, asc: o.ascending !== false }), b),
        limit: async (n) => ({ data: rows().slice(0, n), error: null }),
        maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
        then: (res) => res({ data: rows(), error: null }),
      };
      return b;
    },
  };
}

// ─── DB ──────────────────────────────────────────────────────────────────────
const AUTOPILOT_TYPES = [
  "AUTOMATION_NEEDS_REVIEW", "HUMAN_REVIEW_REQUESTED", "AUTOMATION_BLOCKED", "OWNER_CONFIRMED",
  "SUPPRESSION_APPLIED", "SELLER_NOT_INTERESTED", "FOLLOWUP_SCHEDULED", "SELLER_ASKING_PRICE_CAPTURED",
  "OFFER_INTEREST_CONFIRMED", "REFERRAL_DETECTED", "DEAL_NURTURE_TRIGGERED", "offer_queued", "review_required",
  "LOCAL_TEMPLATE_FALLBACK_USED", "OUTBOUND_CANCELLED_COMPLIANCE", "FOLLOWUP_CANCELLED",
];

function phoneVariants(e164) {
  const d = String(e164 || "").replace(/\D/g, "");
  const ten = d.slice(-10);
  return [`+1${ten}`, `1${ten}`, ten];
}

export async function loadData(client, startIso, endIso) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const inbound = await q(
    `select id::text, created_at, thread_key, from_phone_number, message_body, detected_intent, auto_reply_status,
            auto_reply_queue_id, classification_confidence, language, market, seller_display_name, property_address,
            provider_message_sid, metadata->'automation_decision' as ad, metadata->>'human_review_required' as hrr,
            metadata->>'language' as meta_language
       from message_events where direction='inbound' and created_at >= $1 and created_at < $2 order by created_at`,
    [startIso, endIso]
  );
  const ids = inbound.map((r) => r.id);
  const sids = inbound.map((r) => r.provider_message_sid).filter(Boolean);
  const threads = [...new Set(inbound.map((r) => r.thread_key).filter(Boolean))];
  if (!inbound.length) return { inbound, decisions: [], replies: [], autopilot: [], outbound: [], templates: [], history: [] };
  const decisions = await q(
    `select payload->>'provider_message_sid' sid, status, error_message, payload->>'stage_before' stage_before,
            payload->>'stage_after' stage_after, payload->'seller_followup_result' sfr,
            jsonb_build_object(
              'primary_intent', payload->'classification'->'primary_intent', 'confidence', payload->'classification'->'confidence',
              'language', payload->'classification'->'language', 'ambiguity_flags', payload->'classification'->'ambiguity_flags',
              'context_use_case', payload->'classification'->'context_use_case', 'context_status', payload->'classification'->'context_status',
              'compliance_flag', payload->'classification'->'compliance_flag', 'price_parse', payload->'classification'->'price_parse',
              'reply_language_source', payload->'classification'->'reply_language_source',
              'automation_decision', payload->'classification'->'automation_decision',
              'matched_rule_ids', payload->'classification'->'matched_rule_ids') cls
       from automation_events where event_type='inbound_message_received'
        and created_at >= $1::timestamptz - interval '1 hour' and created_at < $2::timestamptz + interval '1 hour'
        and payload->>'provider_message_sid' = any($3)`,
    [startIso, endIso, sids]
  );
  const replies = await q(
    `select id::text, inbound_message_id, queue_status, source, message_type, use_case_template, template_id, language,
            sent_at, delivered_at, failed_reason, paused_reason, blocked_reason, created_at, thread_key,
            metadata->>'cancellation_reason' cancellation_reason, message_body
       from send_queue where inbound_message_id = any($1)
          or id::text = any($2)`,
    [ids, inbound.map((r) => r.auto_reply_queue_id).filter(Boolean)]
  );
  const autopilot = await q(
    `select event_type, conversation_thread_id, created_at, payload->>'reason' reason, payload->>'reasoning_code' reasoning_code,
            payload->>'reason_code' reason_code, payload->'outbound'->>'template_use_case' template_use_case,
            payload->>'stage_before' stage_before, payload->>'stage_after' stage_after
       from automation_events where conversation_thread_id = any($1) and event_type = any($4)
        and created_at >= $2 and created_at < $3::timestamptz + interval '10 minutes'`,
    [threads, startIso, endIso, AUTOPILOT_TYPES]
  );
  const variants = threads.flatMap(phoneVariants);
  const outbound = await q(
    `select id::text, to_phone_number, queue_status, source, message_type, use_case_template, template_id, message_body,
            provider_message_id, sent_at, delivered_at, campaign_id, language, seller_first_name, seller_display_name,
            coalesce(property_address, metadata->>'property_address', metadata->'target_snapshot'->>'property_address',
                     metadata->'candidate_snapshot'->>'property_address') property_address, market
       from send_queue where to_phone_number = any($1) and sent_at is not null
        and sent_at >= $2::timestamptz - interval '45 days' and sent_at < $3`,
    [variants, startIso, endIso]
  );
  const tplIds = [...new Set(outbound.map((r) => r.template_id).filter(Boolean))];
  const templates = tplIds.length
    ? await q(`select template_id, use_case from sms_templates where template_id = any($1)`, [tplIds])
    : [];
  const history = await q(
    `select id::text, created_at, thread_key, direction, message_body, metadata->>'detected_intent' detected_intent,
            metadata->>'language' language
       from message_events where direction='inbound' and thread_key = any($1)
        and created_at >= $2::timestamptz - interval '45 days' and created_at < $3`,
    [threads, startIso, endIso]
  );
  return { inbound, decisions, replies, autopilot, outbound, templates, history };
}

// ─── assemble rows ───────────────────────────────────────────────────────────
function last10(p) {
  return String(p || "").replace(/\D/g, "").slice(-10);
}

export function assembleRows(data, { isInternal = () => false, tplUseCase = new Map(), mapUseCase, deriveUseCase } = {}) {
  const decBySid = new Map(data.decisions.map((d) => [d.sid, d]));
  const repliesByInbound = new Map();
  for (const r of data.replies) {
    for (const k of [r.inbound_message_id]) {
      if (!k) continue;
      if (!repliesByInbound.has(k)) repliesByInbound.set(k, []);
      repliesByInbound.get(k).push(r);
    }
  }
  const replyById = new Map(data.replies.map((r) => [r.id, r]));
  const outByThread = new Map();
  for (const o of data.outbound) {
    const k = last10(o.to_phone_number);
    if (!outByThread.has(k)) outByThread.set(k, []);
    outByThread.get(k).push(o);
  }
  const rows = [];
  for (const m of data.inbound) {
    if (isInternal(m.from_phone_number) || isInternal(m.thread_key)) continue;
    const dec = decBySid.get(m.provider_message_sid) || null;
    const cls = dec?.cls || {};
    const ad = m.ad || cls.automation_decision || {};
    const t = Date.parse(m.created_at);
    const replyRows = [...(repliesByInbound.get(m.id) || [])];
    if (m.auto_reply_queue_id && replyById.has(m.auto_reply_queue_id) && !replyRows.some((r) => r.id === m.auto_reply_queue_id))
      replyRows.push(replyById.get(m.auto_reply_queue_id));
    replyRows.sort((a, b) => STATUS_RANK(lc(a.queue_status)) - STATUS_RANK(lc(b.queue_status)));
    const reply = replyRows[0] ? { ...replyRows[0], use_case: replyRows[0].use_case_template || replyRows[0].message_type } : null;
    // Autopilot events for this message: same thread, after it, before the next inbound on the thread.
    const nextInbound = data.inbound.find((x) => x.thread_key === m.thread_key && Date.parse(x.created_at) > t);
    const until = Math.min(t + 10 * 60_000, nextInbound ? Date.parse(nextInbound.created_at) : Infinity);
    const autopilot = data.autopilot
      .filter((e) => e.conversation_thread_id === m.thread_key && Date.parse(e.created_at) >= t && Date.parse(e.created_at) < until)
      .map((e) => ({ ...e, reason: e.reason || e.reasoning_code || e.reason_code || null }));
    const types = new Set(autopilot.map((e) => e.event_type));
    // Preceding outbound question (sent before this inbound).
    const outs = (outByThread.get(last10(m.thread_key)) || [])
      .filter((o) => Date.parse(o.sent_at) <= t && ["sent", "delivered"].includes(lc(o.queue_status)))
      .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
    const p = outs[0] || null;
    let prior = null;
    if (p) {
      const kind = p.campaign_id && lc(p.source) !== "auto_reply" && lc(p.source) !== "inbox" ? "campaign"
        : lc(p.source) === "auto_reply" ? "auto_reply"
        : lc(p.source) === "inbox" || lc(p.message_type) === "manual_reply" ? "operator" : (lc(p.source) || "other");
      const use_case = (mapUseCase && mapUseCase(p.message_type)) || (mapUseCase && mapUseCase(tplUseCase.get(p.template_id))) || (deriveUseCase && deriveUseCase(p.message_body)) || p.use_case_template || null;
      prior = { kind, use_case, sent_at: p.sent_at, body: p.message_body, row: p, all: outs.slice(0, 2) };
    }
    const sellerName = m.seller_display_name || p?.seller_display_name || p?.seller_first_name || "";
    const sfr = dec?.sfr || {};
    rows.push({
      id: m.id,
      at: m.created_at,
      thread_key: m.thread_key,
      market: m.market || p?.market || null,
      seller_initials: initials(sellerName),
      names: [p?.seller_first_name, p?.seller_display_name, m.seller_display_name].filter(Boolean),
      addresses: [m.property_address, p?.property_address].filter(Boolean),
      body: m.message_body || "",
      intent: m.detected_intent || cls.primary_intent || null,
      confidence: m.classification_confidence != null ? Number(m.classification_confidence) : cls.confidence ?? null,
      seller_language: m.language || m.meta_language || cls.language || null,
      classified_language: cls.language || m.language || m.meta_language || null,
      auto_reply_status: m.auto_reply_status,
      ambiguity_flags: cls.ambiguity_flags || [],
      context_use_case: cls.context_use_case || null,
      context_status: cls.context_status || null,
      price_parsed: !!(cls.price_parse && (cls.price_parse.amount || cls.price_parse.value || cls.price_parse.price)),
      decision_status: dec?.status || null,
      decision_error: dec?.error_message || null,
      stage_before: dec?.stage_before || null,
      stage_after: dec?.stage_after || null,
      audit_reason: ad.audit_reason || null,
      should_queue_reply: ad.should_queue_reply === true,
      human_review: ad.human_review_required === true || ad.should_mark_human_review === true || m.hrr === "true",
      review_reason: ad.human_review_reason || autopilot.find((e) => e.event_type === "AUTOMATION_NEEDS_REVIEW")?.reason || null,
      review_requested: types.has("HUMAN_REVIEW_REQUESTED") || types.has("AUTOMATION_NEEDS_REVIEW") || types.has("review_required"),
      suppression_applied: types.has("SUPPRESSION_APPLIED") || ad.should_suppress_contact === true,
      blocked: types.has("AUTOMATION_BLOCKED"),
      followup_scheduled: types.has("FOLLOWUP_SCHEDULED") || sfr.followup_scheduled === true || sfr.followup_created === true,
      is_tapback: TAPBACK.test(m.message_body || ""),
      autopilot,
      reply,
      reply_rows: replyRows,
      reply_language: null, // set in main from the reply body we sent (send_queue.language is not populated)
      prior,
    });
  }
  // Burst supersession: a cancelled reply is fine when a later inbound on the thread within 10 min got a delivered reply.
  for (const r of rows) {
    if (r.reply && lc(r.reply.queue_status) === "cancelled") {
      const t = Date.parse(r.at);
      r.superseded_by_later_reply = rows.some((o) => o.thread_key === r.thread_key && Date.parse(o.at) > t && Date.parse(o.at) - t < 10 * 60_000 && o.reply && DELIVERED.has(lc(o.reply.queue_status)));
    }
  }
  return rows;
}

// ─── replay (pure, local) ────────────────────────────────────────────────────
function expectationMet(flag, rep) {
  const intent = lc(rep.classification?.primary_intent);
  const ad = rep.classification?.automation_decision || {};
  switch (flag.code) {
    case "optout_words_not_optout": return intent === "opt_out";
    case "url_read_as_price": return !PRICE_INTENTS.has(intent);
    case "price_like_without_price_intent": return PRICE_INTENTS.has(intent);
    case "bare_affirmative_to_review": return intent !== "unclear" && ad.auto_reply_allowed === true;
    case "explicit_not_selling_unclear": return intent === "not_interested";
    case "offer_request_unclear": return intent !== "unclear" && /offer|price|consider|interest/.test(intent);
    case "operator_question_affirmative_as_ownership": return intent !== "ownership_confirmed";
    case "reply_language_mismatch": return lc(rep.classification?.language) === lc(flag.expect.replace("reply_in_", ""));
    case "not_selling_read_as_price": return !PRICE_INTENTS.has(intent);
    case "spanish_text_detected_english": return lc(rep.classification?.language) === "spanish";
    case "bare_no_to_ownership_held": return null;
    default:
      if (Array.isArray(flag.intents)) return flag.intents.includes(intent);
      return null; // runtime-only (nurture scheduling, render) — not decidable by classify
  }
}

async function replayRows(rows, deps) {
  const { buildConversationContext, classify, replayInboundCase } = deps;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network disabled during reply-quality replay"); };
  const saved = { log: console.log, info: console.info, warn: console.warn, debug: console.debug, error: console.error };
  console.log = console.info = console.warn = console.debug = console.error = () => {};
  try {
    for (const r of rows) {
      if (!["SUSPECT", "REVIEW", "AUTO_FAILED"].includes(r.bucket)) continue;
      const red = (s) => redactText(s, { names: r.names, addresses: r.addresses });
      const outbound = (r.prior?.all || []).map((o) => ({
        id: o.id, message_type: o.message_type, message_body: red(o.message_body), template_id: o.template_id,
        provider_message_id: null, sent_at: o.sent_at, delivered_at: o.delivered_at, queue_status: o.queue_status,
        to_phone_number: r.thread_key,
      }));
      const history = (deps.history.get(r.thread_key) || []).map((h) => ({ ...h, message_body: red(h.message_body) }));
      const templates = (r.prior?.all || []).filter((o) => o.template_id && deps.tplUseCase.has(o.template_id))
        .map((o) => ({ template_id: o.template_id, use_case: deps.tplUseCase.get(o.template_id) }));
      const sb = memorySupabase({ send_queue: outbound, message_events: history, sms_templates: templates });
      const body = red(r.body);
      try {
        const ctx = await buildConversationContext({
          thread_key: r.thread_key, inbound_received_at: r.at, supabase: sb, current_inbound_event_id: r.id,
        });
        const classification = await classify(body, null, { heuristicOnly: true, conversation_context: ctx });
        const rep = await replayInboundCase({ message_body: body }, { classify: async () => classification });
        r.replay = {
          intent: classification.primary_intent,
          confidence: classification.confidence,
          language: classification.language,
          reply_language_source: classification.reply_language_source || null,
          auto_reply_allowed: classification.automation_decision?.auto_reply_allowed ?? null,
          human_review: classification.automation_decision?.human_review_required ?? null,
          disposition: rep.disposition,
          should_queue_reply: rep.detail?.should_queue_reply ?? null,
          decision_audit: rep.execution?.automation_decision?.audit_reason || rep.detail?.audit_reason || null,
          context_use_case: ctx?.last_outbound_use_case || null,
          context_status: ctx ? ctx.question_status : "unavailable",
          classification,
        };
        const verdicts = r.flags.map((f) => ({ code: f.code, met: expectationMet(f, { classification }) }));
        const decidable = verdicts.filter((v) => v.met !== null);
        const changed = lc(classification.primary_intent) !== lc(r.intent);
        r.verdict_detail = verdicts.map((v) => `${v.code}:${v.met === null ? "n/a" : v.met ? "met" : "OPEN"}`).join(" ");
        if (decidable.length && decidable.every((v) => v.met)) r.verdict = "fixed in 8.4.2";
        else if (decidable.some((v) => v.met)) r.verdict = "partly fixed in 8.4.2; still open";
        else if (decidable.length) r.verdict = "still open";
        else if (r.flags.some((f) => f.code === "bare_no_to_ownership_held")) r.verdict = "held by policy flag LC_BARE_NO_OWNERSHIP_MODE (owner decision)";
        else if (r.flags.length) r.verdict = "runtime check (not decidable by classifier replay)";
        else if (changed && LAYERED_INTENTS.has(lc(r.intent)) && LAYERED_INTENTS.has(lc(classification.primary_intent)))
          r.verdict = `layered intent: classifier says ${classification.primary_intent}, the live decision layer refined it to ${r.intent} (property-relationship/referral layers are not modeled in replay); no action`;
        else if (changed && lc(r.intent) === "non_owner_referral")
          r.verdict = "layered intent: referral detection runs after the classifier (not modeled in replay); no action";
        else r.verdict = changed ? `changed at HEAD (${r.intent} → ${classification.primary_intent}); needs label` : "unchanged; review by design unless a human labels otherwise";
        if (/template_render_failed/.test(r.reason || "") && !decidable.some((v) => !v.met)) {
          r.verdict = r.prior?.row?.property_address
            ? "fixed in 8.4.2 (a45d41a0: opener snapshot carries the street address that is now hydrated)"
            : "8.4.2 falls back to an approved variant without {{property_address}} (a45d41a0); verify";
        }
        if (/daily_limit|sender_ineligible/.test(r.reason || "")) r.verdict = "still open (transport: auto-reply blocked by the sender's daily cap)";
      } catch (e) {
        r.replay = { error: e.message };
        r.verdict = "replay error";
      }
    }
  } finally {
    Object.assign(console, saved);
    globalThis.fetch = realFetch;
  }
}

// ─── render ──────────────────────────────────────────────────────────────────
const BUCKET_ORDER = ["AUTO_OK", "AUTO_PENDING", "AUTO_FAILED", "REVIEW", "SUPPRESSED_OK", "NO_REPLY_BY_DESIGN", "SUSPECT"];
function pad(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}
function oneLine(s, n) {
  return pad(String(s || "").replace(/\s+/g, " ").trim(), n);
}

export function renderReport(rows, { label, tz, stageOrder = [] }) {
  const out = [];
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  const baseCounts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  for (const r of rows) { counts[r.bucket] += 1; baseCounts[r.base] += 1; }
  const threads = new Set(rows.map((r) => r.thread_key)).size;
  const substantive = rows.filter((r) => r.base !== "NO_REPLY_BY_DESIGN").length;
  const autoOk = rows.filter((r) => r.base === "AUTO_OK").length;
  out.push(`REPLY-QUALITY REVIEW — ${label} (${tz})`);
  out.push(`generated ${new Date().toISOString()} · read-only · ${rows.length} inbound seller messages on ${threads} threads (internal test phones excluded)`);
  out.push("");
  out.push("BUCKETS (final = SUSPECT overrides the base bucket when a heuristic fires; base shown for reference)");
  for (const b of BUCKET_ORDER) out.push(`  ${pad(b, 20)} final ${String(counts[b]).padStart(3)}   base ${String(baseCounts[b]).padStart(3)}`);
  out.push(`  AUTO_OK rate (base): ${autoOk}/${rows.length} of all = ${rows.length ? ((100 * autoOk) / rows.length).toFixed(1) : "0"}%; ${autoOk}/${substantive} excluding reactions/acks = ${substantive ? ((100 * autoOk) / substantive).toFixed(1) : "0"}%`);
  out.push("");
  for (const b of BUCKET_ORDER) {
    const list = rows.filter((r) => r.bucket === b);
    if (!list.length) continue;
    out.push(`── ${b} (${list.length}) ${"─".repeat(Math.max(0, 70 - b.length))}`);
    out.push(`  ${pad("time", 5)} ${pad("seller", 6)} ${pad("market", 14)} ${pad("prior q", 22)} ${pad("intent", 24)} ${pad("reason", 44)} message`);
    for (const r of list) {
      const prior = r.prior ? `${r.prior.kind}:${r.prior.use_case || "?"}` : "none";
      const reason = b === "SUSPECT" ? `[${r.base}] ${r.flags.map((f) => f.code).join(",")}` : r.reason;
      out.push(`  ${fmtLocal(r.at, tz)} ${pad(r.seller_initials, 6)} ${pad(r.market || "—", 14)} ${pad(prior, 22)} ${pad(`${r.intent || "—"}${r.confidence != null ? ` ${Number(r.confidence).toFixed(2)}` : ""}`, 24)} ${pad(reason, 44)} "${oneLine(redactText(r.body, { names: r.names, addresses: r.addresses }), 90)}"`);
      if (r.replay && !r.replay.error) {
        out.push(`        replay@HEAD: ${r.replay.intent} ${Number(r.replay.confidence ?? 0).toFixed(2)} lang=${r.replay.language}${r.replay.reply_language_source ? `(${r.replay.reply_language_source})` : ""} auto_reply=${r.replay.auto_reply_allowed} review=${r.replay.human_review} dryrun=${r.replay.decision_audit || "?"} ctx=${r.replay.context_use_case || "none"}/${r.replay.context_status}`);
        out.push(`        verdict: ${r.verdict}${r.verdict_detail ? `  [${r.verdict_detail}]` : ""}`);
      } else if (r.replay?.error) out.push(`        replay error: ${r.replay.error}`);
      if (b === "SUSPECT" && r.reason) out.push(`        base reason: ${r.reason}`);
    }
    out.push("");
  }
  // Stage transitions observed vs the lifecycle ladder.
  const observed = new Map();
  for (const r of rows) for (const e of r.autopilot) {
    if (e.stage_before && e.stage_after && e.stage_before !== e.stage_after && (!stageOrder.length || (stageOrder.includes(e.stage_before) && stageOrder.includes(e.stage_after)))) {
      const k = `${e.stage_before} → ${e.stage_after}`;
      observed.set(k, (observed.get(k) || 0) + 1);
    }
  }
  out.push("STAGE TRANSITIONS (lifecycle stage before→after on Seller Autopilot events for these replies; counts are events, not threads)");
  for (const [k, n] of [...observed].sort((a, b) => b[1] - a[1])) out.push(`  ${pad(k, 50)} ${n}`);
  if (stageOrder.length) {
    const reached = new Set([...observed.keys()].map((k) => k.split(" → ")[1]));
    const fromStages = new Set([...observed.keys()].map((k) => k.split(" → ")[0]));
    const never = [];
    for (let i = 0; i < stageOrder.length - 1; i++) {
      const k = `${stageOrder[i]} → ${stageOrder[i + 1]}`;
      if (!observed.has(k)) never.push(k);
    }
    out.push(`  never exercised (adjacent ladder steps): ${never.join("; ") || "none"}`);
    out.push(`  stages never entered: ${stageOrder.filter((s) => !reached.has(s) && !fromStages.has(s)).join(", ") || "none"}`);
  }
  out.push("");
  return out.join("\n");
}

export function buildFixtures(rows, { tz }) {
  return rows
    .filter((r) => r.bucket === "SUSPECT" || r.bucket === "REVIEW")
    .map((r, i) => {
      const red = (s) => redactText(s, { names: r.names, addresses: r.addresses });
      return {
        fixture_id: `rq-${localDate(Date.parse(r.at), tz)}-${String(i + 1).padStart(3, "0")}`,
        status: "candidate",
        expected: null,
        expected_note: "Unlabeled. A human or agent sets the expected intent/decision before this becomes a test.",
        bucket: r.bucket,
        base_bucket: r.base,
        suspect_flags: r.flags.map((f) => f.code),
        received_local: fmtLocal(r.at, tz),
        prior_question: r.prior
          ? { kind: r.prior.kind, use_case: r.prior.use_case, text: red(r.prior.body), message_type: r.prior.row.message_type || null }
          : null,
        intervening_inbound_count: r.intervening_redacted?.length ?? null,
        intervening_inbound: r.intervening_redacted || [],
        seller_message: red(r.body),
        current_classification: {
          intent: r.intent, confidence: r.confidence != null ? Number(Number(r.confidence).toFixed(2)) : null, language: r.seller_language, ambiguity_flags: r.ambiguity_flags,
          context_use_case: r.context_use_case, context_status: r.context_status, audit_reason: r.audit_reason,
          review_reason: r.review_reason, reason: r.reason,
        },
        replay_at_head: r.replay && !r.replay.error
          ? { intent: r.replay.intent, confidence: r.replay.confidence != null ? Number(Number(r.replay.confidence).toFixed(2)) : null, language: r.replay.language, auto_reply_allowed: r.replay.auto_reply_allowed, human_review: r.replay.human_review, context_use_case: r.replay.context_use_case, verdict: r.verdict }
          : null,
      };
    });
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const tz = arg("tz", "America/Chicago");
  const todayLocal = localDate(Date.now(), tz);
  const from = arg("from") || arg("date") || (flag("today") ? todayLocal : addDays(todayLocal, -1));
  const to = arg("to") || from;
  const start = localMidnightUtc(from, tz);
  const endFull = localMidnightUtc(addDays(to, 1), tz);
  const end = new Date(Math.min(endFull.getTime(), Date.now()));
  const label = `${from}${to !== from ? `..${to}` : ""}${end < endFull ? ` (so far, to ${fmtLocal(end.toISOString(), tz)} local)` : " (all day)"}`;

  const urlFile = arg("db-url-file");
  const url = String(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || (urlFile ? readFileSync(urlFile, "utf8") : "")).trim();
  if (!url) {
    console.error("SUPABASE_DB_URL / DATABASE_URL (or --db-url-file) is required.");
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let data;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    data = await loadData(client, start.toISOString(), end.toISOString());
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }

  const { isInternalTestPhone } = await import("../../src/lib/config/internal-phones.js");
  const bcc = await import("../../src/lib/domain/classification/build-conversation-context.js");
  const tplUseCase = new Map(data.templates.map((t) => [t.template_id, t.use_case]));
  const rows = assembleRows(data, {
    isInternal: isInternalTestPhone, tplUseCase, mapUseCase: bcc.mapMessageTypeToUseCase, deriveUseCase: bcc.deriveUseCaseFromBody,
  });
  const historyByThread = new Map();
  for (const h of data.history) {
    if (!historyByThread.has(h.thread_key)) historyByThread.set(h.thread_key, []);
    historyByThread.get(h.thread_key).push(h);
  }
  const { identifyReplyLanguage } = await import("../../src/lib/domain/classification/seller-reply-language.js");
  const { detectMessageLanguage } = await import("../../src/lib/domain/classification/reply-disposition-signals.js");
  for (const r of rows) {
    // OWNER RULE 2026-10-05: reply in the language the seller replied in.
    r.seller_reply_language = identifyReplyLanguage(r.body, { detected_language: r.classified_language, explicit: false });
    r.reply_language = r.reply?.message_body ? detectMessageLanguage(r.reply.message_body) : null;
    const b = baseBucket(r);
    r.base = b.bucket;
    r.reason = b.reason;
    r.flags = suspectFlags(r);
    r.bucket = r.flags.length ? "SUSPECT" : r.base;
    const since = r.prior ? Date.parse(r.prior.row.delivered_at || r.prior.sent_at) : 0;
    r.intervening_redacted = (historyByThread.get(r.thread_key) || [])
      .filter((h) => Date.parse(h.created_at) > since && Date.parse(h.created_at) < Date.parse(r.at))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((h) => ({ text: redactText(h.message_body, { names: r.names, addresses: r.addresses }), intent: h.detected_intent }));
  }

  if (!flag("no-replay")) {
    const { classify } = await import("../../src/lib/domain/classification/classify.js");
    const { replayInboundCase } = await import("../../src/lib/domain/inbound/inbound-replay-engine.js");
    await replayRows(rows, { buildConversationContext: bcc.buildConversationContext, classify, replayInboundCase, history: historyByThread, tplUseCase });
  }

  const { LIFECYCLE_STAGE_ORDER } = await import("../../src/lib/domain/lead-state/universal-lead-state-registry.js");
  const text = renderReport(rows, { label, tz, stageOrder: [...LIFECYCLE_STAGE_ORDER] });
  const outFile = arg("out");
  if (outFile) {
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(path.resolve(outFile), text);
    console.log(`report → ${path.resolve(outFile)}`);
  } else console.log(text);

  if (flag("emit-fixtures")) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.resolve(here, "../../tests/fixtures/reply-quality");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${from}.json`);
    const fixtures = buildFixtures(rows, { tz });
    writeFileSync(file, `${JSON.stringify({ generated_by: "scripts/ops/reply-quality-report.mjs", window: label, timezone: tz, redacted: true, candidates: fixtures }, null, 2)}\n`);
    console.log(`fixtures (${fixtures.length} candidates) → ${file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
