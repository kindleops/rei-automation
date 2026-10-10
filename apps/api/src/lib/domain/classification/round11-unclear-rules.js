// ─── round11-unclear-rules.js ────────────────────────────────────────────────
// Round 11 classifier rules (owner P0 2026-10-09: "go through all these replies
// where it says unclear ... we can see what they're saying from the reply").
// Built from a hand-labelled audit of every prod inbound that was classified
// unclear / unknown / low-confidence (2026-04-23 .. 2026-10-09). Deterministic
// and rules-only: no model, no network, no I/O.
//
// Two entry points, both pure:
//
//  1. matchRound11OptOut(message) -- explicit contact revocations the phrase
//     lists missed ("YOU BETTER NOT CONTACT THIS NUMBER EVER AGAIN", "never
//     text me again", "I'm blocking you" / "Blocked 🚫", "you must want to get
//     sued ... if you ask the same question again"). classify.js ORs it into
//     the compliance chain next to round 10, so an opt-out still overrides
//     every ordinary intent and a legal threat still raises legal review.
//
//  2. applyRound11UnclearRules(intents, ctx) -- runs once after round 10 and
//     ONLY when the primary is still `unclear`. It reads the reply against
//     what WE asked last (ownership / interest / asking price / our offer /
//     condition / occupancy / rent / follow-up permission / email / contract)
//     plus phrase families that are unambiguous on their own (wrong person by
//     name, non-owner, plain declines in EN/ES, price counters, property
//     facts, sellers chasing us, identity questions, trolling, vendor pitches,
//     auto-responders).
//
// What it never does:
//  - It never touches a compliance verdict (opt-out / STOP) -- the compliance
//    chain ran first and returned before resolveIntents.
//  - It never overrides a deliberate POLICY HOLD that the classifier expresses
//    as primary `unclear` + a named rule (bare "No" to the ownership question,
//    "yes" to our price / condition question, a repeated no-contact demand, a
//    frustrated "did you read my text?", an emoji that earns one clarifier,
//    laughter). Those keep their routing; see POLICY_HOLD_RULE_IDS.
//  - Insults never suppress (hostile_or_troll is a quiet archive), and a
//    decline is not_interested (30-day nurture), never an opt-out.
//  - A positive / price reply bound only to a STALE question is capped below
//    the 0.82 autonomy gate, so a person answers it.

export const ROUND11_RULES_VERSION = "round11-2026-10-09";

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;

