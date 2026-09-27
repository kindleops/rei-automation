/**
 * Live dictation cleanup — the client twin of the server's draft polish
 * (apps/api/src/lib/domain/inbox/draft-polish.js), so a voice message reads as
 * finished sentences the moment it lands, before the server round trip.
 * Never changes names, numbers or prices.
 */
const INTERROGATIVE = /^(would|could|can|do|does|did|are|is|was|were|will|have|has|had|what|when|where|why|how|who|whom|whose|which|should|may|might|shall|any|anything)\b/i

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bi\b/g, 'I'], [/\bim\b/gi, "I'm"], [/\bive\b/gi, "I've"], [/\bi'm\b/gi, "I'm"], [/\bi've\b/gi, "I've"], [/\bi'd\b/gi, "I'd"], [/\bi'll\b/gi, "I'll"],
  [/\bdont\b/gi, "don't"], [/\bcant\b/gi, "can't"], [/\bwont\b/gi, "won't"], [/\bdidnt\b/gi, "didn't"], [/\bdoesnt\b/gi, "doesn't"],
  [/\bisnt\b/gi, "isn't"], [/\bwasnt\b/gi, "wasn't"], [/\barent\b/gi, "aren't"], [/\bwouldnt\b/gi, "wouldn't"], [/\bcouldnt\b/gi, "couldn't"],
  [/\byoud\b/gi, "you'd"], [/\byoull\b/gi, "you'll"], [/\byouve\b/gi, "you've"], [/\bthats\b/gi, "that's"], [/\bwhats\b/gi, "what's"],
  [/\btheres\b/gi, "there's"], [/\byoure\b/gi, "you're"], [/\btheyre\b/gi, "they're"], [/\bhavent\b/gi, "haven't"],
]
const PROPER = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|april|june|july|august|september|october|november|december)\b/gi

export function cleanDictation(input: string, { terminate = true }: { terminate?: boolean } = {}): string {
  let t = String(input ?? '')
  if (!t.trim()) return ''
  t = t
    .replace(/\s*\b(?:question mark)\b/gi, '?')
    .replace(/\s*\b(?:exclamation (?:point|mark))\b/gi, '!')
    .replace(/\s*\b(?:full stop)\b/gi, '.')
    .replace(/\s*\bcomma\b/gi, ',')
    .replace(/(^|[\s,])(?:u+m+|u+h+|e+r+m+|u+h+m+|h+m+)(?=[\s,.!?]|$)[,]?/gi, '$1')
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep)
  t = t.replace(PROPER, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  // A name right after a greeting or self-introduction: "hi linda", "this is ryan".
  t = t.replace(/\b(hi|hey|hello|dear|good (?:morning|afternoon|evening)|this is|my name is|it's|its) ([a-z][a-z'-]+)\b/gi, (m, lead: string, name: string) => (
    /^(there|all|everyone|again|just|me|the|a|an|about|not|what|so|to|for|from|in|on|with|regarding|your|you)$/i.test(name) ? m : `${lead} ${name[0].toUpperCase()}${name.slice(1)}`))
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .replace(/([,;:])(?=[^\s\d])/g, '$1 ')
    .replace(/([.!?])(?=[A-Za-z])/g, '$1 ')
    .replace(/([,.!?])\1+/g, '$1')
    .replace(/,([.!?])/g, '$1')
    .replace(/^[\s,]+/, '')
    .trim()
  t = t.replace(/^([a-z])/, (c) => c.toUpperCase()).replace(/([.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
  if (terminate && !/[.!?…:)"']$/.test(t)) {
    const last = t.split(/(?<=[.!?])\s+/).pop() ?? t
    t += INTERROGATIVE.test(last) ? '?' : '.'
  }
  return t
}
