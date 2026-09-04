/**
 * transport-failure-phase.js
 *
 * WHICH SIDE OF THE WIRE DID A SEND FAIL ON?
 *
 * This is the single most safety-relevant question in outbound messaging. If
 * the request provably never left this process, another attempt cannot
 * duplicate a seller message. If it MAY have been written, the provider may
 * have accepted and sent it, and a retry would put a second SMS in front of a
 * real person.
 *
 * It lives here rather than in the provider adapter because both the adapter
 * and the error classifier need it, and the adapter already imports the
 * classifier -- putting it there would create an import cycle.
 */

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Which side of the wire did this failure happen on?
 *
 * "connect"  - the request provably never reached the provider. Refused
 *              connections, DNS failures and TLS handshake failures all occur
 *              before any request bytes can be accepted, so no SMS exists.
 * "inflight" - the request may already have been written. Timeouts and resets
 *              after connect land here. The provider MAY have accepted and sent
 *              the message; we simply never heard the answer.
 * "unknown"  - unrecognised. Treated as "inflight" for safety.
 *
 * Node's fetch wraps low-level failures in a TypeError whose `cause.code`
 * carries the real signal, and AbortSignal.timeout rejects with a DOMException
 * named "TimeoutError". Both are preserved here.
 */
export function classifyNetworkFailurePhase(error) {
  const name = clean(error?.name);
  const code = clean(error?.cause?.code || error?.code).toUpperCase();
  const message = lower(error?.message);

  // Node frequently reports the code only in the MESSAGE ("connect ETIMEDOUT
  // 1.2.3.4:443", "getaddrinfo ENOTFOUND api..."), not in cause.code. Those are
  // connect-phase by construction: the socket never opened, so no request left.
  //
  // Note the deliberate asymmetry on ETIMEDOUT. "connect ETIMEDOUT" is
  // pre-transmission and safe; a BARE ETIMEDOUT may be a read timeout after the
  // request was written, which is ambiguous. Only the prefixed form is trusted.
  if (
    /\bconnect\s+(ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/i.test(message) ||
    /\bgetaddrinfo\b/i.test(message) ||
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b/i.test(message)
  ) {
    return { phase: "connect", may_have_transmitted: false };
  }

  // Provably never transmitted: the socket was never established.
  const CONNECT_CODES = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ECONNABORTED",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  if (CONNECT_CODES.has(code)) return { phase: "connect", may_have_transmitted: false };
  if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code === "ERR_SSL_PROTOCOL_ERROR") {
    return { phase: "connect", may_have_transmitted: false };
  }

  // May have been transmitted: abort/timeout/reset after the socket opened.
  if (name === "TimeoutError" || name === "AbortError") {
    return { phase: "inflight", may_have_transmitted: true };
  }
  const INFLIGHT_CODES = new Set([
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  if (INFLIGHT_CODES.has(code)) return { phase: "inflight", may_have_transmitted: true };
  if (message.includes("socket hang up") || message.includes("aborted")) {
    return { phase: "inflight", may_have_transmitted: true };
  }

  // FAIL CLOSED. An unrecognised transport failure must be assumed to have
  // reached the provider; assuming otherwise is how duplicates happen.
  return { phase: "unknown", may_have_transmitted: true };
}

export default classifyNetworkFailurePhase;
