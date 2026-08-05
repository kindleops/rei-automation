// ─── monetary-understanding.js ───────────────────────────────────────────────
// Canonical asking-price / monetary-mention understanding for the negotiation
// loop (spec §3). Deterministic, no AI.
//
// Every number in a seller message is extracted and classified into a semantic
// kind (asking price, counter, mortgage payoff, repair amount, tax, monthly
// payment, earnest money, per-unit, package/portfolio, closing-cost term) with
// a confidence, the raw extracted text, and qualifiers (firm / net / range /
// minimum / approximate). Low-confidence money NEVER drives an offer — callers
// must route to clarification instead (resolveAskingPriceSignal surfaces
// needs_clarification for exactly that).
//
// Stage 2's extractAskingPrice remains the low-level first-price capture used
// by the stage engines; this module is the orchestration-layer authority that
// distinguishes WHAT a number means before it can touch negotiation state.

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const MONETARY_KINDS = Object.freeze({
  ASKING_PRICE: "asking_price",
  COUNTER_OFFER: "counter_offer",
  MINIMUM_PRICE: "minimum_price",
  NET_REQUIREMENT: "net_requirement",
  MORTGAGE_PAYOFF: "mortgage_payoff",
  REPAIR_AMOUNT: "repair_amount",
  TAX_AMOUNT: "tax_amount",
  MONTHLY_AMOUNT: "monthly_amount",
  EARNEST_MONEY: "earnest_money",
  PER_UNIT_PRICE: "per_unit_price",
  PACKAGE_PRICE: "package_price",
  CLOSING_COST_TERM: "closing_cost_term",
  UNKNOWN: "unknown",
});

// ═══════════════════════════════════════════════════════════════════════════
// NUMBER TOKENIZATION (digits + number words)
// ═══════════════════════════════════════════════════════════════════════════

const TIME_UNIT_TOKENS = new Set([
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "día", "dias", "días", "semana", "semanas", "mes", "meses", "año", "anos", "años",
  "am", "pm", "oclock", "o'clock",
]);

const AREA_UNIT_TOKENS = new Set(["sqft", "sq", "acre", "acres", "bed", "beds", "bedroom", "bedrooms", "bath", "baths"]);

const SMALL_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, a: 1, an: 1, half: 0.5,
  // Spanish spelled-out numbers ("ciento veinte mil" = 120,000). "cien"/
  // "ciento" are additive hundreds in Spanish, so SMALL_WORDS (not scale) is
  // correct: ciento(100) + veinte(20), then the "mil" scale multiplies.
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, dieciséis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintidós: 22,
  veintitres: 23, veintitrés: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintiséis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
  medio: 0.5, media: 0.5,
  y: 0, // connector: "ciento veinte y cinco mil"
});

const SCALE_WORDS = Object.freeze({
  hundred: 100,
  thousand: 1_000,
  grand: 1_000,
  k: 1_000,
  million: 1_000_000,
  m: 1_000_000,
  mil: 1_000, // colloquial/Spanish "mil" = thousand
  millon: 1_000_000,
  millón: 1_000_000,
  millones: 1_000_000,
});

/**
 * Parse a spelled-out number ("one hundred thousand", "ninety five", "half a
 * million", "a hundred and fifty"). Returns { value, length } (tokens consumed)
 * or null.
 */
function parseNumberWords(tokens, startIdx) {
  let total = 0;
  let current = 0;
  let consumed = 0;
  let sawAnything = false;

  for (let i = startIdx; i < tokens.length; i += 1) {
    const word = tokens[i];
    if (word === "and" && sawAnything) {
      consumed += 1;
      continue;
    }
    if (SMALL_WORDS[word] !== undefined) {
      current += SMALL_WORDS[word];
      consumed += 1;
      sawAnything = true;
      continue;
    }
    if (SCALE_WORDS[word] !== undefined) {
      const scale = SCALE_WORDS[word];
      if (scale >= 1000) {
        total += (current || 1) * scale;
        current = 0;
      } else {
        current = (current || 1) * scale;
      }
      consumed += 1;
      sawAnything = true;
      continue;
    }
    break;
  }
  const value = total + current;
  // Bare small words ("a", "one", "two") are not money.
  if (!sawAnything || value < 20) return null;
  return { value, length: consumed };
}

