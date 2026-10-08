/**
 * REPLY-DISPOSITION SIGNALS — the replies that already have a category.
 *
 * Owner request, 2026-10-01: "New Replies needs to genuinely be new replies
 * from people who are not suppressed, not interested, not the owner, etc."
 *
 * Measured the same day: 111 threads sat in New Replies. 70 carried
 * last_intent `unclear`, and the bodies were not unclear at all:
 *   wrong person  "Not James" · "Sorry, this isn't <name>" · "Disculpa no soy <name>"
 *                 · "No. I am not on <street> Ave." · "<type>, <name> ... wrong on both"
 *   sold          "Sold"
 *   not for sale  "Not trying to sale" · "Keeping that one" · "No plans to sell"
 *                 · "No está de venta" · "No esta ala venta." · "Not 4 sale" · "Not intested"
 *   hostile       "go get a real job fool" · "any of your bees wax" · "Que te importa"
 *                 · "Do your homework" · "Voce deve fazer o seu trabalho de casa"
 *   not a reply   "I'm Driving - Sent from My Car" · "T"
 *                 (tapbacks / emoji are read in context by emoji-interpretation.js)
 *   language      "I dont speak spanish" · "English" · "I can't Reed Spanish"
 *   competitor    "Estamos en el mismo negocio yo también compro casas"
 *
 * Every detector here is PURE and DETERMINISTIC (no I/O, no model), works on
 * an accent-folded copy of the text so "No esta" and "No está", "Khong phai"
 * and "Không phải" are the same words, and is anchored or phrase-bound so a
 * real seller sentence cannot trip it by accident. Negative cases are pinned in
 * tests/critical/new-replies-reply-disposition.test.mjs.
 *
 * WHAT THIS MODULE DOES NOT DO: it never decides opt-out. classify.js runs its
 * opt-out/STOP detection first and returns before these signals are read, so
 * nothing here can downgrade a STOP. Hostility detected here is hostility
 * WITHOUT opt-out language by construction.
 */

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;

