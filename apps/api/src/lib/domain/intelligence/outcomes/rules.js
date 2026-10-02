/**
 * IC8 DETERMINISTIC LABEL RULES (versioned; architecture §4).
 *
 * Each rule set is frozen data plus a pure function. A label definition names
 * the rule id@version it was computed with, and the definition_hash covers the
 * rule data, so changing a keyword or a pattern is a new label version, never
 * a silent relabel.
 *
 * Provenance (copied, not imported, so a label version cannot drift with
 * another team's in-flight edits):
 *   - STOP family: classification/classify.js COMPLIANCE_EXACT at HEAD 41b6a3fa
 *     (carrier keywords + the multilingual exact set) plus "remove"/"remove me"
 *     from the IC8 data audit's reference label.
 *   - auto-reply / carrier notice / platform reaction shapes: aligned with the
 *     7.2 Layer-2 patterns (reply-disposition-signals.js, emoji-interpretation.js,
 *     working tree 2026-10-01). Precision/recall against the 7.2
 *     operator-reviewed corpus is published when that export exists.
 *   - stage order: closings/closing-authority.js STAGE_ORDER (a test re-reads it).
 */

export const STOP_FAMILY_RULES_V1 = Object.freeze({
  id: "stop_family_exact",
  version: 1,
  description:
    "The whole message (trimmed, lower-cased, edge punctuation stripped, inner whitespace collapsed) is a STOP-family keyword.",
  keywords: Object.freeze([
    "stop", "end", "cancel", "quit", "unsubscribe", "stopall", "opt out", "optout", "opt-out", "remove", "remove me",
    "para", "pare", "paren", "detente", "deténgase", "detengase", "basta", "cancela",
    "parar", "cancelar", "sair",
    "ferma", "fermati", "cancella",
    "arrêt", "arret", "annuler",
    "stopp", "aufhören", "abmelden",
    "dừng", "dung",
    "zatrzymaj", "odpisz",
    "עצור", "הפסק", "ביטול",
    "停止", "取消", "停",
    "중지", "그만", "취소", "멈춰",
    "止めて", "やめて", "やめろ",
    "توقف", "قف", "الغاء", "أوقف",
    "стоп", "остановить", "отмена", "хватит",
    "หยุด", "ยกเลิก",
    "बंद", "रोको", "रुको",
    "σταμάτα", "στοπ", "ακύρωση",
  ]),
});

const STOP_SET_CACHE = new WeakMap();
function stopSet(rules) {
  if (!STOP_SET_CACHE.has(rules)) STOP_SET_CACHE.set(rules, new Set(rules.keywords));
  return STOP_SET_CACHE.get(rules);
}

/** NFC, zero-width removed, smart quotes straightened, whitespace collapsed (case kept). */
export function normalizeReplyText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Accent-folded, lower-cased form of normalizeReplyText. */
export function foldReplyText(value) {
  return normalizeReplyText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function isStopFamilyExact(text, rules = STOP_FAMILY_RULES_V1) {
  const lowered = normalizeReplyText(text).toLowerCase();
  if (!lowered) return false;
  const bare = lowered.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "").replace(/\s+/g, " ");
  const set = stopSet(rules);
  return set.has(lowered) || set.has(bare);
}

