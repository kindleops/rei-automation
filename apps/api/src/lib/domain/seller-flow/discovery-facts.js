/**
 * ACQUISITION FLOW V2 — DISCOVERY FACTS.
 *
 * The dimensions S3A/S3B/S3C need that `extract-seller-facts.js` did not
 * capture: tenancy terms, per-unit occupancy, unit mix, rent-disclosure
 * posture, and — most importantly — the separation of PROJECTED rent from
 * CURRENT rent.
 *
 * WHY PROJECTED RENT IS THE LOAD-BEARING ONE. A seller saying "these should
 * rent for $1,800" is making a claim about a world that does not exist yet.
 * Before this module those words produced a `reported_unit_rents` entry
 * indistinguishable from money actually being collected, so a speculative
 * number could reach NOI and therefore the offer. The acquisition decision is
 * made on CURRENT operations; upside may inform strategy but may never
 * fabricate income. Projected figures are captured — they are useful — but in
 * their own keys, and they never join the current-rent set.
 *
 * WHY THIS IS A SEPARATE MODULE. extract-seller-facts.js is in the money path
 * and already long. These are new, independently-testable dimensions with no
 * behavioural coupling to the existing extractors, so they compose rather than
 * enlarge it. Nothing here writes; it returns facts for the caller to persist.
 *
 * DESIGN CONSTRAINT. Recognition is cue-driven over a finite ontology, not a
 * growing list of literal sentences. Each dimension has a small set of
 * semantic cues and a structural reading; new phrasings should extend a cue
 * set, never add a branch.
 */

function clean(value) {
  return String(value ?? "").trim();
}

/** Canonical tenancy vocabulary. */
export const TENANCY_TYPES = Object.freeze({
  MONTH_TO_MONTH: "month_to_month",
  FIXED_TERM: "fixed_term",
  MIXED: "mixed",
  UNKNOWN: "unknown",
});

export const RENT_DISCLOSURE = Object.freeze({
  DISCLOSED: "disclosed",
  REFUSED: "refused",
  UNKNOWN: "unknown",
});

const MTM_CUES = [
  /\bmonth\s*(?:-|–|\s)?\s*to\s*(?:-|–|\s)?\s*month\b/i,
  /\bm2m\b/i,
  /\bmtm\b/i,
  /\bmes\s+a\s+mes\b/i,
  /\bno\s+lease\b/i,
  /\bwithout\s+a\s+lease\b/i,
];

const FIXED_TERM_CUES = [
  /\blease\s+(?:is\s+)?(?:up|ends?|expires?|expiring|through|until|till)\b/i,
  /\bunder\s+(?:a\s+)?lease\b/i,
  /\b(?:one|two|1|2)\s*(?:-|\s)?year\s+lease\b/i,
  /\bfixed\s+term\b/i,
  /\bcontrato\b/i,
  /\bon\s+a\s+lease\b/i,
];