/** Whitespace, zero-width characters and smart quotes normalized; case kept. */
export function normalizeReplyText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Accent-folded, lowercased. "Không phải" -> "khong phai", "está" -> "esta". */
export function foldReplyText(value) {
  return normalizeReplyText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * The lines of a (possibly merged) burst, each folded. normalizeReplyText
 * collapses line breaks, so a burst like "Never have\nNo" or "Chris?\n...\nWho
 * is chris?" is only readable line by line from the raw text.
 */
export function foldReplyLines(value) {
  return String(value ?? "")
    .split(/\r?\n+/)
    .map((line) => foldReplyText(line))
    .filter(Boolean);
}

function wordCount(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const row = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (s[i - 1] === t[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[t.length];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anyMatch(text, patterns) {
  for (const re of patterns) {
    if (re.test(text)) return re;
  }
  return null;
}

// ─── Not a reply: provider / system auto-responses, noise ─────────────────────
//
// Layer 2 of the 7.2 classifier. Vacation replies, driving-mode replies,
// carrier/system notices and business auto-replies are not seller
// engagement. The event, its classification and its timestamp are still kept;
// only the New Replies item is not created.

const AUTO_REPLY_PATTERNS = [
  /\bsent from my car\b/,
  /\bthank you for (?:contacting|texting|your (?:message|text))\b[\s\S]{0,80}?\b(?:we will|we'll|someone will|will (?:respond|reply|get back))\b/,
  /\b(?:our|the) (?:office|business) (?:hours|is (?:currently )?closed)\b/,
  /\bduring (?:normal |regular |our )?business hours\b/,
  /\bthis (?:number|line|inbox) (?:is|does) not (?:monitored|accept\w*|receive\w*)\b/,
  /\bnot (?:monitored|accepting (?:text|sms)|able to receive text)/,
  /\b(?:is|has been) (?:disconnected|no longer in service)\b/,
  /\b(?:message|text) (?:could not be|was not|wasn't) delivered\b/,
  /^free msg\b/,
  /\bmsg (?:&|and) data rates\b/,
  /\b(?:do not|don't|please do not) reply to this (?:message|text|number)\b/,
  /\bdo not disturb\b[^.]{0,40}\bdriving\b|\bdriving\b[^.]{0,40}\bdo not disturb\b/,
  /\b(?:auto[- ]?reply|auto[- ]?response|automatic reply|automated (?:message|reply|response))\b/,
  /\b(?:i am|i'm|im) (?:currently )?out of (?:the )?office\b/,
  /^(?:estoy|ando) (?:manejando|conduciendo)\b/,
  /^(?:estou|to|tou) dirigindo\b/,
  /^toi dang lai xe\b/,
];
// "I'm driving" on its own (or with a "talk later") is the phone's or the
// person's way of saying "not now" -- it carries no answer. "I'm driving to the
// house now" is a real message and must not match.
const DRIVING_RE = /^(?:i'?m|i am|im) (?:currently |driving right now|driving now|driving)\b/;
const DRIVING_DESTINATION_RE = /\b(?:by|past|to|over|down|out to|toward|towards)\b[^.]{0,30}\b(?:house|property|home|place|address|there)\b/;

export function detectAutoReplyMessage(message) {
  const folded = foldReplyText(message);
  if (!folded) return { matched: false };
  const hit = anyMatch(folded, AUTO_REPLY_PATTERNS);
  if (hit) {
    const carrier = /disconnected|no longer in service|could not be|was not|wasn't|free msg|data rates/.test(folded);
    return { matched: true, rule_id: carrier ? "carrier_system_notice" : "auto_reply_message" };
  }
  const driving = DRIVING_RE.test(folded)
    && /\bdriving\b/.test(folded)
    && wordCount(folded) <= 14
    && !DRIVING_DESTINATION_RE.test(folded);
  return driving ? { matched: true, rule_id: "auto_reply_driving" } : { matched: false };
}

/** One stray letter or bare punctuation ("T", "g", "."). y/n/k are answers. */
export function detectNoiseMessage(message) {
  const raw = normalizeReplyText(message);
  if (!raw) return false;
  if (/^[.\-_,;:~]+$/.test(raw)) return true;
  return /^[a-z]$/i.test(raw) && !/^[ynk]$/i.test(raw);
}

// ─── Wrong person / not the owner ────────────────────────────────────────────

// Words that follow "not" / "this isn't" / "no soy" and are NOT a person.
const NAME_STOPWORDS = new Set([
  "a", "an", "the", "for", "my", "mine", "me", "him", "her", "it", "that", "this", "those", "these",
  "there", "here", "sure", "really", "now", "today", "tonight", "yet", "anymore", "interested",
  "interesting", "intrested", "intersted", "selling", "sold", "sale", "sell", "available", "right",
  "true", "correct", "good", "bad", "so", "too", "quite", "very", "much", "at", "in", "on", "to",
  "of", "yours", "ours", "theirs", "his", "hers", "ever", "never", "again", "home", "worth",
  "enough", "likely", "possible", "happening", "gonna", "going", "looking", "trying", "planning",
  "ready", "thinking", "considering", "exactly", "necessarily", "any", "all", "us", "them", "you",
  "u", "ur", "your", "yet", "really", "familiar", "aware", "owner", "the owner", "a buyer",
  "free", "busy", "home", "around", "here", "able", "allowed", "doing", "done", "sure",
  "happy", "kidding", "joking", "serious", "stupid", "dumb", "crazy", "rich", "desperate",
  "interested.", "now.", "please", "thanks", "thank", "okay", "ok", "yes", "no",
  // Spanish / Portuguese after "no soy" / "não sou"
  "de", "del", "el", "la", "los", "las", "un", "una", "uno", "tu", "su", "mi", "dueno", "duena",
  "propietario", "propietaria", "interesado", "interesada", "vendedor", "vendedora", "quien",
  "esa", "ese", "eso", "mas", "muy", "tan", "nada", "ninguno", "ninguna", "nadie", "agente",
  "inversionista", "tonto", "tonta", "estupido", "estupida", "idiota", "rico", "rica", "pobre",
  "millonario", "loco", "loca", "nuevo", "nueva", "de aqui", "o", "a", "dono", "dona",
  "proprietario", "proprietaria", "interessado", "interessada", "daqui",
]);

const NAME_TOKEN = "([a-z][a-z'-]{1,15})";
const LEAD_IN = "(?:(?:no|nope|nah|sorry|um|uh|hi|hey|hello|lo siento|disculpa|disculpe|perdon|desculpa|desculpe|xin loi)\\b[\\s,.!]*)*";

const NOT_NAME_RE = new RegExp(`^${LEAD_IN}not\\s+${NAME_TOKEN}[\\s.!]*$`);
const THIS_ISNT_NAME_RE = new RegExp(
  `^${LEAD_IN}(?:this|it|that|u|you)\\s*(?:is\\s+not|isn'?t|is\\s+n'?t|ain'?t|aint|are\\s+not|aren'?t)\\s+${NAME_TOKEN}(?:\\s+[a-z][a-z'-]{1,20})?[\\s.!]*$`,
);
const I_AM_NOT_NAME_RE = new RegExp(`^${LEAD_IN}(?:i'?m|i am|im)\\s+not\\s+${NAME_TOKEN}[\\s.!]*$`);
const NO_SOY_NAME_RE = new RegExp(`^${LEAD_IN}(?:yo\\s+)?no\\s+soy\\s+(?:el\\s+|la\\s+)?${NAME_TOKEN}[\\s.!]*$`);
const NAO_SOU_NAME_RE = new RegExp(`^${LEAD_IN}(?:eu\\s+)?nao\\s+sou\\s+(?:o\\s+|a\\s+)?${NAME_TOKEN}[\\s.!]*$`);
const KHONG_PHAI_NAME_RE = new RegExp(`^${LEAD_IN}(?:toi\\s+|em\\s+|anh\\s+|chi\\s+)?(?:khong|ko|k)\\s+phai\\s+(?:la\\s+)?${NAME_TOKEN}[\\s.!]*$`);

const EXPLICIT_WRONG_PERSON_PATTERNS = [
  // "wrong on both" (wrong name AND wrong property type), "wrong name", "wrong guy"
  /\bwrong\s+(?:on\s+both|name|names|guy|lady|gal|dude|person|people|contact|individual|party|family)\b/,
  /\b(?:you|u)\s+(?:have|got|has|reached|texted|are\s+texting)\s+(?:the\s+)?wrong\s+(?:person|number|guy|lady|name|one)\b/,
  // Spanish / Portuguese / Vietnamese wrong person
  /\bno\s+soy\s+(?:yo|la\s+persona|esa\s+persona|quien\s+(?:busca|buscas|buscan))\b/,
  /\b(?:persona|numero)\s+equivocad[oa]\b/,
  /\bse\s+equivoc(?:o|aron)\s+de\s+(?:persona|numero)\b/,
  /\b(?:pessoa|numero)\s+errad[oa]\b/,
  /\bnao\s+sou\s+(?:eu|essa\s+pessoa|a\s+pessoa)\b/,
  /\b(?:nham|sai)\s+(?:so|nguoi)\b/,
];

// "I am not on Vincent Ave" -- the respondent is not at the property we named.
const STREET_SUFFIX = "(?:ave|avenue|st|street|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|way|pl|place|pkwy|parkway|cir|circle|ter|terrace|hwy|highway|trl|trail|cv|cove)";
const NOT_ON_STREET_RE = new RegExp(
  `\\b(?:i'?m|i am|im|we'?re|we are)\\s+not\\s+(?:on|at)\\s+(?:\\d+\\s+)?[a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*){0,2}\\s+${STREET_SUFFIX}\\b`,
);

// Answers to an OWNERSHIP question only (our last outbound asked whether they
// own the property). "Never have" / "Nunca lo he sido" answers it: never the
// owner. "Estás mal informado" / "you're misinformed" denies its premise. Out
// of that question both mean other things ("never have [considered selling]"),
// so the caller must say the question was about ownership.
const NEVER_OWNED_LINE_PATTERNS = [
  /^(?:no[\s,.!]+)?(?:i\s+)?(?:have\s+)?never\s+(?:have|did|was|been|owned(?:\s+it)?|had\s+it)(?:\s+been)?(?:\s+the\s+owner)?[\s.!]*$/,
  /^(?:no[\s,.!]+)?nunca\s+(?:he\s+sido|fui|lo\s+he\s+sido|lo\s+fui|la\s+he\s+tenido|lo\s+he\s+tenido|ha\s+sido\s+mi[ao])(?:\s+(?:el|la)\s+duen[oa])?[\s.!]*$/,
  /^(?:nao[\s,.!]+)?nunca\s+(?:fui|tive|foi\s+minha?)(?:\s+(?:o|a)\s+(?:dono|dona|proprietari[oa]))?[\s.!]*$/,
];
const PREMISE_DENIAL_PATTERNS = [
  /\bmal\s+informad[oa]s?\b/,
  /\b(?:you'?re|you\s+are|your|ur|u\s+r)\s+mis-?informed\b/,
  /\b(?:wrong|bad|incorrect|outdated)\s+info(?:rmation)?\b/,
  /\binformacion\s+(?:equivocada|incorrecta|erronea)\b/,
  /\binformac(?:ao|oes)\s+(?:errada|incorreta|desatualizada)s?\b/,
];

function cleanName(value) {
  const name = foldReplyText(value).replace(/[^a-z'-]/g, "");
  return name.length >= 2 ? name : "";
}

/** True when the raw text spells this token with a capital first letter. */
function isCapitalizedInRaw(raw, token) {
  if (!token) return false;
  const re = new RegExp(`(?:^|[^A-Za-z])(${escapeRegExp(token)})(?![A-Za-z])`, "i");
  const match = foldReplyText(raw) === raw.toLowerCase()
    ? re.exec(raw)
    : re.exec(raw.normalize("NFD").replace(/[̀-ͯ]/g, ""));
  return Boolean(match && /^[A-Z]/.test(match[1]));
}

/**
 * "This reply says we reached the wrong person."
 *
 * A name after "not" / "this isn't" / "no soy" counts only when it is the name
 * we greeted in our last outbound (context), or is written as a proper name
 * (capitalized, not a stopword). "Not interested", "this isn't a good time",
 * "no soy de aquí" never match.
 */
export function detectWrongPersonClaim(message, { addressee_name = null, ownership_question = false } = {}) {
  const raw = normalizeReplyText(message);
  const folded = foldReplyText(raw);
  if (!folded) return { matched: false };
  const addressee = cleanName(addressee_name);

  if (addressee) {
    const contextRe = new RegExp(
      `\\b(?:not|isn'?t|is not|ain'?t|aint|no soy|nao sou|(?:khong|ko|k) phai(?: la)?)\\s+${escapeRegExp(addressee)}\\b`,
    );
    if (contextRe.test(folded)) {
      return { matched: true, rule_id: "wrong_person_addressee_negated", confidence: 0.93, evidence: raw };
    }
  }

  for (const [re, rule_id] of [
    [NOT_NAME_RE, "wrong_person_not_name"],
    [THIS_ISNT_NAME_RE, "wrong_person_this_isnt_name"],
    [I_AM_NOT_NAME_RE, "wrong_person_i_am_not_name"],
    [NO_SOY_NAME_RE, "wrong_person_no_soy_name"],
    [NAO_SOU_NAME_RE, "wrong_person_nao_sou_name"],
    [KHONG_PHAI_NAME_RE, "wrong_person_khong_phai_name"],
  ]) {
    const match = re.exec(folded);
    if (!match) continue;
    const token = match[1];
    if (NAME_STOPWORDS.has(token)) continue;
    const sameAsAddressee = addressee && token === addressee;
    // A lowercase token is accepted for the apologetic Spanish/Vietnamese form
    // ("disculpa no soy dan") where people rarely capitalize; English needs
    // the proper-name spelling or the context name.
    const apologetic = /^(?:sorry|lo siento|disculpa|disculpe|perdon|desculpa|desculpe|xin loi)\b/.test(folded);
    const nonEnglish = rule_id !== "wrong_person_not_name"
      && rule_id !== "wrong_person_this_isnt_name"
      && rule_id !== "wrong_person_i_am_not_name";
    if (sameAsAddressee || isCapitalizedInRaw(raw, token) || (nonEnglish && apologetic)) {
      return { matched: true, rule_id, confidence: sameAsAddressee ? 0.93 : 0.88, evidence: raw };
    }
  }

  const explicit = anyMatch(folded, EXPLICIT_WRONG_PERSON_PATTERNS);
  if (explicit) return { matched: true, rule_id: "wrong_person_explicit", confidence: 0.9, evidence: raw };

  if (ownership_question) {
    if (foldReplyLines(message).some((line) => anyMatch(line, NEVER_OWNED_LINE_PATTERNS))) {
      return { matched: true, rule_id: "wrong_person_never_owned", confidence: 0.85, evidence: raw };
    }
    if (anyMatch(folded, PREMISE_DENIAL_PATTERNS)) {
      return { matched: true, rule_id: "wrong_person_premise_denied", confidence: 0.75, evidence: raw };
    }
  }

  if (NOT_ON_STREET_RE.test(folded)) {
    return { matched: true, rule_id: "wrong_person_not_at_property", confidence: 0.85, evidence: raw };
  }
  return { matched: false };
}

// ─── Sold ────────────────────────────────────────────────────────────────────

const SOLD_SHORT_PATTERNS = [
  // "Sold" / "Sold." / "It's sold" / "Already sold" / "Sold last year" -- whole message.
  /^(?:(?:it|it's|its|it is|that|that's|thats|that was|was|been|has been|already|yes|yeah|yep|sorry|nope|no)[\s,.!]*)*sold(?:\s+(?:it|already|out|last\s+(?:week|month|year)|(?:a\s+)?(?:while|long\s+time|few\s+\w+|couple\s+\w+)\s+ago|in\s+\d{4}|\d{4}))?[\s.!]*$/,
  // Spanish: "Vendida", "Ya se vendió", "Ya está vendida", "Se vendió hace un año"
  /^(?:(?:ya|si|lo siento|disculpa|no)[\s,.!]*)*(?:(?:ya\s+)?se\s+vendio|(?:ya\s+)?(?:esta|fue)\s+vendid[ao]|vendid[ao])(?:\s+(?:la casa|la propiedad|hace\s+\w+(?:\s+\w+)?))?[\s.!]*$/,
  // Portuguese: "Vendida", "Já foi vendida", "Já vendi"
  /^(?:ja\s+)?(?:foi\s+)?vendid[ao][\s.!]*$/,
  /^(?:(?:nao|sim)[\s,.!]*)?ja\s+vend(?:i|emos)\b[^?]*$/,
  // Vietnamese: "Đã bán", "Bán rồi", "Bán nhà rồi"
  /^(?:(?:khong|ko)[\s,.!]*)?(?:da\s+ban(?:\s+roi)?|ban\s+(?:nha\s+)?roi)[\s.!]*$/,
];

export function detectSoldShort(message) {
  const folded = foldReplyText(message);
  if (!folded || folded.includes("?")) return false;
  return Boolean(anyMatch(folded, SOLD_SHORT_PATTERNS));
}

// ─── Not for sale / not interested ───────────────────────────────────────────

const NOT_FOR_SALE_PATTERNS = [
  // English, typo-tolerant
  /\bnot\s+(?:trying|looking|planning|wanting|going|willing|thinking\s+(?:of|about)|interested\s+in)\s+(?:to\s+)?(?:sale|sell|selling)\b/,
  /\bnot\s+(?:to|2)\s+sell\b/,
  /\bnot\s*(?:4|for|fore|four)\s*(?:sa(?:le|el|l)|sel+)\b/,
  /\bno(?:t)?\s+plans?\s+(?:to|of|for|on)\s+sell(?:ing)?\b/,
  /\bkeeping\s+(?:that|this)\s+one\b/,
  /\b(?:i'?m|i am|we'?re|we are|im)\s+keeping\s+(?:it|that|this|the\s+(?:house|property|home|place))\b/,
  /^keeping\s+(?:it|that|this)\b/,
  /\bnot\s+int\w{0,4}s\w{0,3}ed\b/,
  /^n+o+[\s,.!]*(?:bye|thanks|thank you|thx|ty|gracias)\b/,
  /\b(?:will\s+never|never\s+will|would\s+never)\s+sell\b/,
  /\bnot\s+on\s+the\s+market\b/,
  /\bnot\s+selling\s+(?:it|the\s+(?:house|property|home)|right\s+now|at\s+this\s+time|anytime\s+soon)\b/,
  // "I've owned it 20 years and am a lifer" -- staying for good.
  /\b(?:i'?m|i\s+am|im|am|we'?re|we\s+are)\s+(?:a\s+)?lifers?\b/,
  /\bhere\s+for\s+life\b/,
  /\b(?:staying|stay)\s+put\b/,
  /\bforever\s+home\b/,
  /\bnever\s+(?:leaving|moving)\b/,
  // Spanish
  /\bno\s+(?:esta|estan|es)\s+(?:de|a|en|para\s+la|ala|a\s+la)\s*venta\b/,
  // round 10 (2026-10-08 audit): misspelled "venta" ("No esta de bents", "No
  // esta d vents", "No esta en banta") and a truncated "No la vend".
  /\bno\s+(?:esta|estan|es)\s+(?:de|d|a|en|para\s+la|ala|a\s+la)\s*(?:vents?|bents?|bentas?|banta|vnta|vemta)\b/,
  /\bno\s+(?:la|lo)\s+vend[\s.!]*$/,
  /\bno\s+(?:estoy|estamos)\s+vendiendo\b/,
  /\bno\s+(?:la\s+|lo\s+)?vend(?:o|emos)\b/,
  /\bno\s+(?:se\s+)?vende\b/,
  /\bno\s+(?:pienso|planeo|quiero|queremos|pensamos|planeamos|tengo\s+planes\s+de|tenemos\s+planes\s+de)\s+vender\b/,
  /\bno\s+(?:estoy|estamos)\s+interesad[oa]s?\b/,
  /^no,?\s+gracias\b/,
  // Portuguese
  /\bnao\s+(?:esta|estao)\s+a\s*venda\b/,
  /\bnao\s+(?:quero|queremos|pretendo|vou)\s+vender\b/,
  /\bnao\s+(?:estou|estamos)\s+vendendo\b/,
  /\bnao\s+tenho\s+interesse\b/,
  /\bnao\s+vendo\b/,
  // Vietnamese
  /\bkhong\s+(?:muon\s+)?ban\b/,
  /\bkhong\s+quan\s+tam\b/,
  /\bkhong\s+co\s+nhu\s+cau\b/,
];

// "I won't sell for less than 300k" is a price, not a decline.
const PRICE_FLOOR_RE = /\b(?:less\s+than|under|below|at\s+least|por\s+menos\s+de|menos\s+de|minimo|abaixo\s+de)\b[^.!?]{0,20}\d/;
// "Not on the market but you're welcome to make an offer" invites a bid: the
// classifier's own asks-offer rules decide it, never this decline detector.
const OFFER_INVITATION_RE =
  /\b(?:welcome|free)\s+to\s+(?:make|send|submit)\b|\b(?:make|send|give)\s+(?:me|us)\s+an?\s+offer\b|\bopen\s+to\s+(?:an?\s+)?offers?\b|\b(?:hagame|hazme|mandame|envieme)\s+una\s+oferta\b/;

/**
 * "not inter stud" / "not intrested" -- a misspelled or autocorrect-split "not
 * interested". The word after "not" must start with "int"; it (or it joined
 * with the next word) must be within a small edit distance of "interested".
 * "not into it", "not intended", "not interesting" stay out.
 */
function hasMisspelledNotInterested(folded) {
  const tokens = folded.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] !== "not" || !tokens[i + 1].startsWith("int")) continue;
    const one = tokens[i + 1];
    if (editDistance(one, "interested") <= 2) return true;
    const two = tokens[i + 2] ? one + tokens[i + 2] : "";
    if (two && two.length <= 12 && editDistance(two, "interested") <= 2) return true;
  }
  return false;
}

export function detectNotForSale(message) {
  const folded = foldReplyText(message);
  if (!folded || PRICE_FLOOR_RE.test(folded) || OFFER_INVITATION_RE.test(folded)) return { matched: false };
  const hit = anyMatch(folded, NOT_FOR_SALE_PATTERNS);
  if (hit) return { matched: true, rule_id: "not_for_sale_multilingual" };
  if (hasMisspelledNotInterested(folded)) return { matched: true, rule_id: "not_interested_misspelled" };
  return { matched: false };
}

// ─── Hostility without opt-out language ──────────────────────────────────────

const HOSTILE_INSULT_PATTERNS = [
  /\bnone\s+of\s+(?:your|ur|yo)\s+(?:business|concern|bees?\s*wax)\b/,
  /\b(?:any|none)\s+of\s+(?:your|ur|yo)\s+bees?\s*wax\b/,
  /\bmind\s+(?:your|ur)\s+(?:own\s+)?business\b/,
  /\bget\s+a\s+(?:real\s+)?job\b/,
  /\bget\s+a\s+life\b/,
  /\bridiculous\s+questions?\b/,
  /\byour\s+time\s+is\s+up\b/,
  /\bdestroy(?:ing)?\s+(?:the\s+)?housing\s+market\b/,
  /\bdo\s+something\s+worthwhile\b/,
  /\b(?:your|yo|ur)\s+(?:mama|momma|mamma|moma)\b/,
  /\b(?:scammers?|scam\s*artists?|vultures?|bottom\s*feeders?|lowballers?|leeches|parasites?|idiots?|morons?|clowns?|losers?|jackass|dumbass|dumb\s*ass)\b/,
  /\bfool[\s.!]*$/,
  /\bgo\s+to\s+hell\b/,
  /\bscrew\s+(?:you|u|off)\b/,
  /\bpiss\s+off\b/,
  /\bkiss\s+my\b/,
  // Spanish
  /\b(?:que|q)\s+te\s+importa\b/,
  /\bno\s+es\s+(?:de\s+)?(?:tu|su)\s+(?:incumbencia|asunto|problema)\b/,
  /\bno\s+es\s+asunto\s+tuyo\b/,
  /\bmetete\s+en\s+tus\s+(?:asuntos|cosas)\b/,
  /\b(?:pendej[oa]s?|estupid[oa]s?|imbeciles?|rateros?|estafador(?:es|as?)?|buitres?)\b/,
  /\bvete\s+al\s+diablo\b/,
  // Portuguese
  /\bnao\s+e\s+da\s+(?:sua|tua)\s+conta\b/,
  /\bcuid[ae]\s+da\s+(?:sua|tua)\s+vida\b/,
  /\b(?:otario|golpista|vigarista)s?\b/,
  // Vietnamese
  /\bkhong\s+phai\s+viec\s+cua\s+(?:ban|may)\b/,
  /\b(?:do|thang)\s+(?:ngu|dien)\b/,
  /\blua\s+dao\b/,
];

// "Do your homework" is dismissive, not an insult, when it rides on a denied
// premise ("Estás mal informado. Você deve fazer o seu trabalho de casa" =
// "you're misinformed, do your research"): then it is part of the denial.
const HOMEWORK_PATTERNS = [
  /\bdo\s+your\s+(?:own\s+)?homework\b/,
  /\bhaz\s+tu\s+tarea\b/,
  /\btrabalho\s+de\s+casa\b/,
  /\blicao\s+de\s+casa\b/,
];

export function detectHostileWithoutOptOut(message, { premise_denied = false } = {}) {
  const folded = foldReplyText(message);
  if (!folded) return { matched: false };
  const hit = anyMatch(folded, HOSTILE_INSULT_PATTERNS) || (!premise_denied && anyMatch(folded, HOMEWORK_PATTERNS));
  return hit ? { matched: true, rule_id: "hostile_insult_no_opt_out" } : { matched: false };
}

// ─── Competitor / fellow investor ────────────────────────────────────────────

const COMPETITOR_PATTERNS = [
  /\b(?:i'?m|i am|im|we'?re|we are)\s+(?:also\s+)?(?:an?\s+)?(?:investor|wholesaler|flipper|real\s+estate\s+investor|cash\s+buyer)\s+(?:too|as\s+well|also|myself)\b/,
  /\b(?:i|we)\s+also\s+(?:buy|flip|wholesale)\s+(?:houses|homes|properties|real\s+estate)\b/,
  /\b(?:i|we)\s+(?:buy|flip|wholesale)\s+(?:houses|homes|properties|real\s+estate)\s+(?:too|as\s+well|also|myself)\b/,
  /\b(?:i'?m|i am|im|we'?re|we are)\s+looking\s+for\s+(?:another|one|more|some)\b[^.!?]{0,30}\b(?:as\s+well|too|also)\b/,
  /\b(?:in\s+the\s+)?same\s+(?:business|line\s+of\s+(?:work|business))\b/,
  /\bmismo\s+negocio\b/,
  /\btambien\s+(?:compro|compramos)\s+(?:casas|propiedades)\b/,
  /\b(?:yo\s+)?tambien\s+soy\s+inversionista\b/,
  /\btambem\s+compro\s+(?:casas|imoveis)\b/,
  /\bmesmo\s+ramo\b/,
];

export function detectCompetitorInvestor(message) {
  const folded = foldReplyText(message);
  if (!folded) return false;
  return Boolean(anyMatch(folded, COMPETITOR_PATTERNS));
}

// ─── Language preference ─────────────────────────────────────────────────────

const LANGUAGE_NAMES = {
  english: "English",
  ingles: "English",
  spanish: "Spanish",
  aspanish: "Spanish",
  espanish: "Spanish",
  spanich: "Spanish",
  spanis: "Spanish",
  espanol: "Spanish",
  portuguese: "Portuguese",
  portugues: "Portuguese",
  vietnamese: "Vietnamese",
  arabic: "Arabic",
  french: "French",
};

// round 9 (2026-10-07: "no speako aspanish" to a Spanish text sat as unclear):
// the subject is optional after a bare "no", and the misspellings sellers type
// ("speako", "aspanish", "espanish", "spanich") name the same refusal.
const CANNOT_READ_RE =
  /(?:\b(?:i|we)\s+(?:do\s*n'?t|dont|do not|can'?t|cant|cannot|can not|no)|^no)\s+(?:speak|speako|speeko|spik|read|reed|understand|talk|speek|habla|hablo)\s+(spanish|aspanish|espanish|spanich|spanis|espanol|portuguese|portugues|vietnamese|arabic|french|that language|this language)\b/;
const ENGLISH_PLEASE_PATTERNS = [
  /^(?:in\s+)?english(?:\s+(?:please|pls|plz|only))?[\s.!?]*$/,
  /\b(?:speak|text|write|send(?:\s+it)?|talk|reply|respond)\s+(?:to\s+me\s+|me\s+)?in\s+english\b/,
  /\benglish\s+(?:please|pls|plz|only)\b/,
  /\bno\s+(?:spanish|espanol)\b/,
  /\b(?:en\s+)?ingles\s+por\s+favor\b/,
];
const DONT_UNDERSTAND_RE =
  /\b(?:i\s+)?(?:do\s*n'?t|dont|do not|can'?t|cant)\s+understand\b|^no\s+entiendo\b|\bnao\s+entendo\b|\bkhong\s+hieu\b/;

/**
 * Coarse language of a message we SENT (or a reply): enough to tell that a
 * seller who answered "I don't understand" was written to in another language.
 * Deliberately conservative -- returns null when it cannot tell.
 */
export function detectMessageLanguage(message) {
  const folded = foldReplyText(message);
  if (!folded) return null;
  // Native scripts first (kana / Hangul before Han: Japanese uses kanji).
  const raw = String(message ?? "");
  if (/[\u3040-\u30FF]/u.test(raw)) return "Japanese";
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/u.test(raw)) return "Korean";
  if (/[\u3400-\u9FFF\uF900-\uFAFF]/u.test(raw)) return "Mandarin";
  if (/[\u0590-\u05FF]/u.test(raw)) return "Hebrew";
  if (/[\u0600-\u06FF]/u.test(raw)) return "Arabic";
  if (/[\u0900-\u097F]/u.test(raw)) return "Hindi";
  if (/[\u0370-\u03FF\u1F00-\u1FFF]/u.test(raw)) return "Greek";
  if (/[\u0400-\u04FF]/u.test(raw)) return "Russian";
  // Our own romanised templates (2026-10-06 audit of sms_templates): the
  // multilingual reply layer only trusts romanised answers ("hai", "da",
  // "haan") when OUR last outbound was in that language, so it must be known.
  if (/\b(?:ni hao|zai zheli|xie xie|wo shi|nin hai|nin dui|ruguo heshi)\b/.test(folded)) return "Mandarin";
  if (/\b(?:konnichiwa|desu|arigatou|gozaimasu|watashi wa)\b/.test(folded)) return "Japanese";
  if (/\b(?:annyeong|yeoyo|gamsadeurimnida|gamsahamnida|hago gyeseyo|isseoyo)\b/.test(folded)) return "Korean";
  if (/\b(?:privet|spasibo|ponial|vy vse eshche|ya ischu)\b/.test(folded)) return "Russian";
  if (/\b(?:shalom|hevanti|ani mekhapes|ata adayin)\b/.test(folded)) return "Hebrew";
  if (/\b(?:namaste|yahan|dhanyavaad|dhanyavad|kya aap|karne ke liye)\b/.test(folded)) return "Hindi";
  if (/\b(?:yia sou|geia sou|efharisto|eimai topikos|to katalava)\b/.test(folded)) return "Greek";
  if (/\b(?:czesc|dziekuje|doceniam|szukam|czy nadal)\b/.test(folded)) return "Polish";
  if (/\b(?:ciao|grazie|investo a|possiedi|domanda veloce)\b/.test(folded)) return "Italian";
  if (/\b(?:hallo|ich bin|danke|verstanden|immobilieninvestor)\b/.test(folded)) return "German";
  if (/\b(?:xin chao|toi la|cua ban|co phai|khong|nha dau tu)\b/.test(folded)) return "Vietnamese";
  if (/\b(?:marhaba|huna|astathmir|ahlan|hal\s+\S+\s+lak)\b/.test(folded)) return "Arabic";
  if (/\b(?:bonjour|aviez|avez|vous|prix demande|propriete)\b/.test(folded)) return "French";
  if (/\b(?:ola|voce|proprietario|imovel|sou\s+\w+|e sua propriedade|ainda e)\b/.test(folded)) return "Portuguese";
  // round 10 (owner 2026-10-08): plain Portuguese seller phrases ("Não estou
  // vendendo a casa") are read before the Spanish words they share ("casa").
  if (/\b(?:nao\s+(?:estou|estamos|quero|tenho|vendo|sou)|estou\s+vendendo|vendendo|obrigad[oa]|minha\s+casa|tenho\s+interesse)\b/.test(folded)) return "Portuguese";
  if (/\b(?:hola|soy|eres|dueno|duena|propiedad|todavia|sigues|estaria|estas|usted|venta|vender|aqui|gracias)\b/.test(folded) || /[¿¡]/.test(message)) return "Spanish";
  // round 10 (owner 2026-10-08): "No estoy vendiendo la casa" came back unknown
  // and the nurture rendered in English. Common Spanish seller words.
  if (/\b(?:estoy|estamos|vendiendo|vendo|vendemos|vende|vendi|vendimos|vendida|vendido|casa|casas|interesa|interesad[oa]s?|quiero|queremos|tengo|tenemos|nunca|ahorita|ahora\s+no|todavia\s+no|numero\s+equivocado|equivocado|numero|lista|escrib\w+|borr(?:a|e|en|ar)|quit(?:a|e|en|ar)|mensajes?|molest\w+|llam(?:e|en|ar|ame|enme)|senor|senora|pero|tambien|porque|ninguna?|esta\s+(?:rentada|ocupada|vendida))\b/.test(folded)) return "Spanish";
  if (/\b(?:the|this|is|are|you|your|i|do|own|still|hello|hi|hey|yours|understand|speak|english)\b/.test(folded)) return "English";
  return null;
}

/**
 * Language preference -- three things tracked separately (7.2):
 *   detected_language       the language THIS message is written in
 *   preferred_language      the language the seller asked us to use (or null)
 *   avoid_language          a language the seller told us to stop using
 *   preference_confidence   high | medium | low
 *
 * "I don't speak Spanish" means STOP SPANISH. It does not, by itself, mean
 * English: preferred_language stays null and the language they wrote in is
 * only a low-confidence candidate. "English" / "in English please" is an
 * explicit request (high). One non-English phrase is never a preference.
 */
export function detectLanguagePreference(message, { last_outbound_language = null } = {}) {
  const folded = foldReplyText(message);
  if (!folded) return { matched: false };
  const detected_language = detectMessageLanguage(message);

  const cannot = CANNOT_READ_RE.exec(folded);
  if (cannot) {
    const refused = LANGUAGE_NAMES[cannot[1]] || (last_outbound_language || null);
    return {
      matched: true,
      rule_id: "language_preference_cannot_read",
      detected_language,
      avoid_language: refused,
      preferred_language: null,
      candidate_language: detected_language && detected_language !== refused ? detected_language : null,
      preference_confidence: "low",
    };
  }
  if (anyMatch(folded, ENGLISH_PLEASE_PATTERNS)) {
    return {
      matched: true,
      rule_id: "language_preference_english_requested",
      detected_language,
      avoid_language: null,
      preferred_language: "English",
      candidate_language: "English",
      preference_confidence: "high",
    };
  }
  if (DONT_UNDERSTAND_RE.test(folded) && last_outbound_language) {
    if (detected_language && detected_language !== last_outbound_language) {
      return {
        matched: true,
        rule_id: "language_preference_did_not_understand",
        detected_language,
        avoid_language: last_outbound_language,
        preferred_language: null,
        candidate_language: detected_language,
        preference_confidence: "low",
      };
    }
  }
  return { matched: false, detected_language };
}

// ─── Call request (explicit time captured, never invented) ───────────────────

const CALL_TIME_RE =
  /\b((?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)?\s*(?:at|after|before|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?(?:\s+(?:today|tonight|tomorrow))?|(?:today|tonight|tomorrow)\s+(?:morning|afternoon|evening|night)?|(?:this|tomorrow)\s+(?:morning|afternoon|evening))\b/;

/**
 * A call request, with the time the seller named (verbatim) when there is one.
 * No timestamp is computed: an operator schedules it. Unscheduled is the
 * honest state ("call requested · unscheduled").
 */
export function detectCallRequest(message) {
  const folded = foldReplyText(message);
  if (!folded) return { matched: false };
  const refinements = anyMatch(folded, CALLBACK_PATTERNS);
  const generic = /\b(?:call|ring|phone)\s+me\b|\b(?:give|gimme)\s+me\s+a\s+(?:call|ring)\b|\bcan\s+(?:you|u)\s+call\b|\b(?:llamame|llameme|me\s+puede\s+llamar|me\s+llamas|ligue\s+para\s+mim|me\s+liga|goi\s+cho\s+toi)\b/.test(folded);
  if (!refinements && !generic) return { matched: false };
  if (/\b(?:don'?t|do not|never|stop)\s+(?:call|calling)\b/.test(folded)) return { matched: false };
  const time = CALL_TIME_RE.exec(folded);
  return {
    matched: true,
    rule_id: refinements ? "call_request_availability" : "call_request_generic",
    requested_time_text: time ? time[1].trim() : null,
    scheduled_at: null,
    state: time ? "call_requested_time_named" : "call_requested_unscheduled",
  };
}

// ─── Engagement refinements (still engagement) ───────────────────────────────

const ASKS_OFFER_PATTERNS = [
  /\bwhat'?s?\s+(?:is\s+)?(?:a\s+)?fair\s+(?:price|offer|number)\b/,
  /^what\s+numbers\s*\??$/,
  /\bcuanto\s+(?:estas?|estan|esta\s+usted)\s+dispuest[oa]s?\s+a\s+(?:pagar|dar|entregar|ofrecer)\b/,
  /\bcuanto\s+(?:me\s+)?(?:ofreces|ofrece|ofrecen|darias|pagarias)\b/,
  // "Cuánto es tu oferta" / "cuál es su oferta" / "qual é a sua oferta"
  /\b(?:cuanto|cual|qual)\s+(?:es|e|seria)\s+(?:tu|su|la\s+sua|a\s+sua|sua)\s+(?:oferta|propuesta|proposta)\b/,
];
const CALLBACK_PATTERNS = [
  /^(?:(?:hi|hello|hey)[\s,.!]*)?(?:are|r)\s+(?:you|u)\s+available\s+(?:for|to)\s+(?:a\s+)?(?:quick\s+|short\s+|brief\s+)?(?:call|chat|talk|phone\s+call)\b/,
  /^call\s+(?:me\s+)?(?:and|&)\s+(?:we|i)(?:'ll|\s+will|\s+can)\s+(?:discuss|talk|chat)\b/,
];
const FOR_SALE_NOW_RE = /^(?:yes[,.!\s]+)?(?:it'?s|it\s+is)\s+for\s+sale(?:\s+(?:right\s+)?now)?[\s.!]*$/;
const IDENTITY_QUESTION_PATTERNS = [
  /^[a-z]{2,15}\s+who\s*\?*[\s.]*$/,
  /^who\s*\?+$/,
  /^which\s+[a-z]{2,15}\s*\?*[\s.]*$/,
  /^cual\s+[a-z]{2,15}\s*\?*[\s.]*$/,
  /\b(?:q|que|cual)\s+[a-z]{2,15}\s+eres\b/,
  /\bquien\s+quiere\s+saber\b/,
  /^(?:que|q)\s+(?:es\s+lo\s+que\s+)?(?:buscas|busca|buscan|quieres|necesitas|necesita)\b/,
  /\bque\s+se\s+(?:le|les|te)\s+ofre[cs]e\b/,
  /\bpor\s*que\s+la\s+pregunta\b/,
  /\bcomo\s+(?:encontraste|obtuviste|conseguiste|consiguio|obtuvo)\s+(?:mi|mis)\s+(?:informacion|numero|datos)\b/,
  /^\?*\s*what\s*\?+[\s?]*$/,
  /^\?+\s*what[\s?]*$/,
  /\b(?:you\s+need\s+to\s+)?tell\s+me\s+more\b/,
  /^(?:is\s+this|are\s+you)\s+[a-z]{2,15}\s+(?:with|from)\b/,
  // Purpose questions: what is this about / what do you want / how can I help.
  // "¿En qué te puedo ayudar?" is a polite "what do you want?", not a call
  // request (it sat in Priority as callback_requested).
  /^(?:hola[\s,.!]+|si[\s,.!]+)?(?:en\s+)?que\s+(?:te|le|les)\s+(?:puedo|podemos)\s+(?:ayudar|servir)\b/,
  /^(?:hola[\s,.!]+)?como\s+(?:te|le|les)\s+(?:puedo|podemos)\s+ayudar\b/,
  /^(?:ola[\s,.!]+|oi[\s,.!]+)?(?:em\s+que|como)\s+(?:posso|podemos)\s+(?:te\s+|lhe\s+)?ajudar\b/,
  // "¿A qué viene esto?" (typed "Aque biene pesto?")
  /^a\s?que\s+[bv]iene\b/,
  /^(?:de\s+que\s+se\s+trata|para\s+que\s+es\s+esto|que\s+es\s+esto)\b/,
  /^what(?:'?s|s|\s+is)?\s+(?:up\s+)?with\s+(?:this|that|the|my)\s+(?:address|property|house|place)\b/,
  // "And what do you mean by is that address mine?"
  /\bwhat\b.{0,24}\bmean\b.{0,24}\b(?:address|house|property)\b.{0,12}\bmine\b/,
];

// "Who is Chris?" asks who OUR sender is (an identity question) only when
// Chris is the name we signed with. "Who is Derik?" about the person we
// greeted is the opposite: a wrong-person signal. Without context it is
// neither, and stays out of both.
const WHO_IS_NAME_RE = /^wh[oiy]\s+is\s+([a-z]{2,15})\s*\?*[\s.]*$/;

/**
 * Our signed name echoed back as a question: "Chris?", "Jake, my co worker?",
 * "Whi is chris?". Short lines only, and only the name we signed with.
 */
function echoesAgentNameAsQuestion(line, agent) {
  if (!agent || !line.endsWith("?") || wordCount(line) > 6) return false;
  return new RegExp(`(?:^|[^a-z])${escapeRegExp(agent)}(?![a-z])`).test(line);
}

export function detectEngagementRefinements(message, { agent_name = null } = {}) {
  const folded = foldReplyText(message);
  if (!folded) return { asks_offer: false, callback_requested: false, seller_interested: false, identity_question: false };
  const agent = cleanName(agent_name);
  // A merged burst is read whole AND line by line: the anchored patterns
  // ("Which Helen?", "Qué es lo que buscas") describe one message each.
  const lines = foldReplyLines(message);
  const candidates = lines.length > 1 ? [folded, ...lines] : [folded];
  const identity_question = candidates.some((text) => {
    if (anyMatch(text, IDENTITY_QUESTION_PATTERNS)) return true;
    const whoIs = WHO_IS_NAME_RE.exec(text);
    if (whoIs && agent && whoIs[1] === agent) return true;
    return echoesAgentNameAsQuestion(text, agent);
  });
  return {
    asks_offer: Boolean(anyMatch(folded, ASKS_OFFER_PATTERNS)),
    callback_requested: Boolean(anyMatch(folded, CALLBACK_PATTERNS)),
    seller_interested: FOR_SALE_NOW_RE.test(folded),
    identity_question,
  };
}

// ─── Another property offered ────────────────────────────────────────────────

// "Tengo otra propiedad de venta" -- the seller is selling a DIFFERENT
// property. A lead for a person, never a template reply about this one.
const OTHER_PROPERTY_PATTERNS = [
  /\b(?:i|we)\s+(?:have|got|own)\s+(?:another|other|a\s+different|a\s+second)\s+(?:property|properties|house|houses|home|homes|place|building|lot)\s+(?:for\s+sale|to\s+sell|(?:i|we)(?:'m|'re|\s+am|\s+are)\s+selling|on\s+the\s+market)\b/,
  /\b(?:i|we)\s+(?:have|got)\s+(?:another|other)\s+(?:one|ones)\s+(?:for\s+sale|to\s+sell)\b/,
  /\btengo\s+otr[ao]s?\s+(?:propiedad(?:es)?|casas?|terrenos?|edificios?|lotes?)\s+(?:de|en|a\s+la|para\s+la|para)\s+venta\b/,
  /\btengo\s+otr[ao]s?\s+(?:propiedad(?:es)?|casas?)\s+que\s+(?:vendo|quiero\s+vender|estoy\s+vendiendo)\b/,
  /\btenho\s+outr[ao]s?\s+(?:propriedades?|casas?|imove(?:l|is))\s+(?:a|para|de)\s+venda\b/,
  // "Not for sale. I have a property at 6650 S Seeley Ave that I'll be putting
  // on the market" -- a different property about to be sold.
  // "Not selling 9411, but I am selling two parcels as a package ... Asking
  // price for both ... is $275k" (2026-10-05): the price is for OTHER land.
  /\bnot\s+selling\b.{0,60}?\bbut\s+(?:i|we)(?:'m|'re|\s+am|\s+are)\s+selling\b/,
  /\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+selling\s+(?:two|2|three|3|four|4|some|other|another|a\s+few|several|the\s+other)\s+(?:parcels?|lots?|propert(?:y|ies)|houses?|homes?|units?|acres?)\b/,
  /\b(?:i|we)\s+(?:have|got|own)\s+(?:a|another|one\s+more)\s+(?:property|house|home|building|duplex|lot)\b.{0,80}?\b(?:(?:i'?ll|i\s+will|i'?m|we'?ll|we\s+will|we'?re)\s+(?:be\s+)?(?:putting|put|selling|sell|listing|list)|for\s+sale|to\s+sell)\b/,
];

export function detectOtherPropertyOffered(message) {
  const folded = foldReplyText(message);
  if (!folded) return { matched: false };
  return anyMatch(folded, OTHER_PROPERTY_PATTERNS)
    ? { matched: true, rule_id: "other_property_for_sale" }
    : { matched: false };
}

// ─── Context helpers (built from the outbound WE sent) ───────────────────────

const GREETING_NAME_RE =
  /^(?:hey|hi|hello|hola|ola|ol[aá]|oi|xin\s+ch[aà]o|marhaba|bonjour|ciao|good\s+(?:morning|afternoon|evening))[\s,]+([A-Z][A-Za-z'-]{1,20})\b/;
const NAME_THIS_IS_RE = /^([A-Z][A-Za-z'-]{1,20}),\s+(?:this\s+is|it'?s|soy|este\s+es|aqui\s+es|sou|toi\s+la)\b/;
const NOT_A_GREETED_NAME = new Set(["there", "again", "neighbor", "friend", "sir", "madam", "maam", "team", "folks", "all"]);

const AGENT_NAME_RES = [
  /\bthis\s+is\s+([A-Z][A-Za-z'-]{1,20})\b/,
  /\bmy\s+name\s+is\s+([A-Z][A-Za-z'-]{1,20})\b/,
  /\b([A-Z][A-Za-z'-]{1,20})\s+(?:here|aqui|aquí|day|huna)\b/,
  /\b(?:soy|sou|t[oô]i\s+l[aà])\s+([A-Z][A-Za-z'-]{1,20})\b/,
];

/** The name OUR outbound signed with ("this is Alex", "Carlos aqui"). */
export function extractSenderName(outboundBody) {
  const raw = normalizeReplyText(outboundBody);
  for (const re of AGENT_NAME_RES) {
    const m = re.exec(raw);
    if (m && !NOT_A_GREETED_NAME.has(m[1].toLowerCase())) return m[1];
  }
  return null;
}

/** The first name OUR outbound greeted ("Hey James, this is Alex" -> "James"). */
export function extractAddresseeName(outboundBody) {
  const raw = normalizeReplyText(outboundBody);
  if (!raw) return null;
  const match = GREETING_NAME_RE.exec(raw) || NAME_THIS_IS_RE.exec(raw);
  if (!match) return null;
  const name = match[1];
  if (NOT_A_GREETED_NAME.has(name.toLowerCase())) return null;
  return name;
}

// ─── One call for classify.js ────────────────────────────────────────────────

/**
 * Every signal for one inbound, computed once. `context` is the VALIDATED
 * conversation context (or null); only its outbound-derived fields are read.
 */
export function detectReplyDispositionSignals(message, context = null) {
  const auto_reply = detectAutoReplyMessage(message);
  const noise = !auto_reply.matched && detectNoiseMessage(message);
  const non_engagement_rule = auto_reply.matched
    ? auto_reply.rule_id
    : noise
      ? "noise_single_character"
      : null;
  // The ownership question is read from OUR last outbound (context may be
  // stale: "Never have" two hours or two days later still answers it).
  const ownership_question = context?.ownership_question === true;
  const wrong_person = detectWrongPersonClaim(message, {
    addressee_name: context?.last_outbound_addressee || null,
    ownership_question,
  });
  return {
    non_engagement: Boolean(non_engagement_rule),
    non_engagement_rule,
    ownership_question,
    wrong_person,
    sold: detectSoldShort(message),
    not_for_sale: detectNotForSale(message),
    hostile: detectHostileWithoutOptOut(message, {
      premise_denied: wrong_person.matched === true && wrong_person.rule_id === "wrong_person_premise_denied",
    }),
    competitor: detectCompetitorInvestor(message),
    other_property: detectOtherPropertyOffered(message),
    language: detectLanguagePreference(message, { last_outbound_language: context?.last_outbound_language || null }),
    call_request: detectCallRequest(message),
    engagement: detectEngagementRefinements(message, { agent_name: context?.last_outbound_agent || null }),
  };
}

export default detectReplyDispositionSignals;