function normalize(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Accent-folded, lowercased, whitespace-collapsed. */
export function foldRound11(value) {
  return normalize(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const uniq = (list) => [...new Set((list || []).filter(Boolean))];

// ══════════════════════════════════════════════════════════════════════════
// 1. OPT-OUT ADDITIONS (compliance; read from the ORIGINAL words)
// ══════════════════════════════════════════════════════════════════════════

const LEGAL_WORD_RE = /\b(?:sue|sued|suing|lawsuit|law\s+suit|lawyer|attorney|legal\s+action|court|tcpa|fcc|abogad[oa]s?|demand\w*)\b/;

const OPT_OUT_PATTERNS = [
  // "YOU BETTER NOT CONTACT THIS NUMBER EVER AGAIN", "never text me again",
  // "don't you ever call this number again".
  {
    rule_id: "r11_never_contact_again",
    re: /\b(?:better\s+not|never|don'?t\s+(?:you\s+)?ever|dont\s+(?:you\s+)?ever|do\s+not\s+(?:you\s+)?ever)\s+(?:\w+\s+)?(?:contact|text|txt|call|message|msg|bother|reach\s+out\s+to)\s+(?:me|us|this\s+(?:number|phone|#|cell)|my\s+(?:number|phone|cell))\s*(?:ever\s+)?(?:again|anymore|any\s+more)\b/,
  },
  // A legal threat conditioned on asking / contacting again ("Michael you must
  // want to get sued!!! If you ask the same question again ...").
  {
    rule_id: "r11_legal_threat_if_asked_again",
    re: /\b(?:sue|sued|suing|lawsuit|lawyer|attorney|legal\s+action|court)\b[\s\S]{0,80}?\bif\s+(?:you|u|y'?all)\s+(?:ever\s+)?(?:ask|text|txt|call|contact|message|msg|bother)\b[^.!?\n]{0,40}\bagain\b/,
    legal: true,
  },
  {
    rule_id: "r11_legal_threat_if_asked_again",
    re: /\bif\s+(?:you|u|y'?all)\s+(?:ever\s+)?(?:ask|text|txt|call|contact|message|msg|bother)\b[^.!?\n]{0,40}\bagain\b[\s\S]{0,80}?\b(?:sue|sued|suing|lawsuit|lawyer|attorney|legal\s+action|court)\b/,
    legal: true,
  },
  // "Blocked 🚫", "I'm blocking you", "I'm block", "blocking this number"
  // -- the seller has cut the channel. Same verdict the classifier already
  // gives "Mejor te bloqueo" (opt_out). Whole-message or first-person only:
  // "the road is blocked" is not a revocation.
  {
    rule_id: "r11_seller_blocked_us",
    re: /^(?:ok(?:ay)?[\s,.!]+)?(?:(?:i'?m|im|i\s+am|i\s+will|i'?ll|i\s+have|i'?ve|ive|i)\s+)?(?:now\s+)?(?:block(?:ed|ing)?|bloqueado|bloqueando)(?:\s+(?:you|u|ya|this\s+(?:number|#|phone)|your\s+(?:number|#)|this|now))*[\s.!\u{1F6AB}⛔\u{1F645}]*$/u,
  },
  {
    rule_id: "r11_seller_blocked_us",
    re: /\b(?:i'?m|im|i\s+am|i\s+will|i'?ll|i\s+have|i'?ve|ive|gonna|going\s+to)\s+(?:now\s+)?block(?:ing|ed)?\s+(?:you|u|ya|this\s+(?:number|#|phone)|your\s+(?:number|#))\b/,
  },
  { rule_id: "r11_seller_blocked_us", re: /\b(?:te|lo|los|las)\s+(?:voy\s+a\s+)?bloque(?:o|ar|are|ando)\b|\bbloqueado\b/ },
];

/**
 * Round 11 explicit contact revocations. Returns { matched, rule_id, legal }.
 */
export function matchRound11OptOut(message = "") {
  const folded = foldRound11(message);
  if (!folded) return { matched: false };
  for (const pattern of OPT_OUT_PATTERNS) {
    if (!pattern.re.test(folded)) continue;
    return { matched: true, rule_id: pattern.rule_id, legal: Boolean(pattern.legal) || LEGAL_WORD_RE.test(folded) && /\b(?:sue|sued|suing|lawsuit|lawyer|attorney|court)\b/.test(folded) };
  }
  return { matched: false };
}

// ══════════════════════════════════════════════════════════════════════════
// 2. WHAT DID WE ASK LAST? (read from the body we actually sent)
// ══════════════════════════════════════════════════════════════════════════

export const OUTBOUND_QUESTION = Object.freeze({
  OWNERSHIP: "ownership",
  INTEREST: "interest",
  ASKING_PRICE: "asking_price",
  OFFER: "offer",
  CONDITION: "condition",
  OCCUPANCY: "occupancy",
  RENT: "rent",
  FOLLOWUP_PERMISSION: "followup_permission",
  EMAIL: "email",
  CONTRACT: "contract",
});

// Ordered most specific first. An offer outranks "ballpark" / "what price".
const OUTBOUND_QUESTION_PATTERNS = [
  [/\b(?:best|good)\s+email\b|\bemail\s+address\b|\bcorreo\s+electronico\b|\bsu\s+correo\b/, OUTBOUND_QUESTION.EMAIL],
  [/\b(?:purchase\s+agreement|listing\s+agreement|contract)\b[^.?!]{0,120}\b(?:terminated|released|cancel+ed|still\s+be\s+involved)\b/, OUTBOUND_QUESTION.CONTRACT],
  // Our number: "$55K", "I'd be at around $315K", "puedo ofrecer $55K",
  // "If that's in the ballpark, I can get you the agreement over".
  [/(?:\$\s?\d[\d,.]*\s*(?:k|mil)?\b[^?]{0,160}(?:works?\s+for\s+you|let\s+me\s+know|if\s+that'?s|close\s+in|closing\s+in|can\s+move|agreement|contrato|le\s+funciona|si\s+le\s+sirve)|\b(?:i'?d|i\s+would|i\s+could|we\s+could|we\s+can|i\s+can)\s+(?:likely\s+)?(?:be\s+(?:at|closer\s+to)|offer|do|pay)\s+(?:around\s+|about\s+)?\$|\bpuedo\s+ofrecer\b|\bin\s+the\s+ballpark\b[^?]{0,80}\bagreement\b|\bget\s+(?:you\s+)?the\s+(?:purchase\s+)?agreement\s+over\b)/, OUTBOUND_QUESTION.OFFER],
  [/\b(?:monthly\s+)?rents?\b[^.?!]{0,40}\?|what\s+(?:are|is)\s+the\s+(?:current\s+)?(?:monthly\s+)?rents?/, OUTBOUND_QUESTION.RENT],
  [/\b(?:vacant|occupied|tenanted|occupancy|rented\s+out|desocupad|ocupad)\w*\b/, OUTBOUND_QUESTION.OCCUPANCY],
  [/asking\s+price|price\s+in\s+mind|number\s+in\s+mind|what\s+price|which\s+price|best\s+price|lowest\s+(?:number|price)|what\s+(?:would|do)\s+you\s+want\s+for|how\s+much\s+(?:are\s+you\s+(?:asking|looking)|do\s+you\s+want)|precio\s+(?:de\s+venta|en\s+mente)|que\s+precio|mejor\s+precio|cuanto\s+(?:pide|quiere|debe)/, OUTBOUND_QUESTION.ASKING_PRICE],
  [/\b(?:condition|condiciones|condicion|repairs?|needs?\s+work|shape\s+is\s+it|roof|hvac|move-?in\s+ready|casa\s+ahi|solo\s+terreno)\b/, OUTBOUND_QUESTION.CONDITION],
  [/\bcheck\s+back\b|\breach\s+(?:back\s+)?out\s+(?:again\s+)?(?:down\s+the\s+road|later|in\s+a\s+few)|\bfollow\s+up\s+(?:down\s+the\s+road|later|in\s+a\s+few)/, OUTBOUND_QUESTION.FOLLOWUP_PERMISSION],
  [/\b(?:still\s+the\s+owner|are\s+you\s+the\s+owner|do\s+you\s+(?:still\s+)?own|is\s+.{0,60}\s+yours\b|(?:correct|right)\s+number\s+for\s+the\s+owner)|(?:eres|es\s+usted|sigues\s+siendo|todavia\s+eres|todavia\s+es)\s+(?:el\s+|la\s+)?duen[oa]|\bes\s+(?:tu|su)\s+propiedad/, OUTBOUND_QUESTION.OWNERSHIP],
  [/\bopen\s+to\s+(?:a\s+|an\s+|some\s+)?(?:as[-\s]is\s+|off[-\s]market\s+|cash\s+|quick\s+)?(?:proposal|offer|sale|selling|sell)\b|\bopen\s+to\s+(?:discussing|talking|hearing|getting|receiving|entertaining|reviewing)\s+(?:a\s+|an\s+|some\s+|the\s+)?(?:numbers?|proposal|offer|price)\b|\b(?:discussing|talking)\s+(?:a\s+|some\s+|the\s+)?numbers?\b|\bconsider\s+(?:a\s+|an\s+)?(?:as[-\s]is\s+|cash\s+)?(?:proposal|offer|sale|selling)\b|\bwould\s+you\s+(?:ever\s+)?(?:consider\s+|be\s+(?:willing|open)\s+to\s+|like\s+to\s+|want\s+to\s+)?sell(?:ing)?\b|\binterested\s+in\s+(?:selling|a\s+sale|an?\s+(?:offer|proposal))\b|abiert[oa]\s+(?:a\s+)?(?:una\s+)?(?:propuesta|oferta|venta|vender|discutir)|considerari?a\s+(?:una\s+)?(?:propuesta|oferta|venta|vender)|(?:le|te)\s+interesari?a\s+vender|dispuest[oa]\s+a\s+(?:discutir|vender|considerar)|discutir\s+(?:los\s+)?numeros/, OUTBOUND_QUESTION.INTEREST],
];

/** What OUR last outbound asked, from its body. null when it asked nothing we know. */
export function describeOutboundQuestion(body = "") {
  const folded = foldRound11(body);
  if (!folded) return null;
  for (const [re, kind] of OUTBOUND_QUESTION_PATTERNS) {
    if (re.test(folded)) return kind;
  }
  return null;
}

const USE_CASE_TO_QUESTION = {
  ownership_check: OUTBOUND_QUESTION.OWNERSHIP,
  proposal_interest: OUTBOUND_QUESTION.INTEREST,
  proposal_request: OUTBOUND_QUESTION.INTEREST,
  asking_price: OUTBOUND_QUESTION.ASKING_PRICE,
  condition_check: OUTBOUND_QUESTION.CONDITION,
  rent_check: OUTBOUND_QUESTION.RENT,
  occupancy_check: OUTBOUND_QUESTION.OCCUPANCY,
};

function resolveQuestion(ctx = {}) {
  // The body decides first (an operator's free-text offer is still an offer),
  // then the template use case.
  return describeOutboundQuestion(ctx.last_outbound_body) || USE_CASE_TO_QUESTION[String(ctx.last_outbound_use_case || "")] || (ctx.ownership_question === true ? OUTBOUND_QUESTION.OWNERSHIP : null);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. PHRASE FAMILIES
// ══════════════════════════════════════════════════════════════════════════

// Words that follow "not" / "no" and are NOT a person's name.
const NOT_A_NAME = new Set([
  "now", "yet", "today", "really", "sure", "me", "mine", "ours", "us", "you", "him", "her", "them", "it", "that", "this",
  "interested", "intrested", "interest", "selling", "for", "at", "the", "a", "an", "in", "on", "anymore", "any", "ever",
  "never", "here", "there", "so", "very", "too", "quite", "exactly", "necessarily", "likely", "much", "right", "really",
  "available", "true", "correct", "possible", "happening", "gonna", "going", "planning", "looking", "thinking", "home",
  "owner", "owned", "mine", "my", "our", "his", "hers", "theirs", "worth", "enough", "ready", "time", "thanks", "thank",
  "sold", "sell", "sale", "for", "currently", "anytime", "soon", "today", "tomorrow", "tonight", "again", "bad", "good",
  "gracias", "ahora", "todavia", "tengo", "esta", "es", "soy", "se", "vendo", "venta", "mas", "nada", "nunca", "aqui",
  "listed", "listing", "applicable", "familiar", "aware", "sure", "certain", "one", "two", "all", "everything", "nothing",
  "yours", "quite", "funny", "cool", "okay", "ok", "legit", "real", "fair", "legal", "spam", "happy", "cheap", "worried",
  "bothering", "buying", "renting", "moving", "working", "no", "yes", "sir", "maam", "please", "bueno", "what", "how",
]);

function looksLikeName(word = "") {
  const w = String(word || "").toLowerCase();
  return /^[a-z][a-z'-]{1,14}$/.test(w) && !NOT_A_NAME.has(w);
}

// R1 WRONG PERSON BY NAME -> wrong_number (about the phone; round 10 keeps
// a person mismatch phone-scoped).
function matchWrongPersonByName(folded, ctx) {
  const addressee = foldRound11(ctx.last_outbound_addressee || "").split(/\s+/)[0] || null;
  let m;
  // "Not jon" / "Sorry, not Catherine. Not a Ca resident"
  if ((m = /^(?:sorry[\s,.!]*|nope[\s,.!]*|no[\s,.!]+)?(?:this\s+is\s+)?not\s+([a-z][a-z'-]+)\b/.exec(folded)) && looksLikeName(m[1])) {
    // OUR message named this person, or the whole reply is just "Not <name>".
    // An apology + "not <name>" ("Sorry, not Catherine. Not a CA resident") is
    // the wrong-person form too.
    if ((addressee && addressee === m[1]) || /^(?:sorry[\s,.!]*|nope[\s,.!]*|no[\s,.!]+)?(?:this\s+is\s+)?not\s+[a-z][a-z'-]+[\s.!]*$/.test(folded) || /^sorry[\s,.!]*not\s+[a-z][a-z'-]+[\s.!]/.test(folded)) return "r11_wrong_person_not_name";
  }
  // "No Charles here"
  if ((m = /^(?:no|nobody|no\s+one)\s+(?:named\s+|by\s+the\s+name\s+(?:of\s+)?)?([a-z][a-z'-]+)\s+(?:here|at\s+this\s+(?:number|#))\b/.exec(folded)) && looksLikeName(m[1])) return "r11_wrong_person_no_name_here";
  // "this isn't charles" / "This isn't Shane's phone number"
  if ((m = /\bthis\s+(?:is\s*n'?t|isn'?t|isnt|is\s+not|aint|ain'?t)\s+([a-z][a-z-]+?)('s)?(?![a-z])(.{0,24})/.exec(folded)) && looksLikeName(m[1])) {
    // The name OUR message used, or "this isn't <name>'s (phone) number".
    if ((addressee && addressee === m[1]) || (m[2] && /^\s*(?:\w+\s+)?(?:number|phone|cell|#)\b/.test(m[3] || "")) || /^this\s+(?:is\s*n'?t|isn'?t|isnt|is\s+not)\s+[a-z][a-z-]+[\s.!]*$/.test(folded)) return "r11_wrong_person_this_isnt_name";
  }
  // "Melba is not at this number" / "It hasn't been Shane's number for 9 years"
  if (/\b[a-z]+\s+(?:is\s+not|isn'?t|isnt|is\s+no\s+longer|no\s+longer)\s+(?:at|on|with)\s+this\s+(?:number|phone|#)\b/.test(folded)) return "r11_wrong_person_not_at_number";
  if (/\b(?:hasn'?t|hasnt|has\s+not)\s+been\s+[a-z]+'?s\s+(?:number|phone|#|cell)\b/.test(folded)) return "r11_wrong_person_not_their_number";
  // Spanish: "Yo no soy Roberto tiene el numero mal" / "tiene el numero equivocado"
  if (/\b(?:yo\s+)?no\s+soy\s+(?:el\s+|la\s+)?[a-z]{2,}\b/.test(folded) && !/\bno\s+soy\s+(?:el|la)\s+(?:duen|propietari)/.test(folded) && /\b(?:numero\s+(?:mal|equivocado|incorrecto)|tiene\s+el\s+numero|tienen\s+el\s+numero|equivocad[oa])\b/.test(folded)) return "r11_wrong_person_es_no_soy";
  if (/\b(?:tiene|tienen|tienes)\s+(?:el\s+)?numero\s+(?:mal|equivocado|incorrecto)\b/.test(folded)) return "r11_wrong_person_es_numero_mal";
  // "Soy maria" when OUR message named someone else.
  if (addressee && (m = /^(?:no[\s,.!]+)?soy\s+([a-z]+)[\s.!]*$/.exec(folded)) && looksLikeName(m[1]) && m[1] !== addressee) return "r11_wrong_person_es_soy_other";
  return null;
}

// R2 NOT THE OWNER (property-scoped; the phone stays usable).
function matchNonOwner(folded, question) {
  const own_q = question === OUTBOUND_QUESTION.OWNERSHIP;
  // "the owner is chris cole"
  if (/^(?:no[\s,.!]+)?(?:the\s+)?(?:owner|homeowner|owners)\s+(?:is|are)\s+[a-z]/.test(folded) && !/\b(?:i|me|myself)\b/.test(folded.slice(0, 40))) return "r11_owner_is_someone_else";
  // "What are u talking bout I don't know u idk bout no 810 gay street"
  if (/\b(?:idk|i\s+don'?t\s+know|i\s+dont\s+know|i\s+do\s+not\s+know|no\s+idea)\s+(?:about|bout|abt|nothing\s+about|anything\s+about|of)\s+(?:no\s+|any\s+|that\s+|this\s+|the\s+)?(?:\d+\b|property|house|home|address|street|place)/.test(folded)) return "r11_dont_know_the_property";
  if (!own_q) return null;
  // "I am Not" / "I'm not" / "No, I don't" (stale context: the live chain's
  // ctx_denial rule only binds a VALID context).
  if (/^(?:no+[\s,.!]+)?(?:i\s*'?\s*m|i\s+am|im)\s+not[\s.!]*$/.test(folded)) return "r11_first_person_denial_ownership";
  if (/^no+[\s,.!]+(?:i|we)\s+(?:do\s*n'?t|do\s+not|dont)(?:\s+own\s+(?:it|that|this|one))?[\s.!]*(?:sorry|thanks|thank\s+you)?[\s.!]*$/.test(folded)) return "r11_first_person_denial_ownership";
  // "No. Havent lived there for 5 years"
  if (/^no+[\s,.!]+/.test(folded) && /\b(?:haven'?t|havent|have\s+not|don'?t|dont|do\s+not|no\s+longer|never)\s+(?:lived?|live|been)\s+(?:there|here|at)\b/.test(folded)) return "r11_no_longer_lives_there";
  // "I have no idea" / "No idea" / "I don't know" stay unclear: the reviewed
  // 2026-10-05 label (#022) holds them for a person.
  return null;
}

// R3 PLAIN DECLINE (not_interested -> 30-day nurture; never an opt-out).
const DECLINE_PATTERNS = [
  [/\bnothing\s+(?:to|for)\s+sel+(?:l|ling|s|es)?\b|\bnothing\s+for\s+sales?\b|^no+[\s,.!]+for\s+sale\b|\bno\s+for\s+sale\b/, "r11_nothing_for_sale"],
  [/\bgenerational\s+wealth\b|[,.]\s*so\s+no[.!]*$|\bkeeping\s+it\s+(?:in\s+the\s+family|for\s+(?:my|the)\s+(?:kids|grand\s*kids|family|children))\b/, "r11_keeping_it"],
  [/\b(?:will\s+not|won'?t|wont)\s+(?:be\s+)?work(?:ing)?\s+with\s+(?:you|u|y'?all|your\s+company)\b/, "r11_will_not_work_with_you"],
  [/\b(?:keep|save)\s+your\s+(?:money|offer|lowball)\b/, "r11_keep_your_money"],
  [/\bplay\s+with\s+(?:somebody|someone|some\s+one)\s+else\b|\bgo\s+(?:bother|play\s+with|text)\s+(?:somebody|someone)\s+else\b/, "r11_go_elsewhere"],
  [/\bno\s+quiero\s+nada\s+(?:contigo|con\s+usted|con\s+ustedes|con\s+uds)\b|\bolvidalo\b|\bno\s+me\s+interesa\b/, "r11_es_decline"],
  [/\b(?:chec?k?a?r?|ver|buscar?)\s+las\s+propiedades\s+que\s+estan\s+(?:de|en)\s+venta\b|\bcheck\s+(?:the\s+)?(?:mls|listings|zillow|redfin)\b/, "r11_go_look_at_listings"],
  [/^no+\s+(?:la|lo)\s+(?:vendo|vengo|bendo|vendere|voy\s+a\s+vender)\b/, "r11_es_not_selling_it"],
  [/\b(?:esta\s+)?publicad[ao]\s+en\s+el\s+mercado\b|^(?:on\s+(?:the\s+)?)?mls(?:\s+listing)?[\s.!]*$|\b(?:it'?s|its|it\s+is)\s+on\s+(?:the\s+)?mls\b/, "r11_listed_on_market"],
  [/\b(?:it'?s|its|it\s+is)\s+being\s+sold\b|\balready\s+(?:have|got)\s+(?:an?\s+)?(?:agent|realtor|buyer)\b/, "r11_already_being_sold"],
  // Third-person decline from a relative ("this is his son ... he doesn't have
  // any plans to sell"): the decline outranks who is declining.
  [/\b(?:he|she|they|my\s+(?:dad|father|mom|mother|parents?))\s+(?:doesn'?t|does\s+not|don'?t|do\s+not|has\s+no|have\s+no)\s+(?:have\s+)?(?:any\s+)?plans?\s+(?:to|of)\s+sell(?:ing)?\b|\bno\s+plans?\s+(?:to|of)\s+sell(?:ing)?\b/, "r11_no_plans_to_sell"],
];

// A flat rejection of OUR offer ("Of Course Not", "Claro q no").
const OFFER_REJECTION_RE = /^(?:of\s+course\s+not|claro\s+(?:que|q)\s+no|absolutely\s+not|hell\s+no|no\s+way|not\s+a\s+chance|no\s+thanks?|no\s+thank\s+you|pass)[\s.!]*$/;

// R4 PRICE / COUNTER (asking_price_provided; a person answers it).
function matchPriceStatement(folded) {
  if (/\b(?:\d{2,3}(?:[.,]\d+)?\s*k|\$\s?\d[\d,.]*)\b[^.!?]{0,40}\b(?:is\s+my\s+(?:bottom|floor|lowest|minimum|number|price)|bottom\s+line|firm|minimum|or\s+best|obo)\b/.test(folded)) return "r11_bottom_line_price";
  if (/\b(?:my\s+)?goal\s+is\s+\$?\s?\d{2,3}(?:[.,]\d+)?\s*k?\b|\b(?:i'?ve|i\s+have|ive)\s+been\s+offered\s+\$?\s?\d/.test(folded)) return "r11_offered_x_goal_y";
  if (/\b(?:quiero|pido|pidiendo|estoy\s+pidiendo|vale|precio\s+es)\s*[.:]?\s*\$?\s?\d{2,3}(?:[.,]\d+)?\s*(?:k|mil)?\b/.test(folded)) return "r11_es_asking_number";
  if (/\b(?:sales?|sale|selling|asking)\s+price\s*(?:is|:)?\s*\$?\s?\d{2,3}(?:[.,]\d{3})*\s*k?\b/.test(folded)) return "r11_sales_price_number";
  return null;
}

// R5 PROPERTY FACTS (condition_disclosed): beds/baths, units, repairs,
// layout, zoning, a rent figure, land only.
const FACT_PATTERNS = [
  /\b\d+\s*(?:bed(?:room)?s?|br|bd|bath(?:room)?s?|ba|units?|doors|plex)\b/,
  /\b(?:each\s+side|one\s+side|the\s+other\s+side)\s+has\b|\bbedrooms?\b[^.]{0,40}\bbath(?:room)?s?\b/,
  /^(?:need(?:s)?\s+(?:a\s+)?(?:little|some|lots?\s+of|a\s+lot\s+of)?\s*(?:upgrade|updating|work|repairs?|tlc|love|help\s+fixing|fixing)|in\s+repairs|needs?\s+help\s+fixing)\b/,
  /\b(?:it\s+needs|needs)\s+(?:some\s+)?(?:love|work|tlc|repairs?)\b/,
  /\bzon(?:e|ed|ing)\b[^.]{0,30}\b(?:business|commercial|residential|b-?\d|r-?\d|c-?\d)\b/,
  /\bper\s+month\b|\ba\s+month\b[^.]{0,20}\brent\b/,
  // A loan balance ("160 es el valance", "I owe about 90").
  // ("Owe 250" alone stays unclear: owe vs. price is exactly what it does not say.)
  /^\$?\s?\d[\d,.]*\s*(?:k|mil)?\s+es\s+(?:el|lo\s+que)\s+(?:balance|valance|balanse|debo)\b/,
  /\b(?:pre[\s-]?approved|approved)\s+plans\b/,
  /\b(?:tiene|es\s+(?:el\s+)?puro)\s+terreno\b|\bsolo\s+(?:el\s+)?terreno\b|\bjust\s+(?:the\s+)?land\b/,
  /^(?:muy\s+)?bien\s+por\s+la\s+gracia\s+de\s+dios\b|^(?:in\s+)?(?:great|good|excellent|perfect)\s+(?:shape|condition)\b/,
  /\bmov(?:e|ing)[\s-]?(?:in\s+)?ready\b|\bready\s+to\s+move\b/,
];

// R6 SELLER IS CHASING US / ENGAGED (a person replies now).
const CHASING_PATTERNS = [
  /^(?:dude|hey|hello|hi|yo)?[\s,.!]*(?:are\s+)?(?:you|u)\s+there\s*\??[\s.!?]*$/,
  /\b(?:you|u)\s+(?:didn'?t|did\s+not|never)\s+(?:respond|reply|answer|get\s+back)\b/,
  /\b(?:checking|following)\s+(?:in|up)\s+(?:on|about)\s+(?:the\s+)?(?:jv|contract|deal|offer|agreement|property|house)\b|^checking\s+in\b|\bi'?m\s+following\s+up\s+(?:about|on)\b/,
  /\bya\s+no\s+(?:contesto|contestaste|contestas|respondio|respondiste)\b|\bno\s+(?:me\s+)?(?:contesto|contestaste|has\s+contestado)\b/,
];

// R7 INVITES A VISIT / WANTS TO PROCEED (seller_interested / contract).
const INVITE_PATTERNS = [
  [/\b(?:want\s+to|wanna|like\s+to|care\s+to)\s+(?:tour|see|check\s+out|look\s+at|walk)\s+(?:the\s+)?(?:house|home|property|place|it)\b|\bdon'?t\s+want\s+to\s+(?:check\s+out|see|look\s+at)\s+the\s+(?:house|property)\b|\bwe\s+can\s+meet\s+(?:at|there)\b/, "seller_interested", "r11_invites_walkthrough"],
  [/\b(?:send\s+it\s+(?:on\s+)?over|send\s+(?:me\s+)?the\s+(?:contract|agreement|paperwork|papers)|we'?re\s+good\s+to\s+go|good\s+to\s+go)\b/, "contract_requested", "r11_send_it_over"],
  [/\b(?:i'?d|i\s+would|we'?d|we\s+would)\s+(?:be\s+)?(?:entertain|consider|happy\s+to\s+(?:talk|discuss|hear))\b|\bhappy\s+to\s+talk\b|\bconsider\s+an?\s+(?:offer|proposal)\b|\bentertain\s+an?\s+(?:good\s+|fair\s+)?offer\b/, "seller_interested", "r11_would_entertain_offer"],
  // "Pero no me vas a venir con una oferta ridícula ..." / "don't lowball me":
  // a conditional open door (a fair number gets a hearing).
  [/\bno\s+(?:me\s+|m\s+)?(?:vas|vayas|vengas)\s+(?:a\s+venir\s+)?con\s+una\s+oferta\s+ridicula\b|\b(?:don'?t|do\s+not|dont)\s+(?:lowball|low\s+ball)\s+me\b|\bno\s+lowball(?:ing|s)?\b/, "latent_interest", "r11_no_lowball_open_door"],
  [/\bmaybe\s+we\s+can\s+(?:come\s+to\s+an\s+agreement|work\s+something\s+out|make\s+a\s+deal)\b|\bmy\s+ear\s+is\s+open\b|\b(?:i'?m|im)\s+(?:all\s+)?ears\b/, "latent_interest", "r11_open_door"],
  [/\b(?:tired\s+of\s+(?:worrying|dealing|managing)|bout\s+to\s+turn\s+\d{2}|about\s+to\s+turn\s+\d{2}|ready\s+to\s+(?:let\s+it\s+go|be\s+done|move\s+on))\b/, "seller_interested", "r11_motivation_stated"],
  [/^(?:selling|vendo|i'?m\s+selling|we'?re\s+selling)\b[\s.!]*(?:\d|$)/, "seller_interested", "r11_selling_statement"],
  [/\b(?:tengo|tenemos)\s+(?:una|otra|otras|unas)\s+(?:propiedad\w*|casa\w*)?\s*(?:para|de|en)\s+vent?a\b|\b(?:tengo|tenemos)\s+una\s+(?:propiedad|casa)\s+que\s+(?:estoy|estamos)\s+vendiendo\b|\btengo\s+una\s+para\s+vender\b|^pero\s+esta\s+si\b/, "seller_interested", "r11_es_has_property_for_sale"],
  [/^(?:y|ya|yes+|yea+h?|yep|yup|si|sure|bet|shoot|go\s+ahead|shoot\s+me\s+(?:a|your)\s+(?:number|offer)|of\s+course|i\s+would|i\s+am|i\s+do|we\s+do|we\s+would|absolutely|definitely|certainly|for\s+sure|i\s+think\s+so|yes,?\s+it\s+is|yes,?\s+i\s+do|yes,?\s+i\s+am)[\s,.!\u{1F44D}\u{1F642}\u{1F60A}]*$/u, "__affirmative__", "r11_affirmative"],
];

// R8 IDENTITY / PURPOSE (who_is_this).
const IDENTITY_PATTERNS = [
  /^[a-z]{2,15}\s+who\s*[!?.]*$/,
  /^(?:what|wat|wut)\s+(?:are|r)\s+(?:you|u)\s+(?:talking|following\s+up)\s+(?:about|bout|on)\b/,
  /\bwhat'?s?\s*(?:up\s+)?(?:at|with|whit)\s+(?:this|that|the)\s+(?:a?d+re+s+|address|property|house)\b|\bwhatsat\s+whit\b/,
  /^(?:what\s+does\s+(?:the\s+)?deed\s+say|who'?s\s+in\s+this|who\s+(?:is|r|are)\s+(?:in|on)\s+this)\b/,
  /\bwho\b[^a-z]{0,6}\S{0,4}\s*the\s+is\b|^front\s+desk\b/,
  /^(?:en\s+que\s+(?:le\s+|te\s+)?(?:puedo\s+)?(?:servir|ayudar|debit|deb\w+)|servir|en\s+que\s+le\s+puedo\s+\w+)[\s?.!]*$/,
  /^(?:you\s+want\s+to\s+rent\s+or\s+buy|rent\s+or\s+buy|buy\s+or\s+rent)\b/,
  /^(?:came\s+across\s+it\s+where|where\s+did\s+you\s+(?:see|find|come\s+across)\s+(?:it|that|this))\b|\bdid\s+you\s+see\s+it\s+listed\b|\ble\s+miro\s+sign\b|\bvio\s+(?:un\s+)?(?:letrero|anuncio)\b/,
  /^(?:huh|what|que)\s*\?+\s*[\u{1F610}\u{1F611}\u{1F914}]?$/u,
  /^can'?t\s+talk\s+now\.?\s*what'?s\s+up\s*\?*$/,
  /^what\s+do\s+you\s+want[\s?.!,]*(?:leave\s+a\s+message)?[\s?.!]*$/,
  /^are\s+you\s+the\s+owner\s+of\s+your\s+house\b/,
];

// R9 TROLLING / MOCKERY / FLIRTING (hostile_or_troll -> quiet archive; never
// suppressed, never a review card).
const TROLL_PATTERNS = [
  /\bquero\s+chocha\b|\bhey\s+sexy\b|\byou\s+single\b|\bsend\s+(?:nudes|pics)\b/,
  /^lmt?fa+o*$|^lmfao+$|^gfy[\s.!]*$|^stfu[\s.!]*$/,
  /\bborder\s+hopper\b|\bme\s+no\s+speak\b|\bno\s+speako\b/,
  /\bhow'?s\s+that\s+rash\b|\bthe\s+cream\s+and\b|\bsymptoms\s+just\s+like\s+you\b/,
  /\bi\s+(?:vendo|sell)\s+(?:plantas|plants)\b|^yo\s+vendo\s+plantas\b/,
  /\bmove\s+in\s+with\s+you\b|\blive\s+with\s+you\b|\bmaid\s+service\b|\bfree\s+rent\b/,
  /^(?:que\s+bueno\s+)?felicidades+!*$/,
];

// R10 NOSY / HOMEWORK DEFLECTION (hostile_or_legal, quiet lane via the
// existing none-of-your-business handling -- never a suppression).
const DEFLECTION_PATTERNS = [
  /^(?:my\s+business|mind\s+(?:your\s+own|some\s+others?|ur\s+own)\s+business|why\s+do\s+you\s+care|what\s+is\s+that\s+to\s+you|what\s+does\s+it\s+matter\s+who\s+owns)\b/,
  /^(?:que\s+es\s+tu\s+problema|cual\s+es\s+tu\s+problema)\b/,
  /^(?:do\s+u\s+own\s+urs|do\s+you\s+own\s+yours)\b/,
  /\bpense\s+q(?:ue)?\s+si\s+estas\s+comprando\b|\btendrias\s+q(?:ue)?\s+saber\b/,
  /^sorry,?\s+i\s+don'?t\s+reveal\b|^i\s+don'?t\s+(?:give|share|reveal)\s+(?:out\s+)?(?:that|this)\s+(?:type\s+of\s+)?info/,
];

// R11 VENDOR / PEER PITCH (not a seller: not_interested, no nurture value).
const PITCH_PATTERNS = [
  /\b(?:necesitas|need)\s+(?:un\s+|a\s+)?(?:prestamista|lender)\b|\bprestamos\s+de\s+fha\b|\bfha\s+and\s+non-?qm\b/,
  /\bi\s+(?:am\s+)?buying\s+and\s+selling\s+(?:just\s+)?like\s+you\b|\bi'?m\s+(?:also\s+)?(?:an?\s+)?(?:investor|wholesaler)\s+too\b/,
  /^do\s+you\s+have\s+a\s+lender\s*\??$/,
];
// A buyer-side logistics question ("Cash or financed?") -> info_request.
const LOGISTICS_QUESTION_RE = /^(?:cash\s+or\s+(?:financed|finance|financing|loan)|is\s+it\s+(?:a\s+)?cash(?:\s+offer)?|are\s+you\s+paying\s+cash|will\s+it\s+be\s+cash)\s*\??$/;

// R12 AUTO-RESPONDERS (reaction_only: nothing said).
const AUTORESPONDER_RE = /\bsorry,?\s+we\s+missed\s+your\s+call\b|\bwe\s+are\s+currently\s+assisting\b|\bthis\s+is\s+an\s+automated\b|\bauto-?reply\b|\bout\s+of\s+(?:the\s+)?office\b/;

// R13 TIMING (need_time).
const NEED_TIME_PATTERNS = [
  /\blet\s+me\s+think\b|\bi'?m\s+at\s+work\b|\boff\s+(?:at\s+)?\d{1,2}\s*(?:p|pm|a|am)?\b/,
  /\bno\s+sale\s+(?:till|until|before)\b|\btill\s+jan\b|\bcap(?:ital)?\s+gains\b/,
];

// R14 SOLD / GONE (sold_property).
const SOLD_RE = /^(?:the\s+)?house\s+(?:is\s+)?gone[\s.!]*$|^(?:it'?s|its)\s+gone[\s.!]*$/;

// R15 IMPLAUSIBLE ASK in words ("for 10 millions").
const IMPLAUSIBLE_WORDS_RE = /\b(?:\d{2,}|ten|twenty|fifty|hundred)\s+millions?\b/;

// R16 REACTION ON OUR OWNERSHIP QUESTION (stale context): an affirmative
// tapback quoting our ownership question answers it; "Questioned/Dudó" on our
// question is the who-are-you question.
const QUOTED_OWNERSHIP_RE = /\b(?:still\s+the\s+owner|are\s+you\s+the\s+owner|do\s+you\s+(?:still\s+)?own|is\s+.{0,60}\s+yours)\b|sigues\s+siendo\s+el\s+duen/;
const QUESTIONED_RE = /^(?:questioned|cuestiono|dudo\s+sobre|dudo\s+de|questionou)\s+"/;

// Rule ids that carry a deliberate policy hold as primary `unclear`. Never
// rescued here: their routing IS the policy.
export const POLICY_HOLD_RULE_IDS = Object.freeze(new Set([
  "ctx_no_after_ownership_check",
  "ctx_yes_after_asking_price",
  "ctx_yes_after_condition",
  "ctx_no_after_condition",
  "ctx_no_after_rent",
  "ctx_no_value_after_rent",
  "ctx_no_value_generic",
  "ctx_no_after_fact_question",
  "repeat_no_contact_frustration",
  "seller_frustration_after_misread",
  "non_literal_laughter",
]));

// Confidence per rescued intent. Positive / price / interest replies sit
// BELOW the 0.82 autonomy gate: they are real leads and a person answers them
// (owner autonomy gates 2026-10-07). Dispositions that already route without
// a reply keep the confidence of the family they join.
const CONFIDENCE = {
  wrong_number: 0.9,
  property_specific_non_owner: 0.86,
  not_interested: 0.88,
  sold_property: 0.9,
  hostile_or_troll: 0.86,
  hostile_or_legal: 0.8,
  reaction_only: 0.8,
  who_is_this: 0.85,
  need_time: 0.8,
  condition_disclosed: 0.8,
  seller_interested: 0.8,
  latent_interest: 0.8,
  asks_offer: 0.8,
  contract_requested: 0.8,
  asking_price_provided: 0.8,
  asking_price_implausible: 0.85,
  info_request: 0.8,
  ownership_confirmed: 0.86,
  language_switch: 0.85,
  requests_email: 0.8,
};

function verdict(intent, rule_id, extra = {}) {
  return { intent, rule_id, confidence: CONFIDENCE[intent] ?? 0.8, ...extra };
}

/**
 * Pure. The round-11 verdict for a reply the earlier rules left unclear, or
 * null. ctx: { message, original_message, last_outbound_body,
 * last_outbound_use_case, last_outbound_addressee, ownership_question,
 * context_status, emoji_interpretation }.
 */
export function resolveRound11Verdict(ctx = {}) {
  const raw = normalize(ctx.original_message ?? ctx.message ?? "");
  const folded = foldRound11(ctx.message ?? raw);
  const folded_raw = foldRound11(raw);
  if (!folded && !folded_raw) return null;
  const question = resolveQuestion(ctx);
  const emoji = ctx.emoji_interpretation || null;

  // R16 tapbacks first (the text is OUR words).
  if (emoji?.reaction_type === "platform_reaction" || QUESTIONED_RE.test(folded_raw)) {
    const target = foldRound11(emoji?.reaction?.target_text || (/"([^"]+)"?\s*$/.exec(raw)?.[1] ?? ""));
    if (QUESTIONED_RE.test(folded_raw) || emoji?.family === "confusion") return verdict("who_is_this", "r11_questioned_our_message");
    if (emoji?.family === "affirmative" && QUOTED_OWNERSHIP_RE.test(target)) {
      return verdict("ownership_confirmed", "r11_affirmative_tapback_on_ownership_question", { confidence: 0.8 });
    }
    return null;
  }
  if (emoji?.emoji_only) return null;

  const text = folded_raw || folded;
  const both = (re) => re.test(text) || re.test(folded);

  let rule;
  if (AUTORESPONDER_RE.test(text)) return verdict("reaction_only", "r11_auto_responder");
  // "me speak English" / "English only" (a language statement, not trolling).
  if (/^(?:me|i)\s+(?:only\s+)?speak\s+english\b|^english\s+(?:only|please|pls)\b|^solo\s+ingles\b/.test(text)) return verdict("language_switch", "r11_language_statement");
  // A bare e-mail address: the seller is giving us where to send it.
  if (/^[\w.+-]+@[\w-]+\.[\w.]+[\s.!]*$/.test(text)) return verdict("requests_email", "r11_email_address_only");
  if ((rule = matchWrongPersonByName(text, ctx))) return verdict("wrong_number", rule);
  if ((rule = matchNonOwner(text, question))) {
    return verdict("property_specific_non_owner", rule, rule === "r11_owner_is_someone_else" ? { secondary: ["non_owner_referral"] } : {});
  }
  if (both(IMPLAUSIBLE_WORDS_RE)) return verdict("asking_price_implausible", "r11_implausible_ask_in_words");
  if ((rule = matchPriceStatement(text))) return verdict("asking_price_provided", rule);
  for (const re of TROLL_PATTERNS) if (re.test(text)) return verdict("hostile_or_troll", "r11_troll_or_mockery");
  for (const re of DEFLECTION_PATTERNS) if (re.test(text)) return verdict("hostile_or_legal", "r11_nosy_deflection");
  for (const re of PITCH_PATTERNS) if (re.test(text)) return verdict("not_interested", "r11_vendor_or_peer_pitch");
  if (LOGISTICS_QUESTION_RE.test(text)) return verdict("info_request", "r11_buyer_logistics_question");
  for (const [re, id] of DECLINE_PATTERNS) if (re.test(text)) return verdict("not_interested", id);
  if (question === OUTBOUND_QUESTION.OFFER && OFFER_REJECTION_RE.test(text)) return verdict("not_interested", "r11_rejects_our_offer");
  if (SOLD_RE.test(text)) return verdict("sold_property", "r11_house_gone");
  for (const re of NEED_TIME_PATTERNS) if (re.test(text)) return verdict("need_time", "r11_need_time");
  for (const re of CHASING_PATTERNS) if (re.test(text)) return verdict("seller_interested", "r11_seller_chasing_us", { secondary: ["seller_chasing_reply"] });
  if (question === OUTBOUND_QUESTION.EMAIL && /\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(text)) return verdict("contract_requested", "r11_email_for_agreement");
  for (const re of IDENTITY_PATTERNS) if (re.test(text)) return verdict("who_is_this", "r11_identity_or_purpose");
  if (/^what\s+kind\s+of\s+(?:price|offer|number)\b|^(?:what|how\s+much)\s+(?:are\s+you|r\s+u|would\s+you\s+be)\s+offering\b|^obo[\s.!]*$/.test(text)) return verdict("asks_offer", "r11_what_price_are_you_offering");
  for (const [re, intent, id] of INVITE_PATTERNS) {
    if (!re.test(text)) continue;
    if (intent !== "__affirmative__") return verdict(intent, id);
    // A bare affirmative means what OUR question asked.
    if (question === OUTBOUND_QUESTION.INTEREST || question === OUTBOUND_QUESTION.OFFER) return verdict("seller_interested", "r11_affirmative_to_interest_question");
    // "Shoot" / "Go ahead" invite OUR number; they answer nothing else.
    if (/^(?:shoot|go\s+ahead)\b/.test(text)) return null;
    if (question === OUTBOUND_QUESTION.FOLLOWUP_PERMISSION) return verdict("need_time", "r11_affirmative_to_followup_permission");
    if (question === OUTBOUND_QUESTION.OWNERSHIP) return verdict("ownership_confirmed", "r11_affirmative_to_ownership_question", ctx.context_status === "valid" ? {} : { confidence: 0.8 });
    return null;
  }
  // Affirmative + more ("Hi Nathan, yes I am.", "Hola Cris si 👍", "This is.
  // What can I do for you?", "100% mine. No lien.").
  if (/^(?:hi|hey|hello|hola)\b[^.!?]{0,20}?[\s,]+(?:yes|yeah|yep|si)(?:[\s,]+(?:i\s+am|i\s+do|it\s+is|we\s+do))?[\s.!\u{1F44D}]*$/u.test(text) || /^(?:100\s*%|definitely|yes)\s+(?:mine|ours)\b/.test(text) || /^this\s+is[.!]?\s+what\s+can\s+i\s+do\s+for\s+you\b/.test(text)) {
    if (question === OUTBOUND_QUESTION.INTEREST) return verdict("seller_interested", "r11_affirmative_to_interest_question");
    return verdict("ownership_confirmed", "r11_affirmative_with_greeting", ctx.context_status === "valid" ? {} : { confidence: 0.8 });
  }
  // Property facts last: a fact answers our condition / occupancy / rent
  // question, or volunteers a reason to talk.
  if (FACT_PATTERNS.some((re) => re.test(text))) return verdict("condition_disclosed", "r11_property_fact");
  // An address on its own, after we asked about interest / price: the seller
  // is naming the property they want to talk about.
  if ((question === OUTBOUND_QUESTION.INTEREST || question === OUTBOUND_QUESTION.ASKING_PRICE) && text.length <= 80 &&
      /^(?:\d{2,6}\s+[a-z0-9.' -]{2,40}|[a-z .]+,?\s+(?:tx|ri|ca|fl|ga|mn|ny|nc|az|oh|il|tn|co|wa|nj)\s+\d{5})(?:[\s,]+[a-z .]+)*(?:\s+\d{5})?(?:\s+esa\s+es\s+la\s+direc+ion)?[\s.!]*$/.test(text)) {
    return verdict("seller_interested", "r11_address_for_sale_conversation");
  }
  return null;
}

/**
 * Pure. intents = the post-round-10 intents. Returns { intents, facts }.
 * Acts only on a primary `unclear` that is not a compliance verdict and not a
 * deliberate policy hold.
 */
export function applyRound11UnclearRules(intents = {}, ctx = {}) {
  const facts = { version: ROUND11_RULES_VERSION, rule_ids: [], question: null };
  const primary = String(intents.primary_intent || "unclear");
  if (primary !== "unclear") return { intents, facts };
  if (ctx.compliance_flag) return { intents, facts };
  const ids = intents.matched_rule_ids || [];
  if (ids.some((id) => POLICY_HOLD_RULE_IDS.has(id))) return { intents, facts };
  // The emoji layer's own clarifier (a likely yes/no emoji to a live question)
  // is a policy: one confirmation question, never a fact.
  if (ctx.emoji_interpretation?.requires_clarification === true && ctx.emoji_interpretation?.reaction_type !== "platform_reaction") {
    return { intents, facts };
  }
  const v = resolveRound11Verdict(ctx);
  facts.question = resolveQuestion(ctx);
  if (!v) return { intents, facts };
  facts.rule_ids.push(v.rule_id);
  return {
    facts,
    intents: {
      ...intents,
      primary_intent: v.intent,
      secondary_intent: (v.secondary || [])[0] || null,
      secondary_intents: uniq([...(v.secondary || []), ...(intents.secondary_intents || []).filter((i) => i !== "unclear")]),
      matched_intents: uniq([v.intent, ...(intents.matched_intents || []).filter((i) => i !== "unclear")]),
      matched_rule_ids: uniq([...ids, v.rule_id]),
      ambiguity_flags: [],
      precedence_result: "round11_unclear_rescue",
      calibrated_rule_family_id: v.rule_id,
      confidence_rationale: v.rule_id,
      contextual_confidence: v.confidence,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 4. COUNTERPARTY IS AN INVESTOR / WHOLESALER (owner P0 2026-10-09)
// ══════════════════════════════════════════════════════════════════════════
// "Yes, message me if you are interested in rentals - I have off market units
// cash flowing and selling at market rates" answered our S1 ownership question.
// It was read as callback_requested ("message me") and autopilot sent "Sorry I
// missed you, texting is the fastest way to reach me ...". The person confirmed
// ownership and pitched THEIR inventory: a counterparty, not a seller lead and
// not a call request. Ownership is kept as the fact it is; the turn goes to a
// person (Needs Review) with no auto-reply. Compliance, wrong number and
// hostility keep their own verdicts.

const COUNTERPARTY_PITCH_PATTERNS = [
  /\b(?:i|we)\s+(?:also\s+)?(?:have|got|own|sell|offer)\s+(?:some\s+|a\s+few\s+|several\s+|multiple\s+|other\s+|more\s+|lots\s+of\s+|plenty\s+of\s+)?(?:off[\s-]?market|cash[\s-]?flowing|turn[\s-]?key|rental|investment|wholesale)\s+(?:units|properties|deals|homes|houses|rentals|inventory|portfolio|doors)\b/,
  /\b(?:off[\s-]?market|cash[\s-]?flowing|turn[\s-]?key)\s+(?:units|properties|deals|homes|rentals|inventory)\b[^.!?]{0,60}\b(?:selling|for\s+sale|available|at\s+market)\b/,
  /\bif\s+(?:you\s+are|you'?re|your|ur|u\s+r)\s+(?:interested|looking)\s+(?:in|for)\s+(?:rentals|rental\s+properties|buying\s+(?:more|other)|properties|deals|off[\s-]?market|investment\s+properties|more\s+(?:deals|properties))\b/,
  /\b(?:i'?m|i\s+am|im|we'?re|we\s+are)\s+(?:also\s+|an?\s+|also\s+an?\s+)?(?:real\s+estate\s+)?(?:investor|wholesaler|flipper)s?\b/,
  /\bi\s+(?:also\s+)?wholesale\b|\bwholesal(?:e|ing)\s+(?:deals|properties|houses|homes)\b/,
  /\b(?:send|text|get)\s+(?:you\s+)?(?:the|my|our)\s+(?:list|inventory|deal\s+sheet|deals?\s+list|buyers?\s+list)\b|\b(?:send|sending)\s+the\s+list\s+to\s+you\b|\bmy\s+(?:buyers?\s+list|inventory|deal\s+list)\b/,
  /\byo\s+tambien\s+compro\s+casas\b|\bestamos\s+en\s+el\s+mismo\s+negocio\b|\bsoy\s+(?:inversionista|mayorista)\b/,
];

/** The reply pitches the respondent's own inventory / investor business. */
export function matchesCounterpartyInvestorPitch(message = "") {
  const folded = foldRound11(message);
  if (!folded || folded.length > 400) return false;
  return COUNTERPARTY_PITCH_PATTERNS.some((re) => re.test(folded));
}

// A short affirmative answering OUR ownership question ("Yes, ...", "Si, ...",
// "I do", "We do", "It is", "I am"), or explicit first-person ownership.
const SIMPLE_OWNERSHIP_YES_RE = /^(?:(?:hi|hey|hello|hola)[\s,.!]+)?(?:yes+|yeah|yep|yup|si|correct|i\s+do|we\s+do|it\s+is|i\s+am|i'?m\s+the\s+owner)\b/;
const EXPLICIT_OWNERSHIP_RE = /\b(?:i|we)\s+(?:still\s+)?own\s+(?:it|this|that|the\s+(?:house|home|property))\b|\b(?:it'?s|its|it\s+is)\s+(?:mine|ours)\b|\bi'?m\s+the\s+(?:owner|homeowner)\b/;

export function detectSimpleOwnershipAffirmation(message = "", ownership_question = false) {
  const folded = foldRound11(message);
  if (!folded) return false;
  if (EXPLICIT_OWNERSHIP_RE.test(folded)) return true;
  return ownership_question === true && SIMPLE_OWNERSHIP_YES_RE.test(folded);
}

const COUNTERPARTY_EXCLUDED = new Set(["opt_out", "wrong_number", "hostile_or_legal", "hostile_or_troll", "sold_property", "property_specific_non_owner"]);

/**
 * Pure. Runs for any non-compliance primary. ctx: { message, compliance_flag,
 * ownership_affirmed, ownership_question }.
 */
export function applyRound11CounterpartyRule(intents = {}, ctx = {}) {
  const primary = String(intents.primary_intent || "unclear");
  if (ctx.compliance_flag || COUNTERPARTY_EXCLUDED.has(primary)) return { intents, matched: false };
  if (!matchesCounterpartyInvestorPitch(ctx.message)) return { intents, matched: false };
  // Without an ownership answer, a "positive" read is about OUR buying, not
  // their selling: the counterparty is not a seller lead.
  const affirmed = ctx.ownership_affirmed === true || detectSimpleOwnershipAffirmation(ctx.message, ctx.ownership_question === true);
  const next = affirmed
    ? "ownership_confirmed"
    : ["unclear", "callback_requested", "latent_interest", "seller_interested"].includes(primary)
      ? "not_interested"
      : primary;
  return {
    matched: true,
    intents: {
      ...intents,
      primary_intent: next,
      secondary_intent: "counterparty_is_investor",
      secondary_intents: uniq(["counterparty_is_investor", ...(intents.secondary_intents || []).filter((i) => i !== next && i !== "unclear" && i !== "callback_requested")]),
      matched_intents: uniq([next, ...(intents.matched_intents || []).filter((i) => i !== "unclear" && i !== "callback_requested")]),
      matched_rule_ids: uniq([...(intents.matched_rule_ids || []), "r11_counterparty_investor_pitch"]),
      ambiguity_flags: [],
      precedence_result: "round11_counterparty_investor_pitch",
      calibrated_rule_family_id: "r11_counterparty_investor_pitch",
      confidence_rationale: "r11_counterparty_investor_pitch",
      contextual_confidence: 0.85,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 5. TEXT-ONLY REDIRECT GATE ("Sorry I missed you, texting is the fastest ...")
// ══════════════════════════════════════════════════════════════════════════
// That copy may follow ONLY a real missed inbound call, or an explicit request
// for a PHONE call (we only text). "message me" / "text me" / "hit me up" is a
// text, not a call.
const EXPLICIT_CALL_REQUEST_RE =
  /\b(?:call\s+me|phone\s+me|ring\s+me|give\s+(?:me|us)\s+a\s+(?:call|ring|phone\s+call)|(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:call|phone|ring)\b|call\s+(?:me\s+)?(?:back|at|when|anytime|any\s+time|whenever|tomorrow|today|tonight|now|asap)\b|call\s+(?:this|my)\s+(?:number|cell|phone)|(?:hop|jump|get)\s+on\s+(?:a|the)\s+(?:call|phone)|(?:schedule|set\s+up|setup)\s+a\s+(?:call|time\s+to\s+(?:call|talk))|(?:quick|phone)\s+call\b|talk\s+(?:on|over)\s+the\s+phone|prefer\s+(?:a\s+)?(?:call|to\s+talk)|llam(?:ame|eme|enme)|marcame|me\s+puede\s+llamar|(?:i|we)\b[^.!?]{0,24}\b(?:called|calling|phoned|rang)\s+(?:you|u|ya|back|the\s+number)|(?:you|u)\s+(?:never|not|don'?t|didn'?t|dont|didnt)\s+(?:answer|pick(?:ed)?\s+up)|not\s+answering|went\s+to\s+voicemail|te\s+llame|no\s+contest(?:as|a|aste))\b/;

/** An explicit request for (or report of) a voice call -- never "text me". */
export function isExplicitCallRequest(message = "") {
  return EXPLICIT_CALL_REQUEST_RE.test(foldRound11(message));
}

/** Is there a missed inbound call on this thread? (message_events event_type missed_call) */
export function threadHasMissedCall(events = []) {
  return (Array.isArray(events) ? events : []).some((e) => {
    const t = String(e?.event_type || e?.type || "").toLowerCase();
    return t === "missed_call" || (e?.metadata?.call && /missed|no_answer|busy|not_forwarded/.test(String(e.metadata.call.outcome || "")));
  });
}
