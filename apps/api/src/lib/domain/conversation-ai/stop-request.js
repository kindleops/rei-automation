// OWNER DECISION 2026-10-14: explicit STOP or ANY request to stop messaging — including a
// "STOP" glued to other text ("…STOP 🛑") — is suppression. R3 never replies to such a turn
// (conservative: the word "stop" anywhere holds it for the deterministic engine / a human).
// blind-eval v2 STP-09: "can you stop by Thursday at 3" is a VISIT request, never a stop ("stop by and
// stop texting me" still matches on its second "stop")
// rc-8.5.21 v4 OBJECT / TARGET analysis (revocation-morphology.js): a stop WORD is read with what it stops
// and who stops it. Not a stop request: a negated first-person continuation ("can't stop thinking about
// selling", "j'arrête pas de recevoir des offres"), a first-person stop of something else ("I need to stop the
// foreclosure"), and the Spanish words "basta" / "parar" / "alto" aimed at a third party or used as a
// preposition / adjective ("Basta ya con ese inquilino", "me parece muy alto"). A continuation whose object is
// OUR messages ("you never stop texting me") stays a stop request.
import { stopSpansAimedAtUs } from '../classification/revocation-morphology.js'

export { stopSpansAimedAtUs }
export const STOP_REQUEST_RE = /stop(?!\s+(?:by|over|in|off|past|on\s+by|and\s+(?:see|look))\b)|unsubscribe|opt[\s-]?out|remove\s+(?:me|my|this)|take\s+me\s+off|(?:do\s*n[o']?t|never)\s+(?:text|contact|message|msg|call|bother)|no\s+more\s+(?:texts?|messages?)|leave\s+me\s+alone|lose\s+my\s+number|quit\s+(?:texting|messaging)|cease|\bparar\b|\balto\b|\bbasta\b|no\s+me\s+(?:escriba|mande|contacte)|\bdet[eé]nte\b|^\s*(?:para|cancela|no\s+m[áa]s)\s*[.!]*\s*$/i

export function isStopRequest(text) {
  const t = String(text ?? '')
  if (!STOP_REQUEST_RE.test(t)) return false
  return STOP_REQUEST_RE.test(stopSpansAimedAtUs(t))
}