/** Refusal to share operating numbers — posture, not a judgement about them. */
const RENT_REFUSAL_CUES = [
  /\b(?:not|won'?t|wont|will\s+not)\s+(?:going\s+to\s+)?(?:share|give|tell|disclose|provide|send)\b[^.?!]{0,40}\b(?:rent|rents|numbers|figures|income)\b/i,
  /\b(?:rent|rents|numbers|figures|income)\b[^.?!]{0,30}\b(?:are\s+)?(?:none\s+of\s+your|private|confidential)\b/i,
  /\blook\s+it\s+up\b/i,
  /\bnot\s+giving\s+you\s+that\b/i,
  /\bi'?m\s+not\s+sharing\b/i,
];

/**
 * Projection cues. These mark a number as a claim about a FUTURE or MARKET
 * state rather than money currently collected.
 *
 * `should/could/would rent for`, `market rent`, `pro forma`, `after
 * renovation`, `potential`, `you could raise`. Deliberately excludes plain
 * past/present reporting verbs ("rents for", "pays", "is rented at"), which
 * are current-state.
 */
const PROJECTION_CUES = [
  /\b(?:should|could|would|can|will)\s+(?:easily\s+|probably\s+|likely\s+)?(?:rent|go|lease)\s+for\b/i,
  /\b(?:should|could|would)\s+be\s+(?:getting|renting\s+for|worth)\b/i,
  /\bmarket\s+rent(?:s)?\b/i,
  /\bpro\s*-?\s*forma\b/i,
  /\bpotential(?:ly)?\s+(?:rent|income)\b/i,
  /\b(?:raise|bump|increase|push)\s+(?:the\s+)?rents?\b/i,
  /\bafter\s+(?:renovation|rehab|repairs?|updating)\b/i,
  /\bonce\s+(?:renovated|updated|fixed|rehabbed)\b/i,
  /\bcould\s+be\s+renting\b/i,
];

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

/**
 * Does this message contain a forward-looking rent claim?
 *
 * Returns the cue and, when one is adjacent, the projected figure. The figure
 * is reported so underwriting can SEE the seller's claim without ever letting
 * it stand in for collected rent.
 */
export function extractProjectedRent(message = "") {
  const text = clean(message);
  if (!text) return null;

  const cue = firstMatch(text, PROJECTION_CUES);
  if (!cue) return null;

  // Take the first monetary-looking figure that appears within a short window
  // AFTER the projection cue. Anything further away is more likely a separate
  // clause ("...should rent for more. Right now they pay 1200.") and is left
  // to the current-rent extractor.
  const after = text.slice(cue.index, cue.index + 120);
  const amount = /\$?\s*([\d][\d,]{2,6})(?:\s*(k|thousand))?/i.exec(after);

  let value = null;
  if (amount) {
    const raw = Number(String(amount[1]).replace(/,/g, ""));
    if (Number.isFinite(raw)) {
      value = amount[2] ? raw * 1000 : raw;
    }
  }

  return {
    projection_detected: true,
    seller_projected_rent: value,
    projection_cue: clean(cue[0]),
    projection_index: cue.index,
    // Named so no consumer can mistake it for collected income.
    is_current_income: false,
  };
}

/**
 * Tenancy terms. Mixed is a first-class outcome: "one is month to month, the
 * other's lease ends in March" is not month_to_month and not fixed_term, and
 * flattening it to either loses the fact that possession delivery differs per
 * unit.
 */
export function extractTenancy(message = "") {
  const text = clean(message);
  if (!text) return null;

  const mtm = matchesAny(text, MTM_CUES);
  const fixed = matchesAny(text, FIXED_TERM_CUES);
  if (!mtm && !fixed) return null;

  const tenancy_type = mtm && fixed
    ? TENANCY_TYPES.MIXED
    : mtm
      ? TENANCY_TYPES.MONTH_TO_MONTH
      : TENANCY_TYPES.FIXED_TERM;

  const out = { tenancy_type };

  // Lease end, when stated. Month-name and numeric forms only — a bare
  // "expires soon" carries no date and must not become one.
  const monthNamed = /\b(?:lease\s+)?(?:ends?|up|expires?|expiring|through|until|till)\b[^.?!]{0,20}?\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(\d{4}))?/i.exec(text);
  const numeric = /\b(?:ends?|up|expires?|through|until|till)\b[^.?!]{0,15}?\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i.exec(text);

  if (monthNamed) {
    out.lease_end_raw = clean(monthNamed[0]);
    out.lease_end_month = clean(monthNamed[1]).toLowerCase().slice(0, 3);
    if (monthNamed[2]) out.lease_end_year = Number(monthNamed[2]);
  } else if (numeric) {
    out.lease_end_raw = clean(numeric[0]);
    out.lease_end_date_text = clean(numeric[1]);
  }

  return out;
}

/** Rent-disclosure posture. Refusal is a fact; "below market" is not. */
export function extractRentDisclosure(message = "") {
  const text = clean(message);
  if (!text) return null;
  if (!matchesAny(text, RENT_REFUSAL_CUES)) return null;

  return {
    rents_disclosed: false,
    rent_disclosure: RENT_DISCLOSURE.REFUSED,
    // Pinned explicitly. A refusal is the ABSENCE of data; inferring that the
    // withheld rents must be below market converts silence into a seller fact.
    rents_below_market: null,
    requires_independent_research: true,
  };
}

const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
});

