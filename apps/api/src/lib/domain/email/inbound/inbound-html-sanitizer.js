/**
 * inbound-html-sanitizer.js
 *
 * SELLER-CONTROLLED HTML IS HOSTILE INPUT UNTIL PROVEN OTHERWISE.
 *
 * Anyone who can email us can put anything in this string. It reaches an
 * operator's browser inside Lead Command, authenticated, with whatever session
 * that operator holds. An XSS here is not a defaced page: it is an attacker
 * acting as an acquisitions operator inside the seller database.
 *
 * ALLOW-LIST, NEVER DENY-LIST.
 *   A deny-list is a bet that you thought of every dangerous thing. You did not
 *   -- there is always another `onanimationstart`, another
 *   `<svg><set attributeName="onload">`, another data: URI trick. An allow-list
 *   is a bet that you thought of every SAFE thing, and being wrong there costs a
 *   missing bullet point rather than a compromised session.
 *
 * WHAT IS REMOVED, AND WHY EACH ONE
 *   script/style/iframe/object/embed/form  execution and exfiltration surfaces
 *   svg, math                              carry executable attributes of their own
 *   every attribute not explicitly allowed inline handlers are the classic vector
 *   javascript:, vbscript:, data:          href protocols that run code
 *   <base>                                 rewrites every relative URL on the page
 *   comments                               conditional comments execute in old IE
 *   remote images                          tracking pixels report when an OPERATOR
 *                                          read the mail, and leak their IP
 *
 * THIS IS DEFENCE IN DEPTH, NOT THE ONLY DEFENCE.
 *   The renderer must still treat the result as untrusted, and the stored row
 *   records html_is_sanitized so a component cannot assume. A sanitizer is one
 *   layer; any layer can have a bug.
 *
 * NO PARSER DEPENDENCY, DELIBERATELY.
 *   This repository has no server-side HTML parser, and adding one for a
 *   defence-in-depth pass is a bigger supply-chain decision than it looks. The
 *   approach here is aggressive REMOVAL rather than clever rewriting: anything
 *   not positively recognised is dropped, including whole elements whose content
 *   is not prose. That fails towards an empty box, never towards execution.
 */

export const HTML_SANITIZER_POLICY_VERSION = "inbound_html_sanitizer_v1";

/** Elements whose CONTENT is dropped along with the tags. */
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "embed", "applet", "form",
  "svg", "math", "template", "noscript", "frameset", "frame", "link", "meta", "base",
];

/** Elements allowed to survive as tags. Everything else is unwrapped. */
const ALLOWED_TAGS = new Set([
  "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "strike",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "a", "hr",
]);

/**
 * Attributes allowed to survive, per tag. A tag absent from this map keeps NO
 * attributes at all, which is what makes every on* handler impossible rather
 * than merely unlikely.
 */
const ALLOWED_ATTRIBUTES = Object.freeze({
  a: new Set(["href", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
});

/** Protocols a surviving href may use. */
const SAFE_URL = /^(https?:|mailto:|tel:)/i;

function clean(value) {
  return String(value ?? "");
}

/**
 * Strip whole elements including their content.
 *
 * Runs repeatedly: a payload like `<scr<script>ipt>` reconstitutes a live tag
 * once the inner one is removed, so a single pass is not enough. Bounded so a
 * pathological input cannot spin.
 */
function dropDangerousElements(html) {
  let output = html;
  for (let pass = 0; pass < 5; pass += 1) {
    const before = output;
    for (const tag of DROP_WITH_CONTENT) {
      output = output.replace(
        new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " "
      );
      // Unclosed or orphaned forms of the same element.
      output = output.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), " ");
    }
    output = output.replace(/<!--[\s\S]*?-->/g, " ");
    if (output === before) break;
  }
  return output;
}

function sanitizeAttributes(tag, attribute_source) {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed) return "";

  const kept = [];
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = pattern.exec(attribute_source)) !== null) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;

    const raw_value = match[3] ?? match[4] ?? match[5] ?? "";
    // Entities, whitespace and control characters are how `java&#115;cript:`,
    // "java\tscript:" and "java script:" slip past a naive protocol check, so all
    // three are removed before the protocol is tested.
    const value = raw_value
      .replace(/&#\d+;?|&[a-z]+;?/gi, "")
      .replace(/[\s\u0000-\u001f\u00a0\u200b-\u200d]/g, "");

    if (name === "href" && !SAFE_URL.test(value)) continue;
    kept.push(`${name}="${raw_value.replace(/"/g, "&quot;")}"`);
  }

  // A surviving link opens in a new context and must not be able to reach back
  // into ours through window.opener.
  if (tag === "a" && kept.some((attribute) => attribute.startsWith("href="))) {
    kept.push('rel="noopener noreferrer nofollow"', 'target="_blank"');
  }
  return kept.length ? ` ${kept.join(" ")}` : "";
}

/**
 * @returns {{ok, html, removed:{images,links,elements}, policy_version}}
 */
export function sanitizeInboundHtml(input, options = {}) {
  const source = clean(input);
  if (!source.trim()) {
    return {
      ok: true,
      html: null,
      removed: { images: 0, links: 0, elements: 0 },
      policy_version: HTML_SANITIZER_POLICY_VERSION,
    };
  }

  const removed = { images: 0, links: 0, elements: 0 };
  let html = dropDangerousElements(source);

  // Remote images are dropped by default. A tracking pixel in a seller's reply
  // reports when an OPERATOR opened it and leaks the office IP; neither is the
  // seller's business, and no image is load-bearing for reading a reply.
  if (options.allow_remote_images !== true) {
    html = html.replace(/<img\b[^>]*>/gi, () => { removed.images += 1; return " "; });
  }

  html = html.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (whole, raw_tag, attributes) => {
      const tag = raw_tag.toLowerCase();
      const is_closing = whole.startsWith("</");

      if (!ALLOWED_TAGS.has(tag)) {
        // UNWRAP rather than delete the contents: the text inside an unrecognised
        // element is usually the seller's actual words, and dropping it would
        // lose the message in order to defend against the container.
        removed.elements += 1;
        return " ";
      }
      if (is_closing) return `</${tag}>`;

      const safe_attributes = sanitizeAttributes(tag, attributes || "");
      if (tag === "a" && !safe_attributes.includes("href=")) removed.links += 1;
      return `<${tag}${safe_attributes}>`;
    }
  );

  // Any angle bracket that is not part of a tag we just emitted is text, and is
  // escaped so it cannot be reassembled into one in a different context later.
  html = html.replace(/<(?!\/?(?:[a-z][a-z0-9-]*)(?:\s[^<>]*)?>)/gi, "&lt;");

  return {
    ok: true,
    html: html.replace(/\s{2,}/g, " ").trim() || null,
    removed,
    policy_version: HTML_SANITIZER_POLICY_VERSION,
  };
}

export default sanitizeInboundHtml;
