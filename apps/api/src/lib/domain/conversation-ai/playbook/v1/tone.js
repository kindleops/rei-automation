// Seller register detection for mirroring (playbook v1). Deterministic and conservative.
const PROFANITY_RE = /(?:\bf[*#@$!]{2,}\w*|\bs[*#@$!]{2,}t\b|\bbs\b)|\b(?:f+u+c+k\w*|sh[i1]t\w*|b[i1]tch\w*|a(?:ss|\$\$)hole\w*|damn\w*|hell\b|crap\w*|wtf|stfu|dumbass|idiot\w*|moron\w*|scam+er\w*)/i
const CASUAL_RE = /\b(?:yeah|yep|yup|nah|lol|haha|hey|gonna|wanna|kinda|sorta|ya)\b|^[a-z0-9 ,.?!']+$/
const SKEPTIC_RE = /\b(?:who\s+(?:is|'?s)\s+this|how\s+did\s+you\s+get|scam|legit|real\s+(?:buyer|company)|why\s+(?:do\s+you|are\s+you)|prove)\b/i
const FRUSTRATED_RE = /\b(?:stop\s+(?:calling|texting)|again\?|already\s+told|how\s+many\s+times|annoy\w*|leave\s+me|enough)\b|!{2,}|\?{2,}/i
const PROFESSIONAL_RE = /\b(?:regards|sincerely|please\s+advise|kindly|per\s+our|at\s+your\s+earliest|thank\s+you\s+for\s+reaching\s+out)\b/i

export const TONES = Object.freeze(['casual', 'professional', 'skeptical', 'frustrated', 'detailed', 'direct'])

export function detectSellerTone(text = '') {
  const t = String(text || '').trim()
  const abusive = PROFANITY_RE.test(t)
  let tone = 'direct'
  if (FRUSTRATED_RE.test(t) || abusive) tone = 'frustrated'
  else if (SKEPTIC_RE.test(t)) tone = 'skeptical'
  else if (PROFESSIONAL_RE.test(t)) tone = 'professional'
  else if (t.length > 140 || (t.match(/[.!?]/g) || []).length >= 3) tone = 'detailed'
  else if (CASUAL_RE.test(t)) tone = 'casual'
  return { tone, abusive }
}

export { PROFANITY_RE }