function wordOrDigit(token) {
  const t = clean(token).toLowerCase();
  if (!t) return null;
  if (NUMBER_WORDS[t] !== undefined) return NUMBER_WORDS[t];
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Per-unit occupancy. Vacancy rate is DERIVED here and labelled as such —
 * the seller said "7 of 8 occupied", they did not say "12.5% vacancy".
 */
export function extractUnitOccupancy(message = "") {
  const text = clean(message);
  if (!text) return null;

  const total = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:-|\s)?\s*units?\b/i.exec(text);
  const occupied = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:are\s+|is\s+)?(?:currently\s+)?(?:occupied|rented|leased|filled)\b/i.exec(text);
  const vacant = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:are\s+|is\s+)?(?:currently\s+)?(?:vacant|empty|unoccupied)\b/i.exec(text);

  const total_units = total ? wordOrDigit(total[1]) : null;
  const occupied_units = occupied ? wordOrDigit(occupied[1]) : null;
  const vacant_units = vacant ? wordOrDigit(vacant[1]) : null;

  if (total_units === null && occupied_units === null && vacant_units === null) {
    return null;
  }

  const out = {};
  if (total_units !== null) out.total_units_reported = total_units;
  if (occupied_units !== null) out.occupied_units = occupied_units;
  if (vacant_units !== null) out.vacant_units = vacant_units;

  // Complete the third value only when two are known AND consistent. An
  // inconsistent trio is reported as a conflict rather than reconciled.
  const known = [total_units, occupied_units, vacant_units].filter((v) => v !== null).length;
  if (known === 3 && occupied_units + vacant_units !== total_units) {
    out.occupancy_conflict = true;
  } else if (total_units !== null && occupied_units !== null && vacant_units === null) {
    out.vacant_units_derived = total_units - occupied_units;
  } else if (total_units !== null && vacant_units !== null && occupied_units === null) {
    out.occupied_units_derived = total_units - vacant_units;
  }

  const occ = out.occupied_units ?? out.occupied_units_derived ?? null;
  if (total_units && occ !== null && total_units > 0 && !out.occupancy_conflict) {
    out.vacancy_rate_derived = Number(((total_units - occ) / total_units).toFixed(4));
    out.vacancy_rate_is_derived = true;
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Unit mix — "four 2/1s and four 1/1s", "two 2 bed and one 1 bed".
 * Returned as a structured list so a 5-plus underwriting adapter can read it
 * without re-parsing prose.
 */
export function extractUnitMix(message = "") {
  const text = clean(message);
  if (!text) return null;

  const mix = [];
  const slash = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(\d)\s*\/\s*(\d)(?:'|’)?s?\b/gi;
  for (const m of text.matchAll(slash)) {
    const count = wordOrDigit(m[1]);
    if (count === null) continue;
    mix.push({ count, beds: Number(m[2]), baths: Number(m[3]) });
  }

  if (!mix.length) {
    const bedWord = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(\d)\s*(?:-|\s)?\s*(?:bed|bedroom|br)s?\b/gi;
    for (const m of text.matchAll(bedWord)) {
      const count = wordOrDigit(m[1]);
      if (count === null) continue;
      mix.push({ count, beds: Number(m[2]), baths: null });
    }
  }

  if (!mix.length) return null;

  return {
    unit_mix: mix,
    unit_mix_total_units: mix.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/**
 * Compose every V2 discovery dimension for one inbound message.
 *
 * Returns only the dimensions actually present — an empty object means the
 * message carried none of them, which is a legitimate and common outcome.
 */
export function extractDiscoveryFacts(message = "") {
  const text = clean(message);
  const out = {};
  if (!text) return out;

  const projected = extractProjectedRent(text);
  if (projected) out.projected_rent = projected;

  const tenancy = extractTenancy(text);
  if (tenancy) out.tenancy = tenancy;

  const disclosure = extractRentDisclosure(text);
  if (disclosure) out.rent_disclosure = disclosure;

  const occupancy = extractUnitOccupancy(text);
  if (occupancy) out.unit_occupancy = occupancy;

  const mix = extractUnitMix(text);
  if (mix) out.unit_mix = mix;

  return out;
}

export default extractDiscoveryFacts;
