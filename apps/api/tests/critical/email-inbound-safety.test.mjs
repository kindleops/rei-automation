/**
 * email-inbound-safety.test.mjs
 *
 * Seller-controlled content reaching an operator's authenticated browser.
 *
 * An XSS in an inbound reply is not a defaced page: it is an attacker acting as
 * an acquisitions operator inside the seller database. Every payload below is
 * invented for this test -- no real seller content appears anywhere in it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeInboundHtml } from "../../src/lib/domain/email/inbound/inbound-html-sanitizer.js";
import {
  normalizeInboundBody,
  htmlToText,
} from "../../src/lib/domain/email/inbound/inbound-body-normalization.js";
import {
  classifyInboundMessage,
  INBOUND_MESSAGE_CLASS,
} from "../../src/lib/domain/email/inbound/inbound-message-classification.js";

// ── the sanitizer: nothing may execute ──────────────────────────────────────

/**
 * Everything that would make a browser run code, load a remote resource, or
 * navigate somewhere we did not intend. Each entry is (name, payload, forbidden
 * substrings) so a failure names the vector rather than printing a diff.
 */
const ATTACKS = [
  ["a bare script tag", '<p>hi</p><script>alert(1)</script>', ["<script", "alert(1)"]],
  ["a nested reconstituting script", '<scr<script>ipt>alert(1)</scr</script>ipt>', ["<script"]],
  ["an inline event handler", '<div onclick="steal()">click</div>', ["onclick", "steal()"]],
  ["an animation handler on an allowed tag", '<p onanimationstart="x()">t</p>', ["onanimationstart"]],
  ["an error handler on an image", '<img src=x onerror="alert(1)">', ["onerror", "<img"]],
  ["a javascript: href", '<a href="javascript:alert(1)">go</a>', ["javascript:"]],
  ["an entity-obfuscated javascript href", '<a href="java&#115;cript:alert(1)">go</a>', ["cript:alert"]],
  ["a whitespace-obfuscated javascript href", '<a href="java\tscript:alert(1)">go</a>', ["script:alert"]],
  ["a vbscript href", '<a href="vbscript:msgbox(1)">go</a>', ["vbscript:"]],
  ["a data: URI href", '<a href="data:text/html;base64,PHNjcmlwdD4=">go</a>', ["data:text/html"]],
  ["an svg with an executable attribute", '<svg><set attributeName="onload" to="alert(1)"/></svg>', ["<svg", "onload"]],
  ["a math ml container", '<math><mtext></mtext></math>', ["<math"]],
  ["an iframe", '<iframe src="https://evil.example.net"></iframe>', ["<iframe"]],
  ["an object", '<object data="evil.swf"></object>', ["<object"]],
  ["an embed", '<embed src="evil.swf">', ["<embed"]],
  ["a form that posts elsewhere", '<form action="https://evil.example.net"><input name="x"></form>', ["<form", "<input"]],
  ["a base tag rewriting every relative url", '<base href="https://evil.example.net/">', ["<base"]],
  ["a stylesheet link", '<link rel="stylesheet" href="https://evil.example.net/x.css">', ["<link"]],
  ["a meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example.net">', ["<meta"]],
  ["a style block with an expression", '<style>body{background:url(javascript:alert(1))}</style>', ["<style", "javascript:"]],
  ["a conditional comment", '<!--[if IE]><script>alert(1)</script><![endif]-->', ["<script", "[if IE]"]],
  ["a template element", '<template><script>alert(1)</script></template>', ["<template", "<script"]],
  ["a noscript wrapper", '<noscript><img src=x onerror=alert(1)></noscript>', ["onerror"]],
  ["an applet", '<applet code="Evil.class"></applet>', ["<applet"]],
  ["a frameset", '<frameset><frame src="https://evil.example.net"></frameset>', ["<frameset", "<frame"]],
];

for (const [name, payload, forbidden] of ATTACKS) {
  test(`sanitizer neutralizes ${name}`, () => {
    const result = sanitizeInboundHtml(payload);
    assert.equal(result.ok, true);
    const html = String(result.html ?? "");
    for (const needle of forbidden) {
      assert.equal(
        html.toLowerCase().includes(needle.toLowerCase()),
        false,
        `${name}: output still contains ${needle}\n  output: ${html}`
      );
    }
    // Nothing may survive as an on* attribute, whatever the vector was.
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${name}: an on* handler survived`);
  });
}

test("no attack payload leaves a live tag of any disallowed kind", () => {
  const disallowed = /<\s*\/?\s*(script|style|iframe|object|embed|applet|form|svg|math|template|noscript|frameset|frame|link|meta|base|input|img)\b/i;
  for (const [name, payload] of ATTACKS) {
    const html = String(sanitizeInboundHtml(payload).html ?? "");
    assert.equal(disallowed.test(html), false, `${name} left a disallowed tag: ${html}`);
  }
});

// ── the sanitizer: prose must survive ───────────────────────────────────────

test("the seller's actual words survive every one of those attacks", () => {
  // A sanitizer that empties the message is safe and useless. The words a human
  // typed have to still be there.
  const result = sanitizeInboundHtml(
    '<p>Yes I am interested</p><script>alert(1)</script><div onclick="x()">Call me Tuesday</div>'
  );
  assert.match(result.html, /Yes I am interested/);
  assert.match(result.html, /Call me Tuesday/);
});

test("text inside an UNRECOGNISED element is unwrapped, not deleted", () => {
  // The container is the threat; the text inside it is usually the message.
  const result = sanitizeInboundHtml("<article><p>My asking price is firm</p></article>");
  assert.match(result.html, /My asking price is firm/);
  assert.equal(result.html.includes("<article"), false);
});

test("ordinary formatting is preserved", () => {
  const result = sanitizeInboundHtml(
    "<p>Hello</p><ul><li><strong>One</strong></li><li><em>Two</em></li></ul><blockquote>quoted</blockquote>"
  );
  for (const tag of ["<p>", "<ul>", "<li>", "<strong>", "<em>", "<blockquote>"]) {
    assert.equal(result.html.includes(tag), true, `lost ${tag}`);
  }
});

test("a safe link survives and cannot reach back through window.opener", () => {
  const result = sanitizeInboundHtml('<a href="https://example.org/listing" title="listing">see</a>');
  assert.match(result.html, /href="https:\/\/example\.org\/listing"/);
  assert.match(result.html, /rel="noopener noreferrer nofollow"/);
  assert.match(result.html, /target="_blank"/);
});

test("mailto and tel links survive; everything else does not", () => {
  for (const href of ["mailto:seller@example.org", "tel:+15550000000", "https://example.org", "http://example.org"]) {
    assert.match(sanitizeInboundHtml(`<a href="${href}">x</a>`).html, /href=/, href);
  }
  for (const href of ["file:///etc/passwd", "ftp://example.org", "chrome://settings", "//evil.example.net"]) {
    const html = sanitizeInboundHtml(`<a href="${href}">x</a>`).html ?? "";
    assert.equal(html.includes("href="), false, href);
  }
});

test("a table renders, with only span attributes kept", () => {
  const result = sanitizeInboundHtml(
    '<table><tr><td colspan="2" style="color:red" onmouseover="x()">A</td></tr></table>'
  );
  assert.match(result.html, /colspan="2"/);
  assert.equal(result.html.includes("style="), false);
  assert.equal(result.html.includes("onmouseover"), false);
});

// ── the sanitizer: privacy ──────────────────────────────────────────────────

test("remote images are dropped so a tracking pixel cannot report on the operator", () => {
  // A pixel in a seller's reply reports WHEN AN OPERATOR read it and leaks the
  // office IP. Neither is the seller's business.
  const result = sanitizeInboundHtml('<p>hi</p><img src="https://track.example.net/p.gif?id=1" width="1">');
  assert.equal(result.removed.images, 1);
  assert.equal(String(result.html).includes("track.example.net"), false);
});

test("images can be allowed explicitly, and only explicitly", () => {
  const off = sanitizeInboundHtml('<img src="https://example.org/a.png">');
  const on = sanitizeInboundHtml('<img src="https://example.org/a.png">', { allow_remote_images: true });
  assert.equal(off.removed.images, 1);
  assert.equal(on.removed.images, 0);
  // Even when allowed, <img> is not an allowed TAG, so it is still unwrapped
  // rather than rendered -- opting in changes the counter, not the policy.
  assert.equal(String(on.html ?? "").includes("<img"), false);
});

// ── the sanitizer: hostile shapes ───────────────────────────────────────────

test("the sanitizer never throws and never hangs on hostile input", () => {
  const nasty = [
    null, undefined, "", "   ", 0, {}, [],
    "<".repeat(20_000),
    "<div>".repeat(5_000),
    "<scr".repeat(5_000) + "ipt>",
    "a".repeat(200_000),
    '<a href="' + "x".repeat(50_000) + '">y</a>',
  ];
  for (const payload of nasty) {
    const started = Date.now();
    let result;
    assert.doesNotThrow(() => { result = sanitizeInboundHtml(payload); }, String(payload).slice(0, 40));
    assert.equal(result.ok, true);
    assert.ok(Date.now() - started < 5_000, "sanitizer took too long");
  }
});

test("a stray angle bracket becomes text and cannot be reassembled into a tag", () => {
  const result = sanitizeInboundHtml("<p>price < 200000 and > 150000</p>");
  assert.match(result.html, /&lt; 200000/);
});

test("plain text with no HTML at all comes back intact", () => {
  const result = sanitizeInboundHtml("Just calling to say yes, 3pm works.");
  assert.equal(result.html, "Just calling to say yes, 3pm works.");
});

// ── body normalization ──────────────────────────────────────────────────────

test("the newest reply is separated from the quoted history", () => {
  const body = normalizeInboundBody({
    text_body: [
      "Yes, still interested. Call me after 4.",
      "",
      "On Mon, 8 Sep 2026 at 18:04, Acquisitions <acq@example.net> wrote:",
      "> Are you still considering an offer on the property?",
      "> Let us know.",
    ].join("\n"),
  });
  assert.equal(body.newest_reply, "Yes, still interested. Call me after 4.");
  assert.equal(body.source, "quote_stripped");
  // The whole message is STILL kept: stripping is a heuristic, and a heuristic
  // that deletes is unrecoverable.
  assert.match(body.normalized_text, /Are you still considering an offer/);
});

test("all three views are retained, always", () => {
  const body = normalizeInboundBody({ text_body: "Short answer: no." });
  assert.equal(typeof body.raw_text, "string");
  assert.equal(typeof body.normalized_text, "string");
  assert.equal(typeof body.newest_reply, "string");
});

test("quote stripping that would leave nothing falls back to the whole message", () => {
  // A seller who replies ONLY inside the quoted text has said something, and
  // reporting that they said nothing is worse than reporting too much.
  const body = normalizeInboundBody({
    text_body: "> Are you interested?\n> Yes I am, sorry for top posting",
  });
  assert.notEqual(body.newest_reply, null);
  assert.match(body.newest_reply, /Yes I am/);
});

test("an Outlook divider is recognised", () => {
  const body = normalizeInboundBody({
    text_body: "Sounds good.\n\n-----Original Message-----\nFrom: Acquisitions\nSent: Monday",
  });
  assert.equal(body.newest_reply, "Sounds good.");
});

test("a forwarded-message banner is recognised", () => {
  const body = normalizeInboundBody({
    text_body: "See below, this is the right person.\n\n---------- Forwarded message ----------\nFrom: someone",
  });
  assert.equal(body.newest_reply, "See below, this is the right person.");
});

test("a signature is split off rather than read as the seller's answer", () => {
  const body = normalizeInboundBody({
    text_body: "Tuesday works.\n\n-- \nJ. Doe\nDoe Property LLC",
  });
  assert.equal(body.newest_reply, "Tuesday works.");
  assert.match(body.signature, /Doe Property LLC/);
});

test("a mobile signature is split off too", () => {
  const body = normalizeInboundBody({ text_body: "Yes.\n\nSent from my iPhone" });
  assert.equal(body.newest_reply, "Yes.");
});

test("an HTML-only message falls back to converted text and says so", () => {
  const body = normalizeInboundBody({
    html_body: "<p>Interested.</p><p>Call Thursday.</p>",
  });
  assert.equal(body.had_html_only, true);
  assert.match(body.normalized_text, /Interested/);
  assert.match(body.normalized_text, /Call Thursday/);
});

test("a text part is preferred over converting the HTML part", () => {
  const body = normalizeInboundBody({
    text_body: "the text part",
    html_body: "<p>the html part</p>",
  });
  assert.equal(body.had_html_only, false);
  assert.equal(body.normalized_text, "the text part");
});

test("an empty body is a real outcome, not an error", () => {
  // A seller replies with only an attachment, or a single emoji their client
  // renders as an image.
  const body = normalizeInboundBody({ text_body: "   \n\n  " });
  assert.equal(body.is_empty, true);
  assert.equal(body.newest_reply, null);
  assert.equal(body.source, "empty");
});

test("a provider extraction is used only when it matches the body we hold", () => {
  const shared = "Yes, go ahead.";
  const matching = normalizeInboundBody({
    text_body: `${shared}\n\nOn Mon, 8 Sep 2026 at 18:04, A <a@example.net> wrote:\n> ping`,
    provider_reply_text: shared,
  });
  assert.equal(matching.source, "provider_extraction");
  assert.equal(matching.newest_reply, shared);

  // An extraction sharing nothing with the body is not an extraction OF it, and
  // trusting it would replace the seller's words with something unverifiable.
  const mismatched = normalizeInboundBody({
    text_body: shared,
    provider_reply_text: "Completely different text the seller never wrote",
  });
  assert.notEqual(mismatched.source, "provider_extraction");
  assert.equal(mismatched.newest_reply, shared);
});

test("htmlToText drops stylesheet and script text rather than reading it aloud", () => {
  const text = htmlToText("<style>p{color:red}</style><script>var x=1</script><p>Real message</p>");
  assert.equal(text.includes("color:red"), false);
  assert.equal(text.includes("var x=1"), false);
  assert.match(text, /Real message/);
});

test("body normalization never throws on hostile input", () => {
  for (const input of [null, undefined, "", 0, [], { text_body: {} }, { html_body: ["x"] }]) {
    assert.doesNotThrow(() => normalizeInboundBody(input), String(input));
  }
});

test("zero-width characters cannot hide a quote marker from the stripper", () => {
  // Some clients insert U+200B freely, and a zero-width space sitting inside a
  // quote marker stops it matching -- which would report the entire quoted
  // history as the seller's newest words.
  const body = normalizeInboundBody({
    text_body: "Answer here.\n\n\u200bOn Mon, 8 Sep 2026 at 18:04, A <a@example.net> wrote:\n> ping",
  });
  assert.equal(body.newest_reply, "Answer here.");
});

test("entity decoding never smuggles in a control character", () => {
  // `&#0;` and `&#7;` decode to characters that are invisible in a log line and
  // meaningful to a terminal or a downstream parser, so they stay encoded.
  const body = normalizeInboundBody({ html_body: "<p>a&#0;b&#7;c&#60;d</p>" });
  assert.equal(/[\u0000-\u001f\u007f]/.test(body.normalized_text), false);
  // The printable one still decodes, so the check above is not vacuous.
  assert.match(body.normalized_text, /c<d/);
});

// ── system mail must never be read as a seller answer ───────────────────────

test("an RFC 3834 auto-reply is classified as automatic, not as a seller reply", () => {
  const result = classifyInboundMessage({
    from: { email: "seller@example.org" },
    subject: "Out of office",
    headers: { "auto-submitted": "auto-replied" },
  });
  assert.equal(result.message_class, INBOUND_MESSAGE_CLASS.AUTO_REPLY);
});

test("a list header marks bulk mail, not a conversation", () => {
  const result = classifyInboundMessage({
    from: { email: "news@example.org" },
    subject: "This week in real estate",
    headers: { "list-unsubscribe": "<https://example.org/u>" },
  });
  assert.notEqual(result.message_class, INBOUND_MESSAGE_CLASS.HUMAN_REPLY);
});

test("a bounce is classified from its headers, not from its wording", () => {
  const result = classifyInboundMessage({
    from: { email: "MAILER-DAEMON@mail.example.net" },
    subject: "Undelivered Mail Returned to Sender",
    headers: { "content-type": "multipart/report; report-type=delivery-status" },
  });
  assert.equal(result.message_class, INBOUND_MESSAGE_CLASS.DELIVERY_STATUS);
});

test("a delivery-status report is never treated as a seller answering", () => {
  // A bounce that reached the seller-reply path would look like the seller
  // replied to their own message, and a reply is what the pipeline acts on.
  const result = classifyInboundMessage({
    from: { email: "MAILER-DAEMON@mail.example.net" },
    subject: "Undelivered Mail Returned to Sender",
    headers: { "content-type": "multipart/report; report-type=delivery-status" },
    text_body: "Yes I am very interested, please call me",
  });
  assert.notEqual(result.message_class, INBOUND_MESSAGE_CLASS.HUMAN_REPLY);
});

test("a genuine seller reply is NOT misclassified as system mail", () => {
  const result = classifyInboundMessage({
    from: { email: "seller@example.org", name: "J. Doe" },
    subject: "Re: your offer",
    headers: { "in-reply-to": "<abc@mail.example.net>" },
    text_body: "Yes, I would consider 240k. When can you look at it?",
  });
  assert.equal(result.message_class, INBOUND_MESSAGE_CLASS.HUMAN_REPLY);
});

test("classification fails TOWARDS a human, because a missed reply is worse than a reviewed robot", () => {
  const result = classifyInboundMessage({
    from: { email: "unknown@example.org" },
    subject: "",
    headers: {},
  });
  assert.equal(result.message_class, INBOUND_MESSAGE_CLASS.HUMAN_REPLY);
});

test("a seller writing the words 'out of office' is still a seller", () => {
  // Classification is HEADER-first for exactly this reason: body text is
  // seller-controlled, and treating prose as protocol lets a seller be silenced
  // by a phrase they happened to use.
  const result = classifyInboundMessage({
    from: { email: "seller@example.org" },
    subject: "Re: your offer",
    headers: {},
    text_body: "I was out of office last week, sorry. Yes, still interested.",
  });
  assert.equal(result.message_class, INBOUND_MESSAGE_CLASS.HUMAN_REPLY);
});

test("classification never throws on hostile input", () => {
  for (const input of [null, undefined, "", 0, [], { headers: null }, { from: null }]) {
    assert.doesNotThrow(() => classifyInboundMessage(input), String(input));
  }
});