export const MEANINGFUL_REPLY_RULES_V1 = Object.freeze({
  id: "meaningful_reply",
  version: 1,
  description:
    "Inbound fragments on a thread within 3 minutes of each other form one logical reply. A logical reply is meaningful unless it is empty, a STOP-family keyword, a platform reaction or emoji-only message (v1: every pure reaction counts as no engagement), a carrier/system notice, a device or business auto-reply, or single-character noise.",
  fragmentMergeMs: 180000,
  exclusionOrder: Object.freeze(["empty", "stop_keyword", "reaction_no_engagement", "carrier_system_notice", "auto_reply", "noise"]),
  carrierNoticePatterns: Object.freeze([
    "\\b(?:is|has been) (?:disconnected|no longer in service)\\b",
    "\\b(?:message|text) (?:could not be|was not|wasn't) delivered\\b",
    "^free msg\\b",
    "\\bmsg (?:&|and) data rates\\b",
    "\\bthis (?:number|line|inbox) (?:is|does) not (?:monitored|accept\\w*|receive\\w*)\\b",
    "\\bnot (?:monitored|accepting (?:text|sms)|able to receive text)",
    "\\byou have been unsubscribed\\b|\\byou(?:'ve| have) opted out\\b",
  ]),
  autoReplyPatterns: Object.freeze([
    "\\bsent from my car\\b",
    "\\bthank you for (?:contacting|texting|your (?:message|text))\\b[\\s\\S]{0,80}?\\b(?:we will|we'll|someone will|will (?:respond|reply|get back))\\b",
    "\\b(?:our|the) (?:office|business) (?:hours|is (?:currently )?closed)\\b",
    "\\bduring (?:normal |regular |our )?business hours\\b",
    "\\b(?:do not|don't|please do not) reply to this (?:message|text|number)\\b",
    "\\bdo not disturb\\b[^.]{0,40}\\bdriving\\b|\\bdriving\\b[^.]{0,40}\\bdo not disturb\\b",
    "\\b(?:auto[- ]?reply|auto[- ]?response|automatic reply|automated (?:message|reply|response))\\b",
    "\\b(?:i am|i'm|im) (?:currently )?out of (?:the )?office\\b",
    "^(?:estoy|ando) (?:manejando|conduciendo)\\b",
    "^(?:estou|to|tou) dirigindo\\b",
    "^toi dang lai xe\\b",
  ]),
  drivingPattern: "^(?:i'?m|i am|im) (?:currently |driving right now|driving now|driving)\\b",
  drivingDestinationPattern: "\\b(?:by|past|to|over|down|out to|toward|towards)\\b[^.]{0,30}\\b(?:house|property|home|place|address|there)\\b",
  drivingMaxWords: 14,
  reactionVerbs: Object.freeze([
    "liked", "loved", "laughed at", "emphasized", "emphasised", "disliked", "questioned",
    "le gusto", "le encanto", "se rio de", "enfatizo", "no le gusto", "pregunto por",
  ]),
});

const REGEX_CACHE = new Map();
function compiled(pattern, flags = "") {
  const cacheKey = `${flags}/${pattern}`;
  if (!REGEX_CACHE.has(cacheKey)) REGEX_CACHE.set(cacheKey, new RegExp(pattern, flags));
  return REGEX_CACHE.get(cacheKey);
}

const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s\p{P}\p{S}]+$/u;
const HAS_PICTOGRAPH_RE = /\p{Extended_Pictographic}/u;

