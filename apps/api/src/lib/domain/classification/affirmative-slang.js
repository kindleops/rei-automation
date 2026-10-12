/**
 * SLANG AFFIRMATIVES ARE "YES" (2026-10-12).
 *
 * Production miss 21:03Z (message_events d0eebfde): we asked the S1 ownership
 * question, the seller replied "Yeppers", classify returned unclear and no S2
 * reply was queued. The yes-patterns live in ~20 regexes across classify,
 * round-11 rules, conversation context and the seller-flow planners; rather
 * than patch each, the WHOLE-MESSAGE slang yes is canonicalized to "yes" at
 * the entry points, so every downstream pattern sees the word it already knows.
 *
 * Rules:
 *  - applies only when the entire message — after trimming punctuation,
 *    whitespace and emoji — is one of the slang forms below (≤ 4 words);
 *  - never anything carrying a negation, never part of a longer message
 *    ("yeppers but not selling" is returned unchanged);
 *  - trailing "!"/"?"/"." and emoji are kept after the canonical "yes";
 *  - pure: the stored / displayed body is never touched — callers use the
 *    result only for classification and routing.
 */

const SLANG_YES = [
  'yeppers', 'yepper', 'yuppers', 'yupper',
  'yup yup', 'yep yep',
  'yes+s', // yess, yesss, yessss…  (yes + 1 or more s)
  'yesir', 'yessir', 'yes sir',
  "yes ma'?am", 'yes maam',
  'yessum',
  'yeah yeah', 'yea yea',
  'yah',
  'yass+',
  'mhm+', 'mmhm+', 'mm+ hm+',
  'uh[ -]?huh',
  'you bet', 'ya betcha', 'you betcha',
  'affirmative',
  'sure thing',
  'totally',
  'indeed',
  'aye',
  'yeh',
  'yeap',
  'yepp+',
]

const SLANG_YES_RE = new RegExp(`^(?:${SLANG_YES.join('|')})$`, 'i')
const NEGATION_RE = /\b(?:no|not|nope|nah|never|don'?t|doesn'?t|isn'?t|won'?t|can'?t|ain'?t|stop)\b|n't\b/i
// emoji / pictographs, variation selectors, ZWJ and skin-tone modifiers
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu
const EDGE_JUNK_RE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu

/** The canonical slang form of a whole message, or null. */
function slangCore(text) {
  const withoutEmoji = text.replace(EMOJI_RE, ' ')
  const core = withoutEmoji.replace(EDGE_JUNK_RE, '').replace(/\s+/g, ' ').trim()
  if (!core) return null
  if (core.split(' ').length > 4) return null
  if (NEGATION_RE.test(core)) return null
  return SLANG_YES_RE.test(core) ? core : null
}

/**
 * "Yeppers" → "yes", "yessir!" → "yes!", "Yuppers 👍" → "yes 👍"; anything
 * else (including "yes" itself) is returned unchanged.
 */
export function canonicalizeAffirmativeSlang(text) {
  if (typeof text !== 'string') return text
  const raw = text
  if (!raw.trim() || raw.length > 60) return raw
  if (!slangCore(raw)) return raw
  // keep what trails the words: terminal punctuation and emoji
  const trailing = raw.trim().match(/[\s\p{P}\p{S}\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]*$/u)?.[0] || ''
  const kept = trailing.replace(/\s+/g, ' ').trim()
  return kept ? `yes${/^[\p{P}]/u.test(kept) ? '' : ' '}${kept}` : 'yes'
}

export function isAffirmativeSlang(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 60 && slangCore(text) !== null
}
