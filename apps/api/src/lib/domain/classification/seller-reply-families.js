/**
 * SELLER REPLY FAMILIES (2026-10-13).
 *
 * Production, last 12h of inbound: 17 bare negatives ("No", "Nope", "No!!!!!",
 * "Not really", "No gracias Carlos!") answered our S1 ownership question and
 * got NO reply, plus a handful of who-is-this / conditional-interest /
 * keeper / preparing-to-sell replies that fell to unclear. Rather than widen
 * a dozen regexes across classify, conversation-context and round 11, each
 * family is ONE pure matcher here; the callers decide what the family means
 * against the question we asked.
 *
 * Every matcher:
 *  - is pure (no I/O) and reads only the seller's own words;
 *  - is whole-message (or tightly anchored), so a longer message with more
 *    meaning is never flattened;
 *  - never matches a stop / opt-out word — compliance runs before any caller
 *    and these rules can never weaken it.
 *
 * OWNER RULES (binding): "A not interested is a 30 day follow up" (nurture,
 * never suppressed); only an explicit stop-contact request suppresses.
 */

export const SELLER_REPLY_FAMILIES_VERSION = "seller-reply-families-2026-10-13";

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;

/** Lowercased, accent-folded, apostrophes unified, punctuation → spaces. */
export function foldSellerReply(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(EMOJI_RE, " ")
    .replace(/[‘’‚‛`´]/g, "'")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.!?,;:¡¿"()*~…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Belt and braces only: compliance runs before every caller. Any contact
// revocation word means "not this family".
const STOP_WORD_RE = /\b(?:stop|unsubscribe|remove|quit|cancel|basta|baja|pare|paren|block(?:ed|ing)?|lose\s+(?:this|my)\s+number|do\s+not\s+(?:text|contact|call|message)|don'?t\s+(?:text|contact|call|message)|dont\s+(?:text|contact|call|message)|no\s+(?:me\s+)?(?:escriba|escribas|llame|llames|contacte|mande)\w*|deja\s+de|dejen\s+de)\b/;

// ── 1. BARE NEGATIVE ──────────────────────────────────────────────────────
// A refusal with NO ownership-denial words. "No I don't", "No I'm not",
// "not mine", "sold it", "wrong number", "not anymore", "ya no es mio",
// "never owned it" are ownership answers and are deliberately NOT here: they
// keep their own classification.
const BARE_NEGATIVE_CORE =
  "(?:no+|nope+|nah+|naw+|nel|negative|not\\s+really|no\\s+not\\s+really|nope\\s+not\\s+really|nah\\s+not\\s+really|" +
  "not\\s+at\\s+all|no\\s+not\\s+at\\s+all|of\\s+course\\s+not|absolutely\\s+not|hell\\s+no|heck\\s+no|no\\s+way|" +
  "no\\s+no|no\\s+no\\s+no|no\\s+and\\s+no|no\\s+sir|no\\s+ma'?am|no\\s+senor|no\\s+senora|" +
  "nao|khong|khong\\s+phai|claro\\s+que\\s+no|para\\s+nada|no\\s+para\\s+nada)";
const POLITE_TAIL = "(?:\\s+(?:thanks|thank\\s+you|thank\\s+u|thx|ty|gracias|muchas\\s+gracias|no\\s+gracias|mil\\s+gracias))?";
const BARE_NEGATIVE_RE = new RegExp(`^${BARE_NEGATIVE_CORE}${POLITE_TAIL}$`, "u");
// Never strip these as a "name": they carry an ownership / sale answer.
const NOT_A_NAME_RE = /^(?:sold|vendid[ao]|vendi|mine|mio|mia|owner|dueno|duena|anymore|longer|never|nunca|selling|vendo|interested|interesad[ao]|now|yet|todavia|aun|ahorita|ahora|today|hoy|right|it|this|that|esa|esta|eso|for|para|sale|venta)$/;

function stripTrailingName(folded, names = []) {
  const parts = folded.split(" ");
  if (parts.length < 2) return folded;
  const last = parts[parts.length - 1];
  if (!/^[a-z]{2,15}$/.test(last) || NOT_A_NAME_RE.test(last)) return folded;
  const known = (Array.isArray(names) ? names : [names])
    .map((n) => foldSellerReply(n).split(" ")[0])
    .filter(Boolean);
  const head = parts.slice(0, -1).join(" ");
  // A context name (our agent / the addressee) is always a sign-off. Any other
  // single word is only taken as a name after a polite close ("No thanks Bob").
  if (known.includes(last)) return head;
  if (/(?:thanks|thank\s+you|thank\s+u|thx|gracias)$/.test(head)) return head;
  return folded;
}

/**
 * The bare negative family, or null. Returns { matched: true, canonical } where
 * canonical is the folded refusal ("no", "not really", "no gracias").
 * names: our agent / addressee from the conversation context (sign-offs).
 */
export function matchBareNegative(message, { names = [] } = {}) {
  if (typeof message !== "string") return null;
  if (!message.trim() || message.length > 60) return null;
  let folded = foldSellerReply(message);
  if (!folded || STOP_WORD_RE.test(folded)) return null;
  folded = folded.replace(/^(?:hi|hey|hello|hola|ok|okay)\s+(?=\S)/, "");
  folded = stripTrailingName(folded, names);
  return BARE_NEGATIVE_RE.test(folded) ? { matched: true, canonical: folded } : null;
}

export function isBareNegative(message, options = {}) {
  return matchBareNegative(message, options) !== null;
}

// ── 2. IDENTITY / PURPOSE QUESTION (who_is_this) ──────────────────────────
// "Sorry I dont know who this is", "Que nesesitas" (sic), "Why do you want
// it", "...cual es el nombre de tu compañia?". The existing who_is_this
// templates answer who we are and why we ask.
const IDENTITY_QUESTION_PATTERNS = [
  /^(?:sorry\s+)?(?:i\s+)?(?:do\s*n'?o?t|don'?t|dont|do\s+not|dunno|no)\s+(?:know|recognize)\s+(?:who\s+(?:this|you)\s+(?:is|are)|(?:this|your)\s+(?:number|name))(?:\s+sorry)?$/,
  /^(?:que|q|k)\s+(?:ne[cs]+e?sitas?|ne[cs]+e?sita|necesitan|nesecitas?|quieres?|quiere|desea|deseas|busca|buscas)(?:\s+(?:de\s+mi|conmigo|usted))?$/,
  /^(?:and\s+)?why\s+(?:do|would|are|r)\s+(?:you|u)\s+(?:want(?:ing)?|asking|need)(?:\s+(?:it|to\s+know|that|this|about\s+it|the\s+(?:house|property)))?$/,
  /\b(?:cual|como)\s+(?:es\s+)?(?:se\s+llama|el\s+nombre\s+de)\s+(?:tu|su)\s+(?:compan+ia|compania|empresa|negocio)\b|\bnombre\s+de\s+(?:tu|su)\s+(?:compan+ia|compania|empresa)\b/,
];

export function matchIdentityQuestion(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 160) return false;
  const folded = foldSellerReply(message).replace(/ñ/g, "n");
  if (!folded || STOP_WORD_RE.test(folded)) return false;
  return IDENTITY_QUESTION_PATTERNS.some((re) => re.test(folded));
}

// ── 3. CONDITIONAL INTEREST (an S2 yes → the S3 asking-price question) ────
// "Only if it's market value", "only if the price is right", "depends on the
// price", "if the money is right". A condition on the NUMBER is a yes to
// talking about one. Any negation ("not even if…") is excluded.
const CONDITION_OBJECT = "(?:the\\s+)?(?:price|money|offer|number|deal|amount|cash|terms)";
const CONDITIONAL_INTEREST_PATTERNS = [
  new RegExp(`^(?:(?:maybe|possibly|yes|yeah|sure|ok|okay|well|i\\s+guess)\\s+)?(?:only\\s+)?(?:if|when)\\s+${CONDITION_OBJECT}\\s+(?:is|was|were|are|be|'?s)\\s+(?:right|good|fair|enough|decent|reasonable|worth\\s+it)$`),
  /^(?:(?:maybe|possibly|yes|yeah|sure|ok|okay|well)\s+)?(?:only\s+)?(?:if|when|at|for)\s+(?:it'?s|its|it\s+is|the\s+price\s+is|the\s+offer\s+is|you\s+(?:pay|offer))?\s*(?:full\s+|fair\s+)?market\s+value$/,
  new RegExp(`^(?:(?:maybe|possibly|well)\\s+)?(?:it\\s+)?(?:all\\s+)?depends\\s+on\\s+${CONDITION_OBJECT}$`),
  /^(?:(?:maybe|possibly|yes|yeah|sure)\s+)?(?:only\s+)?(?:for|at)\s+the\s+right\s+(?:price|number|offer)$/,
  /^(?:solo\s+)?si\s+(?:el\s+)?(?:precio|dinero|oferta)\s+(?:es|esta)\s+(?:bien|bueno|justo|correcto)$|^depende\s+(?:del?\s+)?(?:precio|oferta|dinero)$/,
];
const CONDITION_NEGATION_RE = /\b(?:not|never|no|nope|nah|nunca|ni)\b/;

export function matchConditionalInterest(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 80) return false;
  const folded = foldSellerReply(message);
  if (!folded || CONDITION_NEGATION_RE.test(folded) || STOP_WORD_RE.test(folded)) return false;
  return CONDITIONAL_INTEREST_PATTERNS.some((re) => re.test(folded));
}

// ── 4. KEEPING IT (not_interested → 30-day nurture) ───────────────────────
// "Itsa keeper", "it's a keeper", "that one's a keeper".
const KEEPER_RE = /^(?:(?:no|nope|nah)\s+)?(?:(?:it'?s|its|it\s+is|itsa|that'?s|thats|that\s+is|this\s+(?:one\s+)?is|that\s+one'?s|that\s+one\s+is)\s+)?a?\s*keeper(?:\s+(?:for\s+(?:me|us|now)|sorry))?$/;

export function matchKeeper(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 60) return false;
  const folded = foldSellerReply(message).replace(/^itsa\s*keeper/, "its a keeper");
  return KEEPER_RE.test(folded);
}

// ── 5. PREPARING TO SELL (latent_interest, a human lane) ──────────────────
// "Estamos intalando shower doors sprinkler para ponerla ala venta" — the
// owner is getting the house ready to list. Interest, but toward a retail
// sale: a person reads it (no automatic reply).
const PREPARING_TO_SELL_PATTERNS = [
  /\bpara\s+(?:ponerla|ponerlo|poner\s*la|poner\s*lo|meterla|sacarla)\s+(?:a\s*la|ala|en|a)\s+venta\b/,
  /\b(?:preparando|arreglando|alistando)\s+(?:la\s+casa\s+|la\s+propiedad\s+)?para\s+(?:la\s+)?venta\b/,
  /\b(?:getting|fixing)\s+(?:it|the\s+(?:house|home|property))\s+(?:up\s+)?(?:ready\s+)?(?:to|for)\s+(?:sell|sale|list|market)\b|\b(?:getting|fixing)\s+(?:it|the\s+(?:house|home|property))\s+ready\s+(?:to|for)\s+(?:sell|sale|list|market)\b|\bbefore\s+(?:we|i)\s+(?:list|sell)\s+it\b/,
];

export function matchPreparingToSell(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 240) return false;
  const folded = foldSellerReply(message);
  if (!folded || STOP_WORD_RE.test(folded)) return false;
  if (/\b(?:not|no|never|nunca)\s+(?:la\s+|lo\s+)?(?:going\s+to\s+|gonna\s+|voy\s+a\s+|vamos\s+a\s+)?(?:sell|vender|venderla|venderlo|vendo|vendemos)\b/.test(folded)) return false;
  return PREPARING_TO_SELL_PATTERNS.some((re) => re.test(folded));
}

// ── 6. OFFER DEFLECTION (asks_offer, bound to OUR asking-price question) ──
// "You tell me", "you make the offer", "you first", "dime tú": the seller
// turns our S3 question back on us. Only a caller holding the asking-price
// context may read it as an offer request.
const OFFER_DEFLECTION_RE =
  /^(?:(?:well|idk|i\s+don'?t\s+know|i\s+dont\s+know|not\s+sure|no\s+idea)\s+)?(?:you\s+tell\s+me|u\s+tell\s+me|you\s+first|you\s+go\s+first|you\s+(?:make|give)\s+(?:me\s+)?(?:the|an|your)\s+offer|make\s+me\s+(?:an|your)\s+(?:offer|best\s+offer)|(?:what'?s|whats|what\s+is)\s+your\s+(?:offer|number|best\s+offer)|what\s+(?:would|will|can|do)\s+(?:you|u)\s+(?:like\s+to\s+)?(?:offer|pay|give)(?:\s+me)?|dime\s+tu|digame\s+usted|usted\s+diga|haga\s+(?:me\s+)?una\s+oferta|hagame\s+una\s+oferta|cuanto\s+(?:me\s+)?(?:ofrece|ofreces|da|das|paga|pagas))$/;

export function matchOfferDeflection(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 80) return false;
  const folded = foldSellerReply(message);
  if (!folded || STOP_WORD_RE.test(folded)) return false;
  return OFFER_DEFLECTION_RE.test(folded);
}
