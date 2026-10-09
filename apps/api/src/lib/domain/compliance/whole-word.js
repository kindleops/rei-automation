// ─── whole-word.js ──────────────────────────────────────────────────────────
// Keyword lists are matched as WHOLE WORDS / PHRASES, never as substrings.
// P0 2026-10-09: "chriSTOPher" / "Kristopher" / "Stopher" / "Christophe"
// contain "stop"; "weekend" contains "end"; "Paramount" contains "para";
// "issue" contains "sue". Substring keyword matching turned names and ordinary
// words into opt-outs / legal threats.
//
// A term matches only when it is not glued to a letter, digit, underscore or
// hyphen on either side ("non-stop" is not "stop"). Inner whitespace in a
// phrase matches any run of whitespace. Case-insensitive, Unicode-aware.

const cache = new Map();

function termRegex(term) {
  const key = String(term);
  let rx = cache.get(key);
  if (!rx) {
    const escaped = key
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    rx = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "iu");
    cache.set(key, rx);
  }
  return rx;
}

export function includesWholeWord(text, term) {
  const haystack = String(text ?? "");
  const needle = String(term ?? "").trim();
  if (!haystack || !needle) return false;
  return termRegex(needle).test(haystack);
}

export function includesAnyWholeWord(text, terms = []) {
  return terms.some((term) => includesWholeWord(text, term));
}

export default includesAnyWholeWord;
