// ─── price-plausibility.js ───────────────────────────────────────────────────
// A stated price far above any realistic value is not an asking price.
//
// Live 2026-10-06 (+17276319579, 12051 Willow Trl, Houston, estimated value
// $182,000): "1 million dollars" -> asking_price_provided -> S1->S4 advance
// (ownership inferred from a price) -> condition probe. "Great. 1 million
// dollars" -> the same probe -> duplicate_blocked -> silence.
//
// Rules (any one is enough; the evidence is returned for the audit trail):
//   ratio_to_estimate   ask > 2.5 x max(estimated_value, arv_estimate)
//   ratio_to_max_comp   ask > 2 x the highest comp, when comps are known
//   round_joke          a round 1M / 2M / 5M / 10M / 100M / 1B ask (or the
//                       words million / billion / trillion / zillion) on a
//                       property valued under $400K
//   absurd_word         "billion", "trillion", "zillion", "gazillion" with no
//                       valuation at all
// With no valuation and no absurd word, nothing is implausible: we never guess.

export const PRICE_PLAUSIBILITY_VERSION = "price_plausibility_v1";

const ESTIMATE_RATIO = 2.5;
const COMP_RATIO = 2;
const JOKE_PROPERTY_CEILING = 400000;
const ROUND_JOKES = new Set([1e6, 2e6, 3e6, 5e6, 1e7, 2e7, 5e7, 1e8, 1e9, 1e10, 1e12]);
const MILLION_WORD_RE = /\b(?:million|millions|millon|millones|mil millones|billion|billions|trillion|trillions|zillion|gazillion|bajillion|kajillion)\b/i;
const ABSURD_WORD_RE = /\b(?:billion|billions|trillion|trillions|zillion|gazillion|bajillion|kajillion|mil millones)\b/i;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object} args
 * @param {number} args.amount              the parsed ask, in dollars
 * @param {object} [args.valuation]         { estimated_value, arv_estimate, max_comp }
 * @param {string} [args.message]           the seller's text (for the word rules)
 * @returns {{ implausible: boolean, rule: string|null, ask: number|null, reference: number|null,
 *             estimated_value: number|null, arv_estimate: number|null, max_comp: number|null,
 *             ratio: number|null, version: string }}
 */
export function assessAskingPricePlausibility({ amount = null, valuation = null, message = "" } = {}) {
  const ask = num(amount);
  const estimated_value = num(valuation?.estimated_value);
  const arv_estimate = num(valuation?.arv_estimate);
  const max_comp = num(valuation?.max_comp);
  const reference = Math.max(estimated_value || 0, arv_estimate || 0) || null;
  const ratio = ask && reference ? Math.round((ask / reference) * 100) / 100 : null;
  const base = {
    implausible: false,
    rule: null,
    ask,
    reference,
    estimated_value,
    arv_estimate,
    max_comp,
    ratio,
    version: PRICE_PLAUSIBILITY_VERSION,
  };
  if (!ask) return base;
  const text = String(message ?? "");

  if (reference && ask > ESTIMATE_RATIO * reference) {
    return { ...base, implausible: true, rule: "ratio_to_estimate" };
  }
  if (max_comp && ask > COMP_RATIO * max_comp) {
    return { ...base, implausible: true, rule: "ratio_to_max_comp" };
  }
  if (
    reference &&
    reference < JOKE_PROPERTY_CEILING &&
    ask >= 1e6 &&
    (ROUND_JOKES.has(ask) || MILLION_WORD_RE.test(text))
  ) {
    return { ...base, implausible: true, rule: "round_joke" };
  }
  if (!reference && ABSURD_WORD_RE.test(text)) {
    return { ...base, implausible: true, rule: "absurd_word" };
  }
  return base;
}

export default assessAskingPricePlausibility;
