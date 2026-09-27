/**
 * Draft polish — a dictated or hurried SMS draft made to read like a
 * professional message: capital letters, punctuation, no filler words, no
 * speech-to-text stutter. MEANING, NAMES, NUMBERS AND PRICES ARE NEVER CHANGED.
 *
 * Deterministic by default (always available, instant). When an AI provider is
 * configured (OPENCODE_ZEN_API_KEY), the deterministic result is refined by the
 * model under a strict "fix, don't write" prompt, and any model output that
 * drifts (adds content, drops numbers, balloons in length) is discarded.
 *
 * Nothing here sends anything: it returns text for the operator to review.
 */
import { callBigPickle } from "@/lib/ai/opencode-zen-client.js";

const INTERROGATIVE = /^(would|could|can|do|does|did|are|is|was|were|will|have|has|had|what|when|where|why|how|who|whom|whose|which|should|may|might|shall|any|anything|you're open|are you)\b/i;

const CONTRACTIONS = [
  [/\bi\b/g, "I"], [/\bim\b/gi, "I'm"], [/\bive\b/gi, "I've"], [/\bid\b(?=\s+(?:like|love|be|have|need|want|say|think))/gi, "I'd"], [/\bill\b(?=\s+(?:be|have|send|call|text|check|get|let|reach|follow))/gi, "I'll"],
  [/\bi'm\b/gi, "I'm"], [/\bi've\b/gi, "I've"], [/\bi'd\b/gi, "I'd"], [/\bi'll\b/gi, "I'll"],
  [/\bdont\b/gi, "don't"], [/\bcant\b/gi, "can't"], [/\bwont\b/gi, "won't"], [/\bdidnt\b/gi, "didn't"],
  [/\bdoesnt\b/gi, "doesn't"], [/\bisnt\b/gi, "isn't"], [/\bwasnt\b/gi, "wasn't"], [/\barent\b/gi, "aren't"],
  [/\bwouldnt\b/gi, "wouldn't"], [/\bcouldnt\b/gi, "couldn't"], [/\bshouldnt\b/gi, "shouldn't"],
  [/\byoud\b/gi, "you'd"], [/\byoull\b/gi, "you'll"], [/\byouve\b/gi, "you've"],
  [/\bthats\b/gi, "that's"], [/\bwhats\b/gi, "what's"], [/\btheres\b/gi, "there's"], [/\byoure\b/gi, "you're"],
  [/\btheyre\b/gi, "they're"], [/\bweve\b/gi, "we've"], [/\bhavent\b/gi, "haven't"], [/\bhasnt\b/gi, "hasn't"],
];
const PROPER = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|april|june|july|august|september|october|november|december)\b/gi;

function capitalizeSentences(text) {
  let out = text.replace(/^\s*([a-z])/, (m, c) => m.replace(c, c.toUpperCase()));
  out = out.replace(/([.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  return out;
}

function terminate(sentence) {
  const s = sentence.trim();
  if (!s) return s;
  if (/[.!?…:)"']$/.test(s) || /[\u{1F300}-\u{1FAFF}]$/u.test(s)) return s;
  return s + (INTERROGATIVE.test(s) ? "?" : ".");
}

/** Always-available cleanup. Idempotent: polishing polished text changes nothing. */
export function polishDraftDeterministic(input) {
  let t = String(input ?? "").replace(/\r\n?/g, "\n");
  if (!t.trim()) return "";
  // Spoken punctuation (dictation). "period" is left alone: "grace period".
  t = t
    .replace(/\s*\b(?:question mark)\b/gi, "?")
    .replace(/\s*\b(?:exclamation (?:point|mark))\b/gi, "!")
    .replace(/\s*\b(?:full stop)\b/gi, ".")
    .replace(/\s*\bcomma\b/gi, ",")
    .replace(/\s*\bnew (?:line|paragraph)\b\s*/gi, "\n");
  // Fillers and stutters.
  t = t
    .replace(/(^|[\s,])(?:u+m+|u+h+|e+r+m+|u+h+m+|h+m+)(?=[\s,.!?]|$)[,]?/gi, "$1")
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = t.replace(PROPER, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  // A name right after a greeting or self-introduction: "hi linda", "this is ryan".
  t = t.replace(/\b(hi|hey|hello|dear|good (?:morning|afternoon|evening)|this is|my name is|it's|its) ([a-z][a-z'-]+)\b/gi, (m, lead, name) => (
    /^(there|all|everyone|again|just|me|the|a|an|about|not|what|so|to|for|from|in|on|with|regarding|your|you)$/i.test(name) ? m : `${lead} ${name[0].toUpperCase()}${name.slice(1)}`));
  // Spacing around punctuation.
  t = t
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
    .replace(/([,;:])(?=[^\s\d])/g, "$1 ")
    .replace(/([.!?])(?=[A-Za-z])/g, "$1 ")
    .replace(/([,.!?])\1+/g, "$1")
    .replace(/,([.!?])/g, "$1")
    .replace(/^[\s,]+/, "");
  // Every line ends properly; every sentence starts with a capital.
  t = t.split("\n").map((line) => capitalizeSentences(terminate(line))).join("\n").trim();
  return t;
}

const digits = (s) => (String(s).match(/\d[\d,.]*/g) || []).map((d) => d.replace(/[,.]$/, "")).sort().join("|");

function acceptModelOutput(source, candidate) {
  const out = String(candidate ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!out) return null;
  if (out.length > source.length * 1.6 + 40) return null; // it wrote, rather than fixed
  if (digits(out) !== digits(source)) return null; // a number or price moved
  if (/^(sure|here|okay|certainly)\b/i.test(out) && !/^(sure|here|okay|certainly)\b/i.test(source)) return null;
  return out;
}

export async function polishDraft(text, { allowModel = true } = {}) {
  const base = polishDraftDeterministic(text);
  if (!base) return { polishedText: "", source: "deterministic" };
  if (!allowModel || !process.env.OPENCODE_ZEN_API_KEY) return { polishedText: base, source: "deterministic" };
  try {
    const content = await callBigPickle([
      {
        role: "system",
        content:
          "You clean up an SMS that a real-estate acquisitions operator dictated to a property owner. " +
          "Fix punctuation, capitalization, grammar and obvious speech-to-text mistakes so it reads like a professional, friendly text message. " +
          "Keep the meaning, tone, names, numbers, prices, dates and addresses EXACTLY. Do not add greetings, sign-offs, emojis, questions or new information. " +
          "Keep it about the same length. Reply with ONLY the cleaned message text.",
      },
      { role: "user", content: base },
    ], { temperature: 0, max_tokens: 400, timeout: 6000, retries: 0 });
    const accepted = acceptModelOutput(base, content);
    return accepted ? { polishedText: accepted, source: "model" } : { polishedText: base, source: "deterministic" };
  } catch {
    return { polishedText: base, source: "deterministic" };
  }
}
