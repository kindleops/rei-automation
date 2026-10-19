// OWNER DECISION 2026-10-14: explicit STOP or ANY request to stop messaging — including a
// "STOP" glued to other text ("…STOP 🛑") — is suppression. R3 never replies to such a turn
// (conservative: the word "stop" anywhere holds it for the deterministic engine / a human).
// blind-eval v2 STP-09: "can you stop by Thursday at 3" is a VISIT request, never a stop ("stop by and
// stop texting me" still matches on its second "stop")
export const STOP_REQUEST_RE = /stop(?!\s+(?:by|over|in|off|past|on\s+by|and\s+(?:see|look))\b)|unsubscribe|opt[\s-]?out|remove\s+(?:me|my|this)|take\s+me\s+off|(?:do\s*n[o']?t|never)\s+(?:text|contact|message|msg|call|bother)|no\s+more\s+(?:texts?|messages?)|leave\s+me\s+alone|lose\s+my\s+number|quit\s+(?:texting|messaging)|cease|\bparar\b|\balto\b|\bbasta\b|no\s+me\s+(?:escriba|mande|contacte)/i
export function isStopRequest(text) {
  return STOP_REQUEST_RE.test(String(text ?? ''))
}

