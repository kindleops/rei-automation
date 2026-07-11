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
  { kind: MONETARY_KINDS.MONTHLY_AMOUNT, cues: ["a month", "per month", "monthly", "/mo", "each month", "al mes", "mensual"] },
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

function windowFor(text, amount, radius = 60) {
  const start = Math.max(0, amount.index - radius);
  const end = Math.min(text.length, amount.end + radius);
  return lower(text.slice(start, end));
}

function precedingWindow(text, amount, radius = 40) {
  const start = Math.max(0, amount.index - radius);
  return lower(text.slice(start, amount.index));
}

function includesCue(window, cues) {
  return cues.some((cue) => window.includes(cue));
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
    let idx = window.indexOf(cue);
    while (idx !== -1) {
      const cueMid = windowStart + idx + cue.length / 2;
      const dist = Math.min(Math.abs(cueMid - amount.index), Math.abs(cueMid - amount.end));
      if (dist < best.dist) best = { kind, dist };
      idx = window.indexOf(cue, idx + 1);
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
