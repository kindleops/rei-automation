// OWNER DECISION 2026-10-14: explicit STOP or ANY request to stop messaging — including a
// "STOP" glued to other text ("…STOP 🛑") — is suppression. R3 never replies to such a turn
// (conservative: the word "stop" anywhere holds it for the deterministic engine / a human).
export const STOP_REQUEST_RE = /stop|unsubscribe|opt[\s-]?out|remove\s+(?:me|my|this)|take\s+me\s+off|(?:do\s*n[o']?t|never)\s+(?:text|contact|message|msg|call|bother)|no\s+more\s+(?:texts?|messages?)|leave\s+me\s+alone|lose\s+my\s+number|quit\s+(?:texting|messaging)|cease|\bparar\b|\balto\b|\bbasta\b|no\s+me\s+(?:escriba|mande|contacte)/i
export function isStopRequest(text) {
  return STOP_REQUEST_RE.test(String(text ?? ''))
}

