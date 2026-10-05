// TwiML builders for the TextGrid (Twilio-compatible) voice webhook.
// Every response is a complete, well-formed <Response> document.

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function doc(inner = "") {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// Neutral wording: it never promises a text, because the text can be skipped
// (opt-out, rate limit, window) and the prompt must stay true either way.
export const NO_ANSWER_PROMPT =
  "Sorry, we can't take your call right now. You can also text this number and we'll get back to you.";

export function twimlReject(reason = "busy") {
  const r = reason === "rejected" ? "rejected" : "busy";
  return doc(`<Reject reason="${r}"/>`);
}

export function twimlHangup() {
  return doc("<Hangup/>");
}

export function twimlSayThenHangup(text = NO_ANSWER_PROMPT) {
  return doc(`<Say>${escapeXml(text)}</Say><Hangup/>`);
}

/**
 * Forward the call to the owner's phone. `action` receives DialCallStatus
 * when the forwarded leg ends (or times out); `caller_id` is the LeadCommand
 * line that was called, so the owner sees which number rang.
 */
export function twimlDialForward({ forward_number, timeout_seconds = 20, action_url, caller_id = null }) {
  const attrs = [
    `timeout="${Number(timeout_seconds) || 20}"`,
    `action="${escapeXml(action_url)}"`,
    `method="POST"`,
    caller_id ? `callerId="${escapeXml(caller_id)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return doc(`<Dial ${attrs}><Number>${escapeXml(forward_number)}</Number></Dial>`);
}

export function twimlEmpty() {
  return doc("");
}

export const TWIML_CONTENT_TYPE = "text/xml; charset=utf-8";

export default {
  twimlReject,
  twimlHangup,
  twimlSayThenHangup,
  twimlDialForward,
  twimlEmpty,
  TWIML_CONTENT_TYPE,
  NO_ANSWER_PROMPT,
};