export function isPlatformReaction(text, rules = MEANINGFUL_REPLY_RULES_V1) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  if (!/[\p{L}\p{N}]/u.test(normalized) && HAS_PICTOGRAPH_RE.test(normalized) && EMOJI_ONLY_RE.test(normalized)) return true;
  if (!normalized.includes('"')) return false;
  if (/^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]+)\s*to\s+"/u.test(normalized)) return true;
  const folded = foldReplyText(normalized);
  if (/^reacted\s+\S{1,16}\s+to\s+"/u.test(folded)) return true;
  if (/^removed\s+an?\s+\S+\s+from\s+"/u.test(folded)) return true;
  return rules.reactionVerbs.some((verb) => folded.startsWith(`${verb} "`));
}

/**
 * Classify one logical reply (a string, or a mergeInboundFragments() entry
 * with `parts`). Returns { meaningful, exclusion }; the exclusion is the FIRST
 * matching class in rules.exclusionOrder.
 *   - a STOP-family keyword in ANY fragment (or across the merge) makes the
 *     whole logical reply an opt-out: the opt-out dominates;
 *   - reaction fragments are dropped; a reply made only of reactions is
 *     reaction_no_engagement;
 *   - the remaining text is checked for notices, auto-replies and noise.
 */
export function classifyLogicalReply(reply, rules = MEANINGFUL_REPLY_RULES_V1, stopRules = STOP_FAMILY_RULES_V1) {
  const parts = reply && typeof reply === "object" && Array.isArray(reply.parts) ? reply.parts : [String(reply ?? "")];
  const fragments = parts.map((part) => normalizeReplyText(part)).filter(Boolean);
  if (!fragments.length) return { meaningful: false, exclusion: "empty" };
  if (fragments.some((part) => isStopFamilyExact(part, stopRules)) || isStopFamilyExact(fragments.join(" "), stopRules)) {
    return { meaningful: false, exclusion: "stop_keyword" };
  }
  const spoken = fragments.filter((part) => !isPlatformReaction(part, rules));
  if (!spoken.length) return { meaningful: false, exclusion: "reaction_no_engagement" };
  const normalized = spoken.join(" ");
  const folded = foldReplyText(normalized);
  if (rules.carrierNoticePatterns.some((p) => compiled(p).test(folded))) return { meaningful: false, exclusion: "carrier_system_notice" };
  if (rules.autoReplyPatterns.some((p) => compiled(p).test(folded))) return { meaningful: false, exclusion: "auto_reply" };
  const words = folded.split(/\s+/).filter(Boolean).length;
  if (
    compiled(rules.drivingPattern).test(folded) &&
    /\bdriving\b/.test(folded) &&
    words <= rules.drivingMaxWords &&
    !compiled(rules.drivingDestinationPattern).test(folded)
  ) {
    return { meaningful: false, exclusion: "auto_reply" };
  }
  if (/^[.\-_,;:~]+$/.test(normalized) || (/^[a-z]$/i.test(normalized) && !/^[ynk]$/i.test(normalized))) {
    return { meaningful: false, exclusion: "noise" };
  }
  return { meaningful: true, exclusion: null };
}

/**
 * Merge split SMS fragments: an inbound within `windowMs` of the PREVIOUS
 * inbound on the same thread joins its logical reply (chained). Input rows need
 * { id, created_at (true time), message_body }. Output is ordered by time.
 */
export function mergeInboundFragments(messages, { windowMs = MEANINGFUL_REPLY_RULES_V1.fragmentMergeMs, timeOf } = {}) {
  const placed = [];
  for (const message of messages || []) {
    const t = timeOf ? timeOf(message) : Date.parse(message?.created_at);
    if (!Number.isFinite(t)) continue;
    placed.push({ t, message });
  }
  placed.sort((a, b) => a.t - b.t || String(a.message.id ?? "").localeCompare(String(b.message.id ?? "")));
  const logical = [];
  let current = null;
  let lastT = null;
  for (const { t, message } of placed) {
    if (current && lastT !== null && t - lastT <= windowMs) {
      current.ids.push(message.id ?? null);
      current.parts.push(String(message.message_body ?? ""));
      current.last_at = t;
    } else {
      current = { first_at: t, last_at: t, ids: [message.id ?? null], parts: [String(message.message_body ?? "")] };
      logical.push(current);
    }
    lastT = t;
  }
  return logical.map((entry) => ({
    first_at: entry.first_at,
    last_at: entry.last_at,
    ids: entry.ids.filter((id) => id !== null),
    fragment_count: entry.parts.length,
    parts: entry.parts,
    text: entry.parts.join(" "),
  }));
}

/** closings/closing-authority.js STAGE_ORDER at HEAD 41b6a3fa (a test re-reads the source). */
export const STAGE_ORDER_V1 = Object.freeze([
  "ownership_confirmation",
  "offer_interest",
  "asking_price",
  "property_condition",
  "offer",
  "formal_contract",
  "disposition",
  "under_contract",
  "prepared_to_close",
  "closed",
]);

export const STAGE_PROGRESS_RULES_V1 = Object.freeze({
  id: "stage_forward_move",
  version: 1,
  description: "A move to a later stage in STAGE_ORDER. A bare `closed` is closed-lost and never progress.",
  stageOrder: STAGE_ORDER_V1,
  terminalLost: Object.freeze(["closed"]),
});

/** True when `to` is strictly later than `from` and is not the closed-lost terminal. */
export function isForwardStageMove(from, to, rules = STAGE_PROGRESS_RULES_V1) {
  const toStage = String(to ?? "").trim().toLowerCase();
  if (!toStage || rules.terminalLost.includes(toStage)) return false;
  const a = rules.stageOrder.indexOf(String(from ?? "").trim().toLowerCase());
  const b = rules.stageOrder.indexOf(toStage);
  return a >= 0 && b > a;
}

export const FACT_COMMITMENT_RULES_V1 = Object.freeze({
  id: "fact_commitment_accept",
  version: 1,
  description:
    "A canonical fact counts when persisted with commitment CONFIRMED, or LIKELY that was later confirmed (confirmed_at set). canonical:false entries never count.",
  accepted: Object.freeze(["CONFIRMED"]),
  acceptedWhenConfirmed: Object.freeze(["LIKELY"]),
});

export const REAL_REVIEW_HOLD_RULES_V1 = Object.freeze({
  id: "real_review_hold",
  version: 1,
  description:
    "A review hold counts when it is a decision-ledger exception_sla_deadline or a human exception, and it is not a P7 placeholder (gap-recovery stamp).",
  kinds: Object.freeze(["exception_sla_deadline", "human_exception"]),
});

export const TRANSACTION_RULES_V1 = Object.freeze({
  id: "transaction_events",
  version: 1,
  description: "offer_presented / contract / closing are counted from transaction records only (never inferred from text).",
  types: Object.freeze({ offer_presented: "offer_presented", contract: "contract_signed", closing: "closed_won" }),
});