/** Street-type words that mark the preceding number as an address. */
const STREET_TYPE_TOKENS = new Set([
  "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane",
  "blvd", "boulevard", "ct", "court", "cir", "circle", "way", "pl", "place",
  "ter", "terrace", "hwy", "highway", "pkwy", "parkway", "trl", "trail",
  "unit", "apt", "suite", "ste",
]);

/**
 * Compass directions sit between the street number and the street name
 * ("4157 S Main St"), pushing the street type outside a two-word window.
 */
const DIRECTION_TOKENS = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west",
  "northeast", "northwest", "southeast", "southwest",
]);

/**
 * A street number is never followed by a function word. "300 per unit" and
 * "250 for the unit" are PRICES — but "unit" is a street-type token, so without
 * this the address guard silently deletes real per-unit money.
 */
const NON_STREET_LEAD_TOKENS = new Set([
  "per", "a", "an", "the", "each", "every", "for", "of", "in", "on", "at",
  "to", "and", "or", "with", "por", "de", "del", "la", "el", "los", "las",
  "un", "una", "cada", "y",
]);

/** Up to four following words; an ordinal ("3rd", "42nd") is a street name. */
const ADDRESS_WORD_RE =
  /^\s*([A-Za-zÀ-ÿ']+|\d{1,4}(?:st|nd|rd|th))\.?\s*([A-Za-zÀ-ÿ']+|\d{1,4}(?:st|nd|rd|th))?\.?\s*([A-Za-zÀ-ÿ']+|\d{1,4}(?:st|nd|rd|th))?\.?\s*([A-Za-zÀ-ÿ']+|\d{1,4}(?:st|nd|rd|th))?/i;

/**
 * True when a bare number is positioned like a street number: immediately
 * followed by a street type ("4157 Pillsbury Ave"), by a compass direction and
 * then a street type ("4157 S Main St"), or by a capitalized proper noun
 * ("327 Pennsylvania"). Deliberately conservative — it only ever fires for
 * numbers carrying no monetary evidence at all.
 */
function isAddressAdjacent(text, match) {
  const after = text.slice(match.index + match[0].length);
  const next = ADDRESS_WORD_RE.exec(after);
  if (!next) return false;
  const all = [next[1], next[2], next[3], next[4]].filter(Boolean).map(String);
  if (!all.length) return false;
  // "300 per unit" is money, not 300 Unit Street.
  if (NON_STREET_LEAD_TOKENS.has(all[0].toLowerCase())) return false;
  // Skip exactly one leading compass direction, then look one word further —
  // the direction is itself strong address evidence. Every other message keeps
  // the original two-word window.
  const words =
    all.length > 1 && DIRECTION_TOKENS.has(all[0].toLowerCase())
      ? all.slice(1, 4)
      : all.slice(0, 2);
  if (words.some((word) => STREET_TYPE_TOKENS.has(word.toLowerCase()))) return true;
  const first = String(words[0] || "");
  // "327 Pennsylvania" — a capitalized word that is not a scale/quantity term.
  // This branch has no evidence beyond capitalization, so it must yield to any
  // monetary reading: "I want 300 Cash" and "I need 300 Net" are prices.
  if (!/^[A-ZÀ-Ý][a-zà-ÿ]{2,}$/.test(first)) return false;
  if (SCALE_WORDS[first.toLowerCase()]) return false;
  if (MONETARY_QUALIFIER_WORDS.has(first.toLowerCase())) return false;
  return true;
}

// ─── postal codes and calendar years are not money ──────────────────────────
// Both are suppressed ONLY on a textual cue. "55407" and a $55,407 asking price
// are structurally identical, as are "1998" and $1,998 — a rule based on digit
// count alone would silently eat real seller money, so the cue does the work.

