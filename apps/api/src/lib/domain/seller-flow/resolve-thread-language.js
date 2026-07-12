// ─── resolve-thread-language.js ──────────────────────────────────────────────
// Canonical conversation-language resolution. Priority (activation spec):
//   1. canonical thread language (conversation brain / thread history)
//   2. prospect language preference
//   3. explicit language passed by the inbound system
//   4. high-confidence script/keyword detection for the current message
//   5. unknown
//
// The point of the chain: one short, ambiguous reply ("ok", "yes") in an
// established Spanish/Mandarin/Japanese conversation must never flip the
// thread to English. Per-message detection only decides when nothing
// upstream knows the language. Unknown is a first-class outcome — the
// template layer already fails closed (language_template_missing → human
// review) when no matching-language template exists; this resolver never
// invents an English fallback for an established non-English thread.

export const THREAD_LANGUAGE_RESOLVER_VERSION = "thread_language_resolver_v1";
export const UNKNOWN_LANGUAGE = "unknown";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeLanguageName(value) {
  const raw = clean(value);
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (["unknown", "und", "unspecified", "n/a", "none"].includes(key)) return UNKNOWN_LANGUAGE;
  // Preserve the catalog's capitalized language names (sms_templates.language
  // stores "English"/"Spanish"/…); map common codes onto them.
  const CODE_MAP = {
    en: "English", eng: "English", english: "English",
    es: "Spanish", spa: "Spanish", spanish: "Spanish", "español": "Spanish", espanol: "Spanish",
    pt: "Portuguese", portuguese: "Portuguese", "português": "Portuguese",
    fr: "French", french: "French",
    de: "German", german: "German",
    it: "Italian", italian: "Italian",
    vi: "Vietnamese", vietnamese: "Vietnamese",
    zh: "Mandarin", "zh-cn": "Mandarin", mandarin: "Mandarin", chinese: "Mandarin",
    ja: "Japanese", japanese: "Japanese",
    ko: "Korean", korean: "Korean",
    ru: "Russian", russian: "Russian",
    ar: "Arabic", arabic: "Arabic",
    hi: "Hindi", hindi: "Hindi",
    th: "Thai", thai: "Thai",
    he: "Hebrew", hebrew: "Hebrew",
    el: "Greek", greek: "Greek",
  };
  if (CODE_MAP[key]) return CODE_MAP[key];
  // Unrecognized names pass through capitalized-as-given: unknown language
  // codes are supported, not collapsed into English.
  return raw;
}

const NON_LATIN_SCRIPT_RE = /[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ一-鿿가-힯Ͱ-Ͽ]/;

function wordCount(text) {
  return clean(text).split(/\s+/).filter(Boolean).length;
}

/**
 * Is the per-message detection trustworthy enough to establish a language?
 * Non-English detections come from script/keyword evidence (classify.js) —
 * accept them. An "English" detection is the classifier's default and only
 * counts on messages long enough to actually be English evidence.
 */
export function isHighConfidenceDetection({ detectedLanguage, messageText = "" } = {}) {
  const language = normalizeLanguageName(detectedLanguage);
  if (!language || language === UNKNOWN_LANGUAGE) return false;
  if (language !== "English") return true;
  if (NON_LATIN_SCRIPT_RE.test(clean(messageText))) return false;
  return wordCount(messageText) >= 3;
}

/**
 * Resolve the language a reply to this thread must be written in.
 * Returns { language, source, is_unknown, resolver_version }.
 */
export function resolveThreadLanguage({
  threadLanguage = null,
  prospectLanguagePreference = null,
  explicitInboundLanguage = null,
  detectedLanguage = null,
  messageText = "",
} = {}) {
  const candidates = [
    { value: normalizeLanguageName(threadLanguage), source: "thread_language" },
    { value: normalizeLanguageName(prospectLanguagePreference), source: "prospect_language_preference" },
    { value: normalizeLanguageName(explicitInboundLanguage), source: "explicit_inbound_language" },
  ];

  for (const candidate of candidates) {
    if (candidate.value && candidate.value !== UNKNOWN_LANGUAGE) {
      return {
        language: candidate.value,
        source: candidate.source,
        is_unknown: false,
        resolver_version: THREAD_LANGUAGE_RESOLVER_VERSION,
      };
    }
  }

  if (isHighConfidenceDetection({ detectedLanguage, messageText })) {
    return {
      language: normalizeLanguageName(detectedLanguage),
      source: "high_confidence_detection",
      is_unknown: false,
      resolver_version: THREAD_LANGUAGE_RESOLVER_VERSION,
    };
  }

  return {
    language: UNKNOWN_LANGUAGE,
    source: "unknown",
    is_unknown: true,
    resolver_version: THREAD_LANGUAGE_RESOLVER_VERSION,
  };
}

export default resolveThreadLanguage;
