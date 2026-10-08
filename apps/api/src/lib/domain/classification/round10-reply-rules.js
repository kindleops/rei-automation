// ─── round10-reply-rules.js ──────────────────────────────────────────────────
// Round 10 classifier rules (owner 2026-10-08, from the offline Haiku 5.5 reply
// audit). Deterministic and rules-only: no model, no network, no I/O.
//
//  1. An owner who CONFIRMS ownership while declining to sell ("Yes, but not
//     for sale", "Yes I am. Not interested", "We do. Keeping that one") keeps
//     the ownership evidence (ownership_fact) while the intent stays
//     not_interested -> the 30-day nurture. Never a positive lead.
//  2. An OWNERSHIP DENIAL ("I never owned it", "it isn't mine", "keep looking",
//     "not my house") is property-scoped: property_specific_non_owner closes
//     the person x property and leaves the phone usable. A WRONG-NUMBER claim
//     ("wrong number", "you have the wrong person", "not <NAME>") is about the
//     phone and still blocks it (wrong_number).
//  3. Explicit contact revocations the phrase list missed are opt-outs, and an
//     opt-out OVERRIDES every ordinary intent ("please do not bother us",
//     "borra mi número", "quite este número de la lista", "cease and desist",
//     "degar de molestar", "I'll sue you if you text me again", "rwmove me from
//     all you lists", "please don't call about my house", a closing "No more").
//  4. A legal threat that carries a stop-contact demand is an opt-out PLUS a
//     human legal-review flag -- never a quiet hostile archive.
//  5. "how did you get my number" -> the info-source explanation; "Si porque" /
//     "Yes. Why" at the ownership question -> who/why with ownership kept;
//     "under contract" / "listed with a realtor" -> the listed disposition.
//
// classify.js calls matchRound10OptOut() inside its compliance chain and
// applyRound10IntentRules() once, right after resolveIntents().

