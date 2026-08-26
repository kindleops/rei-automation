// ─── extract-address-signals.js ──────────────────────────────────────────────
// Deterministic street-address candidate extraction from inbound SMS text.
//
// Two consumers, one truth:
//   1. parseSellerAskingPrice / seller_state price extraction use the HIGH
//      confidence spans to refuse address street numbers as monetary values
//      ("123 Main is not for sale" must never become a $123M asking price).
//   2. The inbound decision layer uses the candidates to preserve the
//      second clause of compound messages ("that house isn't for sale, but I
//      might sell 123 Oak Street") instead of letting the first negative
//      intent terminate analysis of a new-property signal.
//
// HIGH confidence requires a street suffix (St/Ave/Dr/...). LOW confidence
// accepts a bare "<number> <word>" pair only when the message carries a
// transactional cue (sell/own/offer/...), and is only ever routed to human
// review — never to an automated mutation.

const STREET_SUFFIXES = [
  "street", "st", "avenue", "ave", "av", "road", "rd", "drive", "dr",
  "lane", "ln", "court", "ct", "boulevard", "blvd", "way", "place", "pl",
  "circle", "cir", "terrace", "ter", "trail", "trl", "highway", "hwy",
  "parkway", "pkwy", "loop", "plaza", "plz", "bend", "cove", "point", "pt",
  "run", "pass", "crossing", "xing", "square", "sq",
];

// Words that immediately follow a number in common non-address SMS shapes.
// A "<number> <unit>" pair must never become a low-confidence address.
const NON_STREET_UNIT_WORDS = new Set([
  "am", "pm", "yr", "yrs", "year", "years", "day", "days", "week", "weeks",
  "month", "months", "minute", "minutes", "min", "mins", "hour", "hours",
  "acre", "acres", "bed", "beds", "bedroom", "bedrooms", "bath", "baths",
  "bathroom", "bathrooms", "unit", "units", "tenant", "tenants", "kid",
  "kids", "people", "percent", "dollar", "dollars", "buck", "bucks",
  "grand", "k", "thousand", "mil", "million", "hundred", "sqft", "sq",
  "story", "stories", "floor", "floors", "car", "cars", "time", "times",
]);

const TRANSACTIONAL_CUES = [
  "sell", "selling", "sale", "sold", "own", "owns", "owned", "buy",
  "buying", "offer", "property", "house", "home", "interested", "pay",
  "vender", "vendo", "casa", "propiedad",
];

const SUFFIX_ALTERNATION = STREET_SUFFIXES.join("|");

// "<number> <up to three street-name words> <suffix>" with optional trailing
// city/state/zip tail. The street number must not carry a money marker.
const HIGH_CONFIDENCE_ADDRESS_RE = new RegExp(
  String.raw`(?<!\$)\b(\d{1,6})\s+((?:[a-z][a-z0-9'.-]*\s+){0,3}?[a-z][a-z0-9'.-]*)\s+(${SUFFIX_ALTERNATION})\b\.?` +
    String.raw`(?:\s*,?\s*([a-z][a-z .'-]{2,30}?)\s*,?\s+([a-z]{2})\s+(\d{5})(?:-\d{4})?)?`,
  "gi"
);

const LOW_CONFIDENCE_PAIR_RE = /(?<!\$)\b(\d{2,5})\s+([a-z][a-z'.-]{2,})\b/gi;

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function hasTransactionalCue(text) {
  const normalized = lower(text);
  return TRANSACTIONAL_CUES.some((cue) => normalized.includes(cue));
}

/**
 * Extract street-address candidates from a message.
 * Returns [{ address_text, street_number, street_name, street_suffix,
 *            city, state, zip, confidence: "high"|"low",
 *            evidence: { text, index }, span: [start, end] }]
 * High-confidence (suffix-bearing) candidates come first.
 */
export function extractAddressCandidates(message) {
  const text = String(message ?? "");
  if (!text.trim()) return [];

  const candidates = [];
  const claimed = [];

  HIGH_CONFIDENCE_ADDRESS_RE.lastIndex = 0;
  let match;
  while ((match = HIGH_CONFIDENCE_ADDRESS_RE.exec(text)) !== null) {
    const [full, streetNumber, streetName, suffix, city, state, zip] = match;
    const start = match.index;
    const end = start + full.length;
    candidates.push({
      address_text: full.trim().replace(/\s+/g, " "),
      street_number: streetNumber,
      street_name: streetName.trim().replace(/\s+/g, " "),
      street_suffix: suffix.toLowerCase(),
      city: city ? city.trim() : null,
      state: state ? state.toUpperCase() : null,
      zip: zip || null,
      confidence: "high",
      evidence: { text: full.trim(), index: start },
      span: [start, end],
    });
    claimed.push([start, end]);
  }

  if (hasTransactionalCue(text)) {
    LOW_CONFIDENCE_PAIR_RE.lastIndex = 0;
    while ((match = LOW_CONFIDENCE_PAIR_RE.exec(text)) !== null) {
      const [full, streetNumber, word] = match;
      const start = match.index;
      const end = start + full.length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      const nextWord = lower(word);
      if (NON_STREET_UNIT_WORDS.has(nextWord)) continue;
      if (TRANSACTIONAL_CUES.includes(nextWord)) continue;
      // A pure time/scale token after the number disqualifies the pair.
      const after = text.slice(end, end + 4);
      if (/^\s*(?:am|pm)\b/i.test(after)) continue;
      candidates.push({
        address_text: full.trim(),
        street_number: streetNumber,
        street_name: word,
        street_suffix: null,
        city: null,
        state: null,
        zip: null,
        confidence: "low",
        evidence: { text: full.trim(), index: start },
        span: [start, end],
      });
    }
  }

  return candidates;
}

/**
 * HIGH-confidence address spans only — the price parser uses these to refuse
 * street numbers as monetary values. Low-confidence pairs are deliberately
 * excluded so a real bare price ("want 150 for it") can never be swallowed
 * by an over-eager address guess.
 */
export function findHighConfidenceAddressSpans(message) {
  return extractAddressCandidates(message)
    .filter((candidate) => candidate.confidence === "high")
    .map((candidate) => candidate.span);
}

/** True when a numeric token at `index` sits inside a high-confidence address. */
export function isIndexInsideAddressSpan(spans, index) {
  return spans.some(([start, end]) => index >= start && index < end);
}
