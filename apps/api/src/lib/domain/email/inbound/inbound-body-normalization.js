/**
 * inbound-body-normalization.js
 *
 * Turning what arrived into something readable, WITHOUT throwing away what
 * arrived.
 *
 * THREE VIEWS, ALL KEPT.
 *   raw           exactly what the provider handed us
 *   normalized    the whole readable message, line endings and entities sorted
 *   newest_reply  just what the human typed THIS time
 *
 *   The temptation is to keep only the newest reply, because that is what a
 *   reader wants and what EMAIL-4 will classify. The reason not to: quote
 *   stripping is a heuristic over infinitely many mail clients, and when it is
 *   wrong it is wrong by DELETING the seller's actual words. Keeping all three
 *   means a mistake is recoverable instead of permanent.
 *
 * QUOTE STRIPPING IS CONSERVATIVE ON PURPOSE.
 *   It cuts at markers that are near-universal and unambiguous -- a leading `>`
 *   run, "On <date>, <someone> wrote:", the Outlook divider, a forwarded-message
 *   banner. It does NOT try to be clever about inline replies, because a seller
 *   who answers question-by-question inside the quoted text would have their
 *   answers deleted by a cleverer algorithm.
 *
 *   If stripping would leave nothing, the whole normalized body is returned
 *   instead. An empty newest-reply is never an acceptable output when the seller
 *   demonstrably wrote something.
 *
 * NO BESPOKE MIME PARSER.
 *   Brevo supplies decoded text and HTML parts, so there is no MIME to parse. If
 *   raw MIME ever arrives, the correct move is a mature parser, not boundary
 *   splitting by hand.
 */

export const BODY_NORMALIZATION_POLICY_VERSION = "inbound_body_v1";

/**
 * Cut markers, ordered. The earliest match in the text wins, because a message
 * can contain several and the first one is where the seller stopped writing.
 */
const QUOTE_MARKERS = [
  // "On Mon, 8 Sep 2026 at 18:04, Acquisitions <a@b.com> wrote:"
  /^\s*On .{4,120}\s+wrote:\s*$/im,
  // Outlook / Exchange
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*_{5,}\s*$/m,
  /^\s*From:\s*.+$\n^\s*Sent:\s*.+$/im,
  // Forwarded banners
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  // Apple Mail
  /^\s*Begin forwarded message:\s*$/im,
  // A run of quoted lines starting at a line boundary
  /^\s*>{1,}\s?.*$/m,
];

/** Signature dividers. RFC 3676 says "-- " exactly; clients also use variants. */
const SIGNATURE_MARKERS = [
  /^-- ?$/m,
  /^\s*Sent from my (iPhone|iPad|Android|Samsung|BlackBerry).*$/im,
  /^\s*Get Outlook for (iOS|Android).*$/im,
];

const HTML_ENTITIES = Object.freeze({
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "-", "&ndash;": "-", "&hellip;": "...",
});

function clean(value) {
  return String(value ?? "");
}

/**
 * Line endings, zero-width characters and runaway blank lines.
 *
 * The zero-width strip matters more than it looks: a zero-width space inside a
 * quote marker stops the marker matching, and some clients insert them freely.
 */
function normalizeWhitespace(text) {
  return clean(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text) {
  return clean(text)
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => {
      if (HTML_ENTITIES[entity]) return HTML_ENTITIES[entity];
      const numeric = /^&#(\d+);$/.exec(entity);
      if (numeric) {
        const code = Number(numeric[1]);
        // Only decode printable characters. Decoding a control character would
        // let a crafted entity smuggle one into text we later treat as clean.
        if (code >= 32 && code !== 127) return String.fromCodePoint(code);
      }
      return entity;
    });
}

/**
 * HTML to readable text. Deliberately simple: this is for a plain-text FALLBACK
 * when no text part exists, not for rendering. Rendering uses the sanitizer.
 */
export function htmlToText(html) {
  const source = clean(html);
  if (!source) return "";
  return normalizeWhitespace(
    decodeEntities(
      source
        // Drop entire elements whose CONTENT is not prose, before tag stripping:
        // otherwise stylesheet and script text ends up in the message.
        .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
    )
  );
}

/** Where does the quoted history begin? -1 when it does not. */
function findQuoteStart(text) {
  let earliest = -1;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index >= 0 && (earliest === -1 || match.index < earliest)) {
      earliest = match.index;
    }
  }
  return earliest;
}

function splitSignature(text) {
  let earliest = -1;
  for (const marker of SIGNATURE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index >= 0 && (earliest === -1 || match.index < earliest)) {
      earliest = match.index;
    }
  }
  if (earliest <= 0) return { body: text, signature: null };
  return {
    body: text.slice(0, earliest).trim(),
    signature: text.slice(earliest).trim() || null,
  };
}

/**
 * @param {object} input
 * @param {string|null} input.text_body
 * @param {string|null} input.html_body
 * @param {string|null} input.provider_reply_text  the provider's own extraction
 *
 * @returns {{raw_text, normalized_text, newest_reply, signature, source,
 *            had_html_only, is_empty, policy_version}}
 */
export function normalizeInboundBody(input = {}) {
  const text_body = clean(input.text_body);
  const html_body = clean(input.html_body);
  const provider_reply_text = clean(input.provider_reply_text);

  // A text part is preferred over converting HTML: it is what the sender's
  // client chose to represent the message as plain text, and converting is
  // always lossy.
  const had_html_only = !text_body && Boolean(html_body);
  const raw_text = text_body || (html_body ? htmlToText(html_body) : "");
  const normalized_text = normalizeWhitespace(raw_text);

  if (!normalized_text) {
    // An empty body is a real thing -- a seller replies with only an attachment,
    // or a single emoji their client renders as an image. It is not an error.
    return {
      raw_text: raw_text || null,
      normalized_text: null,
      newest_reply: null,
      signature: null,
      source: "empty",
      had_html_only,
      is_empty: true,
      policy_version: BODY_NORMALIZATION_POLICY_VERSION,
    };
  }

  // The provider's own extraction is preferred when it supplied one AND it is a
  // substring-ish prefix of what we have. That last check matters: an extraction
  // that shares nothing with the body is not an extraction of it, and trusting
  // it blindly would replace the seller's words with something unverifiable.
  if (provider_reply_text) {
    const candidate = normalizeWhitespace(provider_reply_text);
    if (candidate && normalized_text.includes(candidate.slice(0, Math.min(40, candidate.length)))) {
      const { body, signature } = splitSignature(candidate);
      return {
        raw_text,
        normalized_text,
        newest_reply: body || candidate,
        signature,
        source: "provider_extraction",
        had_html_only,
        is_empty: false,
        policy_version: BODY_NORMALIZATION_POLICY_VERSION,
      };
    }
  }

  const quote_start = findQuoteStart(normalized_text);
  const before_quote = quote_start > 0
    ? normalized_text.slice(0, quote_start).trim()
    : quote_start === 0 ? "" : normalized_text;

  // Stripping that leaves nothing is stripping that was wrong. Fall back to the
  // whole message rather than reporting that the seller said nothing.
  const candidate = before_quote || normalized_text;
  const { body, signature } = splitSignature(candidate);

  return {
    raw_text,
    normalized_text,
    newest_reply: body || candidate,
    signature,
    source: quote_start >= 0 ? "quote_stripped" : "whole_body",
    had_html_only,
    is_empty: false,
    policy_version: BODY_NORMALIZATION_POLICY_VERSION,
  };
}

export default normalizeInboundBody;