export const ROUND10_RULES_VERSION = "round10-2026-10-08";

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
export function foldRound10(value) {
  return normalize(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// ══════════════════════════════════════════════════════════════════════════
// 3 + 4. OPT-OUT OVERRIDES
// ══════════════════════════════════════════════════════════════════════════

// Text-channel preference ("don't call me, text me"): a CALL-only prohibition
// next to an explicit text affirmative is a channel preference, not an opt-out.
const TEXT_CHANNEL_AFFIRMATIVE_RE =
  /\b(?:text\s+me|text\s+only|text\s+is\s+fine|just\s+text|prefer\s+text|rather\s+text|text\s+instead|texting\s+is\s+fine|text\s+works|you\s+can\s+text|texts\s+are\s+fine|por\s+texto|solo\s+texto|mejor\s+texto)\b/;

// "Why don't you call me", "if you don't text me back": an invitation, not a
// prohibition.
const INVITATION_NEGATION_RE = /\b(?:why|if|when|unless)\s+(?:you|u|ya|y'?all)?\s*(?:don'?t|dont|do\s+not|do\s+nt)\b|\b(?:you|u)\s+(?:don'?t|dont|do\s+not)\s+(?:call|text|contact|message)\b/;

const OPT_OUT_PATTERNS = [
  // O1 remove from list(s), typo-tolerant verb ("rwmove", "remve"), optional
  // object ("Please take off any list it may be on").
  {
    rule_id: "r10_remove_from_lists",
    re: /\b(?:take|r\w?mo?ve|remove|delete|erase|drop)\s+(?:me|us|my\s+(?:name|number|info\w*|phone(?:\s+number)?|contact(?:\s+info\w*)?)|this\s+(?:number|phone(?:\s+number)?)|it|them)?\s*(?:off|from|out\s+of)\s+(?:of\s+)?(?:any|all|every|your|you|ur|yo|the|this|that|ya|these|those)?\s*(?:\w+\s+)?(?:lists?|database|contacts?|records?|system)\b/,
  },
  {
    rule_id: "r10_remove_from_lists",
    re: /\bget\s+(?:me|us|my\s+(?:name|number|info\w*)|this\s+number)\s+(?:off|out\s+of)\s+(?:of\s+)?(?:any|all|every|your|you|ur|yo|the|this|that|ya|these|those)?\s*(?:\w+\s+)?(?:lists?|database|contacts?|records?|system)\b/,
  },
  // O2 Spanish remove / delete this / my number ("borra mi pinche numero",
  // "quite este numero de la lista").
  {
    rule_id: "r10_es_remove_number",
    re: /\b(?:quit[ae]n?|quitar|quiteme|quitame|borr[ae]n?|borrar|elimin[ae]n?|eliminar|sac[ae]n?|sacar|saque)\s+(?:mi|este|el|su|nuestro|ese)\s+(?:[a-z]+\s+)?(?:numero|telefono|celular|cel)\b/,
  },
  {
    rule_id: "r10_es_remove_me_from_list",
    re: /\b(?:quitame|quitenme|quiteme|sacame|saquenme|saqueme|borrame|borrenme|borreme|eliminame|eliminenme|elimineme)\s+de\s+(?:la|su|tu|sus|tus|esta|esa|las)?\s*(?:lista|listas|base)\b/,
  },
  // O3 Spanish stop bothering, misspelled ("puedes degar de molestar").
  { rule_id: "r10_es_stop_bothering", re: /\bde[jg](?:a|ar|e|en|es|o|ad)\s+de\s+molest\w*/ },
  // "no molestes" / "no nos molesten" ("don't bother (me/us)"); "no molesta"
  // ("it doesn't bother") is not a revocation.
  { rule_id: "r10_es_do_not_bother", re: /\bno\s+(?:me\s+|nos\s+|mas\s+|me\s+mas\s+)?molest(?:es|e|en|ar|en\s+mas|es\s+mas)\b/ },
  // O4 cease and desist (also a legal flag).
  { rule_id: "r10_cease_and_desist", re: /\bcease\s+(?:and|&|n)\s+desist\b/ },
  // O5 "please do not bother us", "don't call about my house".
  {
    rule_id: "r10_do_not_bother_or_contact",
    re: /\b(?:do\s+not|don'?t|dont|do\s+nt)\s+(?:ever\s+)?(?:bother|call|contact|text|message|msg|txt|reach\s+out\s+to)\s+(?:me|us|this\s+(?:number|phone|#)|our\s+(?:number|phone|house|home|property))\b/,
    call_only_re: /\b(?:do\s+not|don'?t|dont|do\s+nt)\s+(?:ever\s+)?call\b/,
    skip_re: INVITATION_NEGATION_RE,
  },
  {
    rule_id: "r10_do_not_contact_about",
    re: /\b(?:do\s+not|don'?t|dont|do\s+nt)\s+(?:ever\s+)?(?:call|text|contact|message|msg|txt|bother\s+me|bother\s+us)\s+(?:me\s+|us\s+)?(?:about|regarding|re|on|over)\s+(?:my|our|the|this|that|his|her)\b/,
    call_only_re: /\b(?:do\s+not|don'?t|dont|do\s+nt)\s+(?:ever\s+)?call\b/,
    skip_re: INVITATION_NEGATION_RE,
  },
  // O6 "Stop sending text to this #" (the wrong-number rule kept the primary
  // and lost the revocation).
  { rule_id: "r10_stop_sending_texts", re: /\bstop\s+(?:sending|send|sendin)\s+(?:me\s+|us\s+)?(?:any\s+|these\s+|those\s+|the\s+|your\s+)?(?:text|texts|txt|txts|messages?|msgs?|sms|stuff)\b/ },
  // O7 a legal threat conditioned on further contact.
  {
    rule_id: "r10_legal_threat_if_contacted",
    re: /\b(?:sue|suing|lawsuit|lawyer|attorney|legal\s+action|take\s+(?:you|u)\s+to\s+court|report\s+(?:you|u|this))\b[^.!?\n]{0,40}\b(?:if\s+(?:you|u|y'?all)\s+(?:ever\s+)?(?:text|txt|call|contact|message|msg|reach\s+out|bother)|(?:text|txt|call|contact|message|msg|bother)\s+(?:me|us)\s+again|again)\b/,
    legal: true,
  },
  {
    rule_id: "r10_legal_threat_if_contacted",
    re: /\bif\s+(?:you|u|y'?all)\s+(?:ever\s+)?(?:text|txt|call|contact|message|msg|bother)\s+(?:me|us)\s+again\b[^.!?\n]{0,40}\b(?:sue|suing|lawsuit|lawyer|attorney|legal\s+action|court|report\s+(?:you|u|this))\b/,
    legal: true,
  },
];

// O8 a closing "No more" (the whole message, or a capitalized closing clause:
// "No that house is not mine No more"). A lowercase "...own it no more" means
// "no longer" and is left alone.
const NO_MORE_WHOLE_RE = /^no+\s+more(?:\s+(?:please|pls|plz|thanks|thank\s+you|texts?|messages?|msgs?))?[\s.!]*$/i;
const NO_MORE_CLOSING_RAW_RE = /(?:^|[.!?,;:]\s*|\s)N[Oo]\s+(?:more|MORE)[\s.!]*$/;

// A legal threat (for the human legal-review flag on an opt-out).
const LEGAL_THREAT_RE =
  /\b(?:sue|suing|sued|lawsuit|law\s+suit|lawyer|attorney|attorney\s+general|legal\s+action|cease\s+(?:and|&|n)\s+desist|take\s+(?:you|u)\s+to\s+court|see\s+(?:you|u)\s+in\s+court|tcpa|fcc|ftc|abogad[oa]s?|demandar\w*|demandare|te\s+voy\s+a\s+demandar|los\s+voy\s+a\s+demandar)\b/;

/** True when the message carries a legal threat (sue / lawyer / cease and desist / court / TCPA ...). */
export function hasLegalThreat(message = "") {
  return LEGAL_THREAT_RE.test(foldRound10(message));
}

/**
 * Round 10 explicit contact revocations missed by the phrase list.
 * Returns { matched, rule_id, legal } -- legal = the message also threatens
 * legal action (opt-out + a human legal-review flag).
 */
export function matchRound10OptOut(message = "") {
  const raw = normalize(message);
  const folded = foldRound10(message);
  if (!folded) return { matched: false };
  for (const pattern of OPT_OUT_PATTERNS) {
    if (!pattern.re.test(folded)) continue;
    if (pattern.skip_re && pattern.skip_re.test(folded)) continue;
    // Channel preference: a call-only prohibition next to "text me".
    if (pattern.call_only_re && pattern.call_only_re.test(folded) && TEXT_CHANNEL_AFFIRMATIVE_RE.test(folded)) {
      const other = OPT_OUT_PATTERNS.some((p) => p !== pattern && !p.call_only_re && p.re.test(folded));
      if (!other) continue;
    }
    return { matched: true, rule_id: pattern.rule_id, legal: Boolean(pattern.legal) || LEGAL_THREAT_RE.test(folded) };
  }
  // Owner correction 2026-10-08: never suppress a decline. A bare "No more" is
  // ambiguous ("no more [offers]") -> not an opt-out; only the closing
  // "... No more" clause after another statement (R0933) counts.
  void NO_MORE_WHOLE_RE;
  if (NO_MORE_CLOSING_RAW_RE.test(raw) && !/^\s*no+\s+more\b/i.test(raw)) {
    return { matched: true, rule_id: "r10_no_more", legal: LEGAL_THREAT_RE.test(folded) };
  }
  return { matched: false };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 + 5. OWNERSHIP AFFIRMATION (kept as a fact whatever the intent)
// ══════════════════════════════════════════════════════════════════════════

// Explicit first-person ownership, anywhere near the start.
const EXPLICIT_OWNERSHIP_RE =
  /^(?:(?:hi|hey|hello|hola|well|yes|yeah|yep|si|ok|okay|sir|ma'?am)[\s,.!]+(?:[a-z<>]+[\s,.!]+)?){0,2}(?:(?:yes|yeah|yep|si)[\s,.!]+)?(?:i\s+(?:do\s+)?own\b|we\s+(?:do\s+)?own\b|(?:it|that|this)\s+(?:is|'s)\s+(?:mine|ours|my\s+(?:house|home|property))\b|it'?s\s+(?:mine|ours)\b|its\s+(?:mine|ours)\b|i\s+am\s+(?:still\s+)?the\s+(?:owner|homeowner|property\s+owner)\b|i'?m\s+(?:still\s+)?the\s+(?:owner|homeowner|property\s+owner)\b|im\s+(?:still\s+)?the\s+owner\b|(?:both\s+units|the\s+units|they)\s+are\s+(?:mine|ours)\b|soy\s+(?:el|la)\s+(?:due[nñ][oa]|propietari[oa])\b|si\s+es\s+mi[ao]\b|es\s+mi[ao]\b)/;
// A bare affirmative that answers OUR ownership question ("Yes", "Si", "We do",
// "I do", "It is", "Yes I am"). Only read as ownership when the last outbound
// asked about ownership.
const AFFIRMATIVE_OPENER_RE =
  /^(?:(?:hi|hey|hello|well|ok|okay)[\s,.!]+(?:[a-z<>]+[\s,.!]+)?){0,2}(?:(?:yes+|yea+h?|yeah|yep+|yup|of\s+course|correct|that'?s\s+(?:right|correct))(?![a-z])|(?:(?:we|i)\s+(?:still\s+)?do|it\s+is|i\s+am|we\s+are|sure\s+do)(?=\s*(?:$|[,.!;:?]|\s+(?:and|but|&|why)\b)))/;
// Spanish "si" is also "if" ("Si no me ..."): only a "si" closed by punctuation
// or followed by an answer word counts.
const SPANISH_SI_RE =
  /^(?:(?:hola|buenas|buenos\s+dias|buenas\s+tardes)[\s,.!]+(?:[a-z<>]+[\s,.!]+)?){0,2}(?:si+|claro\s+que\s+si)(?=\s*(?:$|[,.!;:?]|\s+(?:pero|soy|es|somos|y|claro|senor|senora|gracias|tengo|porque|por\s+que)\b))/;
// A "yes" that is about something other than ownership.
const NON_OWNERSHIP_YES_RE =
  /^(?:yes|yeah|yep|si)[\s,.!]+(?:(?:i|we)\s+(?:sold|sell|rent|lease|used\s+to)|(?:it\s+)?(?:was|got)\s+sold|(?:la|lo)\s+vend[ií]|ya\s+(?:la|lo)\s+vend[ií]|vendid[ao]|this\s+is\s+(?:the\s+)?(?:wrong|not))/;

const OWNERSHIP_EXCLUDED_PRIMARIES = new Set([
  "wrong_number",
  "property_specific_non_owner",
  "sold_property",
  "former_owner_respondent",
  "tenant_respondent",
  "hostile_or_troll",
  "reaction_only",
]);

/**
 * Does this reply CONFIRM ownership (independently of its primary intent)?
 * Explicit first-person ownership always counts; a bare affirmative counts only
 * as the answer to our ownership question.
 */
export function detectOwnershipAffirmation(message = "", { ownership_question = false } = {}) {
  const folded = foldRound10(message);
  if (!folded) return { matched: false };
  if (NON_OWNERSHIP_YES_RE.test(folded)) return { matched: false };
  // A denial anywhere ("yes I used to", "not mine") is never a confirmation.
  if (/\b(?:not\s+(?:mine|ours|the\s+owner|my\s+(?:house|home|property))|never\s+owned|no\s+longer\s+own|don'?t\s+own|do\s+not\s+own|dont\s+own|no\s+soy\s+(?:el|la)\s+due)/.test(folded)) {
    return { matched: false };
  }
  if (EXPLICIT_OWNERSHIP_RE.test(folded)) return { matched: true, rule_id: "r10_ownership_explicit" };
  if (ownership_question && (AFFIRMATIVE_OPENER_RE.test(folded) || SPANISH_SI_RE.test(folded))) {
    return { matched: true, rule_id: "r10_ownership_affirmative_to_ownership_question" };
  }
  return { matched: false };
}

// ══════════════════════════════════════════════════════════════════════════
// 2. OWNERSHIP DENIAL vs WRONG NUMBER
// ══════════════════════════════════════════════════════════════════════════

// The reply is about the PERSON / PHONE (wrong number): these keep wrong_number.
export const PERSON_MISMATCH_RULES = Object.freeze(new Set([
  "wrong_person_addressee_negated",
  "wrong_person_not_name",
  "wrong_person_this_isnt_name",
  "wrong_person_i_am_not_name",
  "wrong_person_no_soy_name",
  "wrong_person_nao_sou_name",
  "wrong_person_khong_phai_name",
  "wrong_person_explicit",
  // "you're misinformed": a person confirms before anything is written.
  "wrong_person_premise_denied",
]));
// Disposition rules that deny OWNERSHIP of the property, not the phone.
const PROPERTY_DENIAL_RULES = new Set(["wrong_person_never_owned", "wrong_person_not_at_property"]);

// Non-bare ownership denials that answer OUR ownership question and that the
// rules left unclear (the bare "No" / "No, I'm not" / "No I don't" family keeps
// the owner's bare-No policy: a hold, never this rule).
const OWNERSHIP_QUESTION_DENIAL_PATTERNS = [
  // "No it isn't" / "No it is not" / "No is not" / "That isn't mine"
  /^(?:no+[\s,.!]*)?(?:(?:it|that|this|that\s+one|this\s+one)\s+)?(?:isn'?t|is\s*not|ain'?t|aint|is\s+n'?t)(?:\s+(?:mine|ours|my\s+(?:house|home|property)))?(?:[\s,.!]+(?:sorry|thanks|thank\s+you|thx))?[\s.!]*$/,
  // "No, and I never have been" / "No and I never did"
  /^(?:no+[\s,.!]+)?(?:and\s+)?(?:i\s+)?(?:have\s+)?never\s+(?:have\s+|did\s+)?(?:been|was|did|owned|had|have)\b(?:\s+(?:the\s+owner|it|that|one|any))?(?:[\s,.!]+(?:sorry|thanks|thank\s+you))?[\s.!]*$/,
  // "Keep looking" (short)
  /^keep\s+(?:on\s+)?looking\b(?:[\s,.!]+[a-z<>]+){0,2}[\s.!]*$/,
  // "too young to own a house", "not old enough to own"
  /\btoo\s+young\s+to\s+(?:own|have|buy)\b|(?:\bnot|n'?t)\b[^.!?]{0,30}\bold\s+enough\s+to\s+(?:own|have|buy)\b/,
  // "I have nothing to do with this property", "never heard of that address"
  /\b(?:nothing\s+to\s+do\s+with|no\s+connection\s+(?:to|with)|not\s+connected\s+(?:to|with))\s+(?:this|that|the|said)\s+(?:property|house|home|address|place|lot)\b/,
  /\bnever\s+heard\s+of\s+(?:this|that|the)\s+(?:property|house|home|address|place|street)\b/,
  // Spanish: "No es mi propiedad(a)", "no tengo (ninguna) casa", "no tengo esa propiedad"
  /\bno\s+es\s+(?:mi|nuestra|nuestro)\s+(?:propiedad\w*|casa\w*|terreno|lote)\b/,
  /\bno\s+tengo\s+(?:ninguna\s+|esa\s+|una\s+)?(?:casa|propiedad\w*|terreno)\b/,
];

/** Non-bare ownership denial to OUR ownership question (rules left it unclear). */
export function matchesOwnershipQuestionDenial(message = "") {
  const folded = foldRound10(message);
  if (!folded || folded.length > 220) return false;
  return OWNERSHIP_QUESTION_DENIAL_PATTERNS.some((re) => re.test(folded));
}

// ══════════════════════════════════════════════════════════════════════════
// 5. INFO SOURCE / WHO-WHY / LISTED
// ══════════════════════════════════════════════════════════════════════════

const INFO_SOURCE_PATTERNS = [
  /\b(?:how|where|wh?ere|hw)\s*(?:did|do|does|d|'d|'?d)?\s*(?:you|u|ya|y'?all|you\s+guys)\s+(?:get|got|find|found|obtain|obtained|pull|grab|know|come\s+across)\s+(?:my|this|our|the)?\s*(?:number|nbr|nmbr|numbr|#|phone(?:\s+number)?|cell(?:\s+number)?|info\w*|contact(?:\s+info\w*)?|name)\b/,
  /\bhowd\s+(?:you|u)\s+(?:get|got|find|know)\s+(?:my|this)?\s*(?:number|nbr|#|phone|info\w*|name)\b/,
  /\bwhere\s+(?:is|was|did)\s+(?:my|this)\s+(?:number|info\w*)\s+(?:from|come\s+from)\b/,
  /\bwho\s+gave\s+(?:you|u)\s+(?:my|this)\s+(?:number|nbr|#|phone|info\w*|name)\b/,
  // Spanish / Portuguese
  /\b(?:como|de\s+donde|donde)\s+(?:\w+\s+)?(?:encontr|consigu|obtuv|sac|tienes?|tiene|tienen|consegu)\w*\s+(?:mi|este|mis)\s+(?:numero|informacion|info|telefono|datos|nombre)\b/,
  /\bquien\s+(?:te|le|les)\s+(?:dio|paso)\s+(?:mi|este)\s+(?:numero|informacion|telefono)\b/,
  /\b(?:como|onde)\s+(?:voce|vc)?\s*(?:conseguiu|achou|pegou|obteve)\s+(?:meu|este|o\s+meu)\s+(?:numero|contato|telefone)\b/,
];

/** "how did you get my number" / "como encontraste mi informacion" / "how do you know my name". */
export function matchesInfoSourceQuestion(message = "") {
  const folded = foldRound10(message);
  if (!folded || folded.length > 280) return false;
  return INFO_SOURCE_PATTERNS.some((re) => re.test(folded));
}

// "Si porque" / "Yes. Why" / "It is. Why do you ask": yes + why.
const AFFIRMATIVE_WHY_RE =
  /^(?:(?:hi|hey|hello|hola)[\s,.!]+)?(?:yes+|yeah|yep|yup|si|it\s+is|i\s+do|we\s+do|i\s+am|correct)[\s,.!?]*(?:why|por\s*que|porque|y\s+por\s*que|how\s+come|what\s+for|para\s+que|why\s+do\s+you\s+ask|why\s+(?:are|r)\s+(?:you|u)\s+asking|who\s+(?:is|wants\s+to\s+know)\b.*)\b[\s?!.]*/;

export function matchesAffirmativeWhy(message = "") {
  const folded = foldRound10(message);
  if (!folded || folded.length > 80) return false;
  return AFFIRMATIVE_WHY_RE.test(folded);
}

// "Under contract", "It's listed with a realtor", "already listed". A lease
// ("under contract with rental / a tenant") is not a sale.
const LISTED_PATTERNS = [
  /\bunder\s+contract\b(?!\s+(?:with|w\/|to)\s+(?:a\s+|my\s+|the\s+)?(?:rental|renter|tenants?|lease|leasing))/,
  /\b(?:it'?s|its|it\s+is|is|already|currently|we\s+are|we'?re)\s+(?:already\s+|currently\s+)?listed\b(?!\s+(?:as|wrong|incorrectly|under)\b|\s+at\s+\$?\d)/,
  /\blisted\s+(?:with|by|thru|through)\s+(?:a\s+|an\s+|my\s+|our\s+)?(?:realtor|agent|broker|real\s+estate\s+agent|brokerage|company)\b/,
  /\b(?:in\s+escrow|sale\s+pending|pending\s+sale|accepted\s+an?\s+offer|offer\s+accepted)\b/,
  /\b(?:bajo\s+contrato|ya\s+esta\s+(?:listada|en\s+venta\s+con)|esta\s+con\s+(?:un|una)\s+(?:agente|realtor|corredor))\b/,
];
const LISTED_QUESTION_RE = /\b(?:how|when|what|until|before|is\s+it|are\s+you)\b[^.!?]{0,24}\b(?:under\s+contract|escrow|contract|listed)\b[^.!?]*\?/;

export function matchesListedOrUnderContract(message = "") {
  const folded = foldRound10(message);
  if (!folded || LISTED_QUESTION_RE.test(folded)) return false;
  // "not listed" is the opposite.
  const stripped = folded.replace(/\bnot\s+(?:currently\s+)?listed\b/g, " ");
  return LISTED_PATTERNS.some((re) => re.test(stripped));
}

// ══════════════════════════════════════════════════════════════════════════
// THE POST-RESOLUTION STEP
// ══════════════════════════════════════════════════════════════════════════

const uniq = (list) => [...new Set((list || []).filter(Boolean))];

function withRule(intents, rule_id, extra = {}) {
  return {
    ...intents,
    matched_rule_ids: uniq([...(intents.matched_rule_ids || []), rule_id]),
    ...extra,
  };
}

/**
 * Pure. intents = resolveIntents() output. Returns { intents, facts } where
 * facts = { ownership_fact, legal_review_required, disposition_hint,
 * info_source_question, rule_ids }.
 *
 * ctx: { message, ownership_question, compliance_flag, round10_opt_out,
 *        is_true_wrong, is_ownership_disconnect, wrong_person_rule }
 */
export function applyRound10IntentRules(intents = {}, ctx = {}) {
  const message = String(ctx.message ?? "");
  const facts = {
    version: ROUND10_RULES_VERSION,
    ownership_fact: null,
    legal_review_required: false,
    disposition_hint: null,
    info_source_question: false,
    rule_ids: [],
  };
  let out = { ...intents };
  const primary = String(out.primary_intent || "unclear");
  const opt_out = ctx.compliance_flag === "stop_texting" || primary === "opt_out";

  // 4. Legal threat + opt-out -> the opt-out stands, plus a human legal review.
  if (opt_out && (ctx.round10_opt_out?.legal === true || hasLegalThreat(message))) {
    facts.legal_review_required = true;
    facts.rule_ids.push("r10_legal_threat_opt_out");
    out = withRule(out, "r10_legal_threat_opt_out", {
      secondary_intents: uniq([...(out.secondary_intents || []), "hostile_or_legal"]),
    });
  }
  if (ctx.round10_opt_out?.matched) {
    facts.rule_ids.push(ctx.round10_opt_out.rule_id);
    out = withRule(out, ctx.round10_opt_out.rule_id);
  }

  // 2. Ownership denial vs wrong number.
  if (primary === "wrong_number") {
    const person_mismatch = ctx.is_true_wrong === true || PERSON_MISMATCH_RULES.has(String(ctx.wrong_person_rule || ""));
    const property_denial = ctx.is_ownership_disconnect === true || PROPERTY_DENIAL_RULES.has(String(ctx.wrong_person_rule || ""));
    if (!person_mismatch && property_denial && !(out.matched_rule_ids || []).includes("wrong_number_with_stop")) {
      facts.rule_ids.push("r10_ownership_denial_not_owner");
      facts.disposition_hint = "not_owner";
      out = withRule(out, "r10_ownership_denial_not_owner", {
        primary_intent: "property_specific_non_owner",
        matched_intents: uniq(["property_specific_non_owner", ...(out.matched_intents || []).filter((i) => i !== "wrong_number")]),
        precedence_result: "ownership_denial_property_scoped",
        calibrated_rule_family_id: out.calibrated_rule_family_id || "r10_ownership_denial_not_owner",
      });
    }
  } else if (
    primary === "unclear" &&
    !opt_out &&
    ctx.ownership_question === true &&
    !(out.matched_rule_ids || []).some((id) => ["repeat_no_contact_frustration", "ctx_no_after_ownership_check"].includes(id)) &&
    matchesOwnershipQuestionDenial(message)
  ) {
    facts.rule_ids.push("r10_ownership_question_denial");
    facts.disposition_hint = "not_owner";
    out = withRule(out, "r10_ownership_question_denial", {
      primary_intent: "property_specific_non_owner",
      matched_intents: uniq(["property_specific_non_owner", ...(out.matched_intents || []).filter((i) => i !== "unclear")]),
      secondary_intents: (out.secondary_intents || []).filter((i) => i !== "ownership_denial_needs_clarification"),
      ambiguity_flags: [],
      precedence_result: "ownership_denial_property_scoped",
      calibrated_rule_family_id: "r10_ownership_question_denial",
      confidence_rationale: "r10_ownership_question_denial",
      contextual_confidence: 0.86,
    });
  }

  const now_primary = String(out.primary_intent || "unclear");

  // 1 + 5. Ownership confirmation is kept as a FACT whatever the intent.
  if (!OWNERSHIP_EXCLUDED_PRIMARIES.has(now_primary)) {
    const affirmation = detectOwnershipAffirmation(message, { ownership_question: ctx.ownership_question === true });
    if (affirmation.matched) {
      facts.ownership_fact = {
        ownership_confirmed: true,
        source: now_primary === "ownership_confirmed" ? "ownership_affirmation" : `ownership_affirmation_with_${now_primary}`,
        rule_id: affirmation.rule_id,
        evidence: normalize(message).slice(0, 160),
      };
      facts.rule_ids.push(affirmation.rule_id);
      if (now_primary !== "ownership_confirmed") {
        out = withRule(out, affirmation.rule_id, {
          secondary_intents: uniq([...(out.secondary_intents || []), "ownership_confirmed"]),
        });
      }
    }
  }

  // 5a. "how did you get my number" -> the info-source explanation.
  if (!opt_out && ["who_is_this", "info_request", "unclear"].includes(now_primary) && matchesInfoSourceQuestion(message)) {
    facts.info_source_question = true;
    facts.rule_ids.push("r10_info_source_question");
    out = withRule(out, "r10_info_source_question", {
      primary_intent: "who_is_this",
      matched_intents: uniq(["who_is_this", ...(out.matched_intents || []).filter((i) => i !== "unclear")]),
      secondary_intents: uniq([...(out.secondary_intents || []), "how_got_number"]),
      ambiguity_flags: now_primary === "unclear" ? [] : out.ambiguity_flags,
      contextual_confidence: now_primary === "unclear" ? 0.86 : out.contextual_confidence,
    });
  }

  // 5b. "Si porque" / "Yes. Why" at the ownership question: answer who/why,
  // and the ownership answer is kept (above).
  if (!opt_out && ctx.ownership_question === true && now_primary === "who_is_this" && matchesAffirmativeWhy(message)) {
    facts.rule_ids.push("r10_affirmative_why_at_ownership");
    out = withRule(out, "r10_affirmative_why_at_ownership");
  }

  // 5c. "Under contract" / "listed with a realtor" -> listed disposition
  // recorded on the classification. Routing is unchanged: a decline stays the
  // not-interested / 30-day nurture lane, and an agent / listing turn the
  // classifier routed elsewhere (agent involvement, review) keeps its lane.
  if (!opt_out && now_primary !== "property_specific_non_owner" && matchesListedOrUnderContract(message)) {
    facts.disposition_hint = "already_listed";
    facts.rule_ids.push("r10_listed_or_under_contract");
    out = withRule(out, "r10_listed_or_under_contract", {
      secondary_intents: uniq([...(out.secondary_intents || []), "already_listed"]),
    });
  }

  facts.rule_ids = uniq(facts.rule_ids);
  return { intents: out, facts };
}
