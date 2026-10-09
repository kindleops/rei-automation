export const KEYWORD_GROUPS = Object.freeze({
  positive_hot: ["yes", "interested", "maybe", "depends", "i own it", "make offer"],
  offer_requested: ["how much", "offer", "price", "what price"],
  opt_out: ["stop", "remove", "unsubscribe"],
  wrong_number: ["wrong number", "not me", "no soy", "no es mio"],
  manual_review: ["attorney", "lawyer", "lawsuit", "harassment", "legal"],
  legal: ["attorney", "lawyer", "lawsuit", "harassment", "legal"],
});

function clean(value) { return String(value ?? "").trim(); }
function escapeRegExp(value = "") { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function findMatchedKeywords(messageBody = "", groupsOrTerms = []) {
  const body = clean(messageBody);
  if (!body) return [];
  const requested = Array.isArray(groupsOrTerms) ? groupsOrTerms : [groupsOrTerms];
  // Group keywords match WHOLE WORDS: "Christopher" is not the opt-out keyword
  // "stop", "removed" is not "remove" (P0 2026-10-09). A free search term the
  // operator typed keeps substring semantics ("chris" finds "Christopher").
  const terms = requested.flatMap((entry) => {
    const group = KEYWORD_GROUPS[clean(entry).toLowerCase()];
    return group ? group.map((term) => ({ term: clean(term), whole: true })) : [{ term: clean(entry), whole: clean(entry).length <= 3 }];
  }).filter((entry) => entry.term);
  const seen = new Set();
  const matches = [];
  for (const { term, whole } of terms) {
    const pattern = whole ? `(?<![\\p{L}\\p{N}_-])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])` : escapeRegExp(term);
    const rx = new RegExp(pattern, "igu");
    let match;
    while ((match = rx.exec(body)) !== null) {
      const key = `${term.toLowerCase()}:${match.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ term, start: match.index, end: match.index + match[0].length });
      }
      if (rx.lastIndex === match.index) rx.lastIndex += 1;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function classifyInboxMessage(row = {}) {
  const body = row?.message_body || row?.message_text || "";
  const positive = findMatchedKeywords(body, ["positive_hot"]);
  const offer = findMatchedKeywords(body, ["offer_requested"]);
  const optOut = findMatchedKeywords(body, ["opt_out"]);
  const wrong = findMatchedKeywords(body, ["wrong_number"]);
  const legal = findMatchedKeywords(body, ["manual_review"]);
  return {
    positive_hot: positive.length > 0,
    offer_requested: offer.length > 0,
    opt_out: optOut.length > 0,
    wrong_number: wrong.length > 0,
    manual_review: legal.length > 0,
    matched_keywords: [...positive, ...offer, ...optOut, ...wrong, ...legal].map((m) => m.term),
  };
}