/** US state abbreviations that are never ordinary English words. */
const UNAMBIGUOUS_STATE_ABBREVIATIONS = new Set([
  "ak", "az", "ar", "ca", "ct", "dc", "fl", "ga", "il", "ia", "ks", "ky", "md",
  "mi", "mn", "ms", "mo", "mt", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "ri",
  "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
]);

const ZIP_CUE_RE =
  /(?:^|[^a-z0-9])(?:zip|zipcode|postal|postcode|codigo postal|código postal)\s*(?:code)?\s*(?:is|are|=|:|es)?\s*$/i;
/** "Minneapolis, MN 55407" — a comma makes any state abbreviation safe. */
const COMMA_STATE_RE = /,\s*[A-Za-z]{2}\.?\s*$/;
/** "Minneapolis MN 55407" — no comma, so require an UPPERCASE unambiguous state. */
const BARE_STATE_RE = /(?:^|[^A-Za-z])([A-Z]{2})\.?\s*$/;

/**
 * True when a bare 5-digit number is cued as a postal code. Deliberately does
 * NOT treat a bare preposition as a cue: "I'm interested in 95000" and "would
 * be interested in 95k" are price statements, so "in 55407" stays money.
 */
function isPostalCode(text, match, digits) {
  if (!/^\d{5}$/.test(String(digits))) return false;
  const before = text.slice(0, match.index);
  if (ZIP_CUE_RE.test(before)) return true;
  if (COMMA_STATE_RE.test(before)) return true;
  const bare = BARE_STATE_RE.exec(before);
  return Boolean(bare && UNAMBIGUOUS_STATE_ABBREVIATIONS.has(bare[1].toLowerCase()));
}

const YEAR_DIRECT_CUE_RE =
  /(?:^|[^a-z0-9])(?:since|circa|est|established|year|built|build|rebuilt|bought|purchased|acquired|remodeled|renovated|rehabbed|updated|replaced|constructed|inherited|desde)\.?\s*(?:in|of|en)?\s*$/i;
/** A preposition alone is not a year cue — it needs a temporal subject nearby. */
const YEAR_PREP_RE = /(?:^|[^a-z0-9])(?:in|of|en|de|del)\s*$/i;
const YEAR_SUBJECT_RE =
  /(?:built|build|rebuilt|bought|buy|purchas|acquir|remodel|renovat|rehab|updat|replac|redone|construct|inherit|moved|lived|owned|roof)/i;

/**
 * True when a bare 4-digit number is cued as a calendar year ("built in 1987",
 * "since 1998"). The 1900-2099 bound is only a precondition; the cue decides.
 * A bare preposition is NOT sufficient on its own — "I put in 2000 for repairs"
 * is a real repair figure and must survive.
 */
function isCalendarYear(text, match, digits, value) {
  if (!/^\d{4}$/.test(String(digits))) return false;
  if (!(value >= 1900 && value <= 2099)) return false;
  const before = text.slice(0, match.index);
  if (YEAR_DIRECT_CUE_RE.test(before)) return true;
  return YEAR_PREP_RE.test(before) && YEAR_SUBJECT_RE.test(before.slice(-40));
}

/** Extract every numeric token (digits or words) with its position + suffix scale. */
function tokenizeAmounts(text) {
  const amounts = [];

  // Digit-based: $100,000 / 100k / 95.5k / 1.2m / 80 / $500.000 (dot-thousands)
  const numRe = /\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+(?!\d)|\d+(?:\.\d+)?)\s*(k|m|mil|grand|thousand|million|hundred)?\b/gi;
  let match;
  while ((match = numRe.exec(text)) !== null) {
    const dotThousands = /^\d{1,3}(?:\.\d{3})+$/.test(match[1]) && !match[1].includes(",");
    const rawNumber = dotThousands ? match[1].replace(/\./g, "") : match[1].replace(/,/g, "");
    let value = parseFloat(rawNumber);
    if (!Number.isFinite(value)) continue;
    const suffix = lower(match[2] || "");
    const hasCurrency = match[0].includes("$");
    const hadThousandsSeparator = match[1].includes(",") || dotThousands;

    const after = text.slice(match.index + match[0].length);
    const trailing = /^\s*([a-zà-ÿ']+)/i.exec(after);
    const trailingWord = trailing ? trailing[1].toLowerCase() : "";
    if (!suffix && (TIME_UNIT_TOKENS.has(trailingWord) || AREA_UNIT_TOKENS.has(trailingWord))) continue;
    // A street number is not money. "For 327 Pennsylvania alone 130,000" and
    // "(331 Pennsylvania)" both put a bare 3-digit number immediately before a
    // street name; production read 331 as the asking price for a $130,000
    // property. A number with no currency symbol, no thousands separator and no
    // scale suffix that is directly followed by a capitalized word or a street
    // type is an address, not a price.
    if (!suffix && !hasCurrency && !hadThousandsSeparator && isAddressAdjacent(text, match)) {
      continue;
    }
    // A postal code ("zip is 55407", "Minneapolis, MN 55407") and a calendar
    // year ("built in 1987") are not money either.
    if (!suffix && !hasCurrency && !hadThousandsSeparator) {
      if (isPostalCode(text, match, match[1])) continue;
      if (isCalendarYear(text, match, match[1], value)) continue;
    }
    // Percentages are not monetary values.
    if (/^\s*%/.test(after) || /percent/i.test(trailingWord)) continue;

    if (suffix && SCALE_WORDS[suffix]) value *= SCALE_WORDS[suffix];

    amounts.push({
      value: Math.round(value),
      raw: clean(match[0]) + (suffix && !match[0].toLowerCase().includes(suffix) ? ` ${suffix}` : ""),
      index: match.index,
      end: match.index + match[0].length,
      has_currency: hasCurrency,
      has_scale: Boolean(suffix) || hadThousandsSeparator || value >= 1000,
      from_words: false,
    });
  }

  // Word-based: "one hundred thousand", "half a million". A spelled-out
  // amount must START with a quantity word — a stray scale token ("k" left
  // over from "100k", "grand" in prose) is never a number by itself.
  const tokens = lower(text).split(/[^a-zà-ÿ']+/);
  const wordRe = /[a-zà-ÿ']+/g;
  const positions = [];
  let wordMatch;
  while ((wordMatch = wordRe.exec(lower(text))) !== null) positions.push(wordMatch.index);

  for (let i = 0; i < tokens.length; i += 1) {
    if (SMALL_WORDS[tokens[i]] === undefined) continue;
    const parsed = parseNumberWords(tokens, i);
    if (parsed && parsed.value >= 1000) {
      const index = positions[i] ?? 0;
      amounts.push({
        value: Math.round(parsed.value),
        raw: tokens.slice(i, i + parsed.length).join(" "),
        index,
        end: index + tokens.slice(i, i + parsed.length).join(" ").length,
        has_currency: false,
        has_scale: true,
        from_words: true,
      });
      i += parsed.length - 1;
    }
  }

  return amounts.sort((a, b) => a.index - b.index);
}

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

const KIND_CUES = Object.freeze([
  // Most specific first; a window is the ±60 chars of text around the amount.
  { kind: MONETARY_KINDS.MORTGAGE_PAYOFF, cues: ["owe", "payoff", "pay off", "mortgage balance", "balance on the mortgage", "loan balance", "left on the mortgage", "left on the loan", "still owe", "debo"] },
  // "/month" is listed alongside "/mo": the word-boundary matcher will not find
  // "/mo" inside "/month", and a seller's monthly rent misread as an asking
  // price makes a rental look like a $1,450 house.
  { kind: MONETARY_KINDS.MONTHLY_AMOUNT, cues: ["a month", "per month", "monthly", "/mo", "/month", "/mos", "/mth", "each month", "al mes", "mensual"] },
  { kind: MONETARY_KINDS.TAX_AMOUNT, cues: ["taxes", "tax bill", "property tax", "impuestos"] },
  { kind: MONETARY_KINDS.REPAIR_AMOUNT, cues: ["repair", "repairs", "fix", "roof cost", "quote for", "estimate for", "to fix", "in work", "reparar", "arreglar"] },
  { kind: MONETARY_KINDS.EARNEST_MONEY, cues: ["earnest", "deposit", "down payment", "depósito"] },
  { kind: MONETARY_KINDS.PER_UNIT_PRICE, cues: ["per unit", "a unit", "each unit", "per door", "a door", "por unidad"] },
  { kind: MONETARY_KINDS.PACKAGE_PRICE, cues: ["for both", "for all", "the pair", "package", "portfolio", "together", "for the two", "for the three", "por los dos", "por todas"] },
  { kind: MONETARY_KINDS.CLOSING_COST_TERM, cues: ["you pay closing", "pay the closing", "cover closing", "closing costs", "plus closing", "gastos de cierre"] },
  { kind: MONETARY_KINDS.NET_REQUIREMENT, cues: ["net", "walk away with", "in my pocket", "clear", "after everything", "neto"] },
  { kind: MONETARY_KINDS.MINIMUM_PRICE, cues: ["at least", "no less than", "minimum", "won't take less", "wont take less", "not a penny less", "bottom dollar", "lowest i", "por lo menos", "mínimo", "minimo"] },
]);

const ASK_CUES = ["want", "asking", "ask", "take", "sell for", "let it go", "looking for", "need", "give me", "i'd do", "id do", "price is", "worth", "quiero", "pido", "lo doy en", "how about", "what about", "meet me at"];
const FIRM_CUES = ["firm", "non negotiable", "non-negotiable", "not negotiable", "take it or leave it", "won't budge", "wont budge", "precio firme", "no negociable", "best and final"];
const APPROX_CUES = ["around", "about", "roughly", "approximately", "somewhere", "ish", "close to", "más o menos", "mas o menos", "como"];

// ─── monetary vocabulary reused by the address guard ────────────────────────
// The proper-noun branch of isAddressAdjacent fires on ANY capitalized word, so
// "I want 300 Cash" and "I need 300 Net" read as addresses and the seller's
// number was deleted outright. This narrows that branch by vocabulary, DERIVED
// from the cue tables above rather than duplicated — a second hand-maintained
// list would drift out of sync with the classifier.
//
// Vocabulary, deliberately, and NOT "a monetary cue sits before the number":
// an address follows those cues too, so that rule re-opened the original
// incident — "how about 331 Pennsylvania" read the neighbouring property's
// street number as a price again. Measured, then rejected.
//
// Declared after the cue tables and referenced from the hoisted
// isAddressAdjacent, which only ever runs after module initialization.

/** Single capitalized words that are monetary vocabulary, never street names. */
const MONETARY_QUALIFIER_WORDS = (() => {
  const words = new Set([
    // qualifier vocabulary that is not itself a classification cue
    "cash", "obo", "total", "down", "flat", "plus", "even", "dollars", "bucks",
    "negotiable", "only", "max", "min", "tops", "today", "best", "apiece",
    "otd", "usd", "each", "firm",
  ]);
  const add = (cue) => {
    const token = String(cue).trim().toLowerCase();
    if (token && !/[^a-zà-ÿ']/.test(token)) words.add(token);
  };
  for (const entry of KIND_CUES) entry.cues.forEach(add);
  ASK_CUES.forEach(add);
  FIRM_CUES.forEach(add);
  APPROX_CUES.forEach(add);
  return words;
})();

function windowFor(text, amount, radius = 60) {
  const start = Math.max(0, amount.index - radius);
  const end = Math.min(text.length, amount.end + radius);
  return lower(text.slice(start, end));
}

function precedingWindow(text, amount, radius = 40) {
  const start = Math.max(0, amount.index - radius);
  return lower(text.slice(start, amount.index));
}

/**
 * True when `cue` occurs at `idx` as a whole word/phrase rather than inside a
 * longer word.
 *
 * Substring matching silently reclassified real prices: "however" contains
 * "owe", so "130,000...however" bound the asking price to the MORTGAGE_PAYOFF
 * cue and the amount was discarded — the seller's $130,000 vanished. The same
 * trap sits in "net" (cabinet, network), "clear" (clearly) and "fix" (fixture).
 *
 * A strict right boundary then went too far the other way: it also stopped
 * matching ordinary INFLECTIONS, so "I owed 60,000 on it" stopped being a
 * payoff and "I fixed it for 15,000" stopped being a repair — both silently
 * became asking prices. Regular verb/noun endings are therefore still part of
 * the cue. "ly" and "er" are deliberately NOT included: they are exactly what
 * make "clearly" and "fixer" the traps the boundary rule exists to close.
 */
const CUE_INFLECTION_SUFFIX = "(?:s|es|d|ed|ing)?";

const CUE_BOUNDARY_CACHE = new Map();

/** Boundary-aware matcher per cue, compiled once. */
function cueBoundaryRegex(cue) {
  let re = CUE_BOUNDARY_CACHE.get(cue);
  if (!re) {
    const escaped = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const left = /[a-z0-9\u00e0-\u00ff]/i.test(cue[0]) ? "(?<![a-z0-9\u00e0-\u00ff])" : "";
    const right = /[a-z0-9\u00e0-\u00ff]/i.test(cue[cue.length - 1])
      ? `${CUE_INFLECTION_SUFFIX}(?![a-z0-9\u00e0-\u00ff])`
      : "";
    re = new RegExp(`${left}${escaped}${right}`, "gi");
    CUE_BOUNDARY_CACHE.set(cue, re);
  }
  re.lastIndex = 0;
  return re;
}

function cueAtWordBoundary(text, cue, idx) {
  const before = idx === 0 ? "" : text[idx - 1];
  const afterIdx = idx + cue.length;
  const after = afterIdx >= text.length ? "" : text[afterIdx];
  const isWordChar = (ch) => ch !== "" && /[a-z0-9\u00e0-\u00ff]/i.test(ch);
  const startsWord = /[a-z0-9\u00e0-\u00ff]/i.test(cue[0]);
  const endsWord = /[a-z0-9\u00e0-\u00ff]/i.test(cue[cue.length - 1]);
  if (startsWord && isWordChar(before)) return false;
  if (endsWord && isWordChar(after)) return false;
  return true;
}

function includesCue(window, cues) {
  return cues.some((cue) => cueBoundaryRegex(cue).test(window));
}

/**
 * Classify one amount by the NEAREST semantic cue. Two amounts in one message
 * ("I owe $60k but I want $110k") must each bind to their own cue — a single
 * shared window would smear the first cue across both numbers.
 */
function classifyByNearestCue(text, amount, { negotiationActive = false } = {}) {
  const lowerText = lower(text);
  const radius = 60;
  const windowStart = Math.max(0, amount.index - radius);
  const windowEnd = Math.min(lowerText.length, amount.end + radius);
  const window = lowerText.slice(windowStart, windowEnd);

  let best = { kind: MONETARY_KINDS.UNKNOWN, dist: Infinity };
  const consider = (kind, cue) => {
    const re = cueBoundaryRegex(cue);
    let m;
    while ((m = re.exec(window)) !== null) {
      const cueMid = windowStart + m.index + cue.length / 2;
      const dist = Math.min(Math.abs(cueMid - amount.index), Math.abs(cueMid - amount.end));
      if (dist < best.dist) best = { kind, dist };
    }
  };

  for (const entry of KIND_CUES) {
    for (const cue of entry.cues) consider(entry.kind, cue);
  }
  const askKind = negotiationActive ? MONETARY_KINDS.COUNTER_OFFER : MONETARY_KINDS.ASKING_PRICE;
  for (const cue of ASK_CUES) consider(askKind, cue);

  return best.kind;
}

/**
 * Extract and semantically classify every monetary mention in a message.
 *
 * @param {string} message
 * @param {object} [options]
 * @param {number} [options.reference] - A known price scale for this deal
 *        (current ask, latest offer, or valuation) used to interpret bare
 *        negotiation shorthand ("160" → $160k) — never to invent a price.
 * @param {boolean} [options.negotiationActive] - True at S5+: bare plausible
 *        numbers lean counter_offer instead of asking_price.
 * @returns {Array<object>} mentions
 */
export function extractMonetaryMentions(message, { reference = null, negotiationActive = false } = {}) {
  const text = clean(message);
  if (!text) return [];

  const ref = num(reference);
  const mentions = [];

  for (const amount of tokenizeAmounts(text)) {
    let value = amount.value;
    let confidence = amount.has_currency || amount.has_scale ? 0.9 : 0.5;
    const window = windowFor(text, amount);
    const before = precedingWindow(text, amount);

    // Bare small number ("160", "around 100"): thousands shorthand only when a
    // same-magnitude reference exists; otherwise it stays low-confidence.
    let scaled_from_reference = false;
    if (!amount.has_currency && !amount.has_scale && value >= 20 && value < 1000) {
      if (ref !== null && ref >= 20_000) {
        value *= 1000;
        confidence = 0.65;
        scaled_from_reference = true;
      } else {
        confidence = 0.3;
      }
    }

    // Implausible as any transaction amount.
    if (value < 1000 && !scaled_from_reference) {
      if (value < 100) continue;
      confidence = Math.min(confidence, 0.3);
    }

    let kind = classifyByNearestCue(text, amount, { negotiationActive });
    const boundToAskCue =
      kind === MONETARY_KINDS.ASKING_PRICE || kind === MONETARY_KINDS.COUNTER_OFFER;

    const qualifiers = {
      firm: includesCue(window, FIRM_CUES),
      approximate: includesCue(before, APPROX_CUES),
      net: kind === MONETARY_KINDS.NET_REQUIREMENT,
      minimum: kind === MONETARY_KINDS.MINIMUM_PRICE,
      per_unit: kind === MONETARY_KINDS.PER_UNIT_PRICE,
      package: kind === MONETARY_KINDS.PACKAGE_PRICE,
      contingent_on_closing_costs: kind === MONETARY_KINDS.CLOSING_COST_TERM,
    };

    if (kind === MONETARY_KINDS.UNKNOWN) {
      // No semantic cue at all: currency/scale marks it a price statement;
      // a bare plausible number stays low-confidence so the caller clarifies
      // instead of guessing (spec §3).
      if (amount.has_currency || amount.has_scale || scaled_from_reference) {
        kind = negotiationActive ? MONETARY_KINDS.COUNTER_OFFER : MONETARY_KINDS.ASKING_PRICE;
        confidence = Math.min(confidence, scaled_from_reference ? confidence : 0.75);
      } else if (value >= 1000 || (value >= 20 && value < 1000)) {
        kind = negotiationActive ? MONETARY_KINDS.COUNTER_OFFER : MONETARY_KINDS.ASKING_PRICE;
        confidence = Math.min(confidence, 0.3);
      }
    } else if (
      boundToAskCue
    ) {
      // Ask-cue-bound amounts keep their tokenizer confidence.
    } else if (
      kind === MONETARY_KINDS.MINIMUM_PRICE ||
      kind === MONETARY_KINDS.NET_REQUIREMENT ||
      kind === MONETARY_KINDS.PER_UNIT_PRICE ||
      kind === MONETARY_KINDS.PACKAGE_PRICE ||
      kind === MONETARY_KINDS.CLOSING_COST_TERM
    ) {
      // These are all price-type statements — they set/refine the ask.
      confidence = Math.max(confidence, 0.7);
    }

    if (qualifiers.approximate) confidence = Math.min(confidence, 0.75);

    mentions.push({
      kind,
      value: Math.round(value),
      raw: amount.raw,
      confidence: Math.round(confidence * 100) / 100,
      qualifiers,
      scaled_from_reference,
    });
  }

  // Ranges: two adjacent price-kind mentions joined by "to" / "-" / "between".
  for (let i = 0; i < mentions.length - 1; i += 1) {
    const a = mentions[i];
    const b = mentions[i + 1];
    const isPriceKind = (m) =>
      m.kind === MONETARY_KINDS.ASKING_PRICE || m.kind === MONETARY_KINDS.COUNTER_OFFER || m.kind === MONETARY_KINDS.UNKNOWN;
    if (!isPriceKind(a) || !isPriceKind(b)) continue;
    const betweenText = lower(text).slice(
      lower(text).indexOf(lower(a.raw)) + a.raw.length,
      lower(text).lastIndexOf(lower(b.raw))
    );
    if (/^\s*(to|-|–|and|or)\s*$/.test(betweenText) || /between/.test(precedingWindow(text, { index: text.toLowerCase().indexOf(a.raw.toLowerCase()), end: 0 }, 20))) {
      a.qualifiers.range = true;
      a.range = { low: Math.min(a.value, b.value), high: Math.max(a.value, b.value) };
      a.value = a.range.low; // negotiate from the seller's low end
      mentions.splice(i + 1, 1);
    }
  }

  return mentions;
}

// ═══════════════════════════════════════════════════════════════════════════
// ASKING-PRICE SIGNAL RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

const PRICE_SETTING_KINDS = new Set([
  MONETARY_KINDS.ASKING_PRICE,
  MONETARY_KINDS.COUNTER_OFFER,
  MONETARY_KINDS.MINIMUM_PRICE,
  MONETARY_KINDS.NET_REQUIREMENT,
  MONETARY_KINDS.PER_UNIT_PRICE,
  MONETARY_KINDS.PACKAGE_PRICE,
  MONETARY_KINDS.CLOSING_COST_TERM,
]);

/**
 * Resolve the single price signal (if any) a message contributes to the
 * negotiation, plus everything else the numbers said. Low-confidence or
 * conflicting price statements return needs_clarification=true and NO price —
 * clarification is asked instead of driving an offer (spec §3).
 */
export function resolveAskingPriceSignal(message, {
  reference = null,
  negotiationActive = false,
  sourceMessageId = null,
  now = null,
} = {}) {
  const mentions = extractMonetaryMentions(message, { reference, negotiationActive });
  const priceMentions = mentions.filter((m) => PRICE_SETTING_KINDS.has(m.kind));
  const informational = mentions.filter((m) => !PRICE_SETTING_KINDS.has(m.kind));

  if (!priceMentions.length) {
    return {
      asking_price: null,
      is_counter: false,
      needs_clarification: false,
      clarification_reason: null,
      informational_mentions: informational,
      all_mentions: mentions,
    };
  }

  const confident = priceMentions.filter((m) => m.confidence >= 0.5);
  if (!confident.length) {
    return {
      asking_price: null,
      is_counter: false,
      needs_clarification: true,
      clarification_reason: "low_confidence_monetary_extraction",
      informational_mentions: informational,
      all_mentions: mentions,
    };
  }

  // Multiple confident, materially different price statements → clarify.
  const distinct = [...new Set(confident.map((m) => m.value))];
  if (distinct.length > 1 && Math.max(...distinct) / Math.min(...distinct) > 1.1 && !confident[0].qualifiers.range) {
    return {
      asking_price: null,
      is_counter: false,
      needs_clarification: true,
      clarification_reason: "conflicting_price_statements",
      informational_mentions: informational,
      all_mentions: mentions,
    };
  }

  const best = confident.sort((a, b) => b.confidence - a.confidence)[0];
  const price_type = best.qualifiers.range
    ? "range"
    : best.qualifiers.minimum
      ? "minimum"
      : best.qualifiers.net
        ? "net"
        : best.qualifiers.per_unit
          ? "per_unit"
          : best.qualifiers.package
            ? "package"
            : best.qualifiers.approximate
              ? "approximate"
              : "exact";

  return {
    asking_price: {
      value: best.value,
      currency: "USD",
      price_type,
      confidence: best.confidence,
      extracted_text: best.raw,
      qualifiers: best.qualifiers,
      ...(best.range ? { range: best.range } : {}),
      source_message_id: sourceMessageId || null,
      captured_at: now || new Date().toISOString(),
    },
    is_counter: best.kind === MONETARY_KINDS.COUNTER_OFFER || (negotiationActive && PRICE_SETTING_KINDS.has(best.kind)),
    needs_clarification: false,
    clarification_reason: null,
    informational_mentions: informational,
    all_mentions: mentions,
  };
}

export default {
  MONETARY_KINDS,
  extractMonetaryMentions,
  resolveAskingPriceSignal,
};
