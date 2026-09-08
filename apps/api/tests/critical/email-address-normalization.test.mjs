/**
 * email-address-normalization.test.mjs
 *
 * The canonical form of a seller email address.
 *
 * Every property here is a real defect if it breaks:
 *   - casing must fold        (or one seller is suppressed three times and emailed twice)
 *   - a list must REFUSE      (or a message reaches the wrong seller)
 *   - plus-tags must fold for IDENTITY but NOT for delivery
 *   - an unparseable address must refuse rather than pass through
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmailAddress,
  toNormalizedEmail,
  isSameMailbox,
} from "@/lib/domain/email/normalize-email-address.js";

// ── the sendable form ───────────────────────────────────────────────────────

test("case folds the whole address", () => {
  const result = normalizeEmailAddress("Bob.Smith@Example.COM");
  assert.equal(result.ok, true);
  assert.equal(result.normalized, "bob.smith@example.com");
});

test("strips a display name and angle brackets", () => {
  const result = normalizeEmailAddress('"Bob Smith" <bob@example.com>');
  assert.equal(result.ok, true);
  assert.equal(result.normalized, "bob@example.com");
});

test("a trailing dot on the domain is removed, not treated as a second domain", () => {
  // example.com. and example.com are the same domain. Keeping the dot would let
  // them be suppressed independently of each other.
  const withDot = normalizeEmailAddress("seller@example.com.");
  const without = normalizeEmailAddress("seller@example.com");
  assert.equal(withDot.normalized, without.normalized);
});

test("delivery form KEEPS the plus tag", () => {
  // The tag is part of the address the seller gave us. Rewriting it could send
  // to a mailbox that does not exist.
  const result = normalizeEmailAddress("bob+house@example.com");
  assert.equal(result.normalized, "bob+house@example.com");
});

// ── the identity form ───────────────────────────────────────────────────────

test("identity folds plus tags: one mailbox, not two sellers", () => {
  const tagged = normalizeEmailAddress("bob+house@example.com");
  const plain = normalizeEmailAddress("bob@example.com");
  assert.equal(tagged.mailbox_identity, plain.mailbox_identity);
});

test("identity folds Gmail dots and googlemail, which are one inbox", () => {
  assert.equal(isSameMailbox("b.o.b+listing@googlemail.com", "bob@gmail.com"), true);
});

test("identity does NOT fold dots on a non-Gmail domain", () => {
  // Outside Gmail, dots are significant. Folding them would merge two real,
  // different mailboxes and silently suppress one of them.
  assert.equal(isSameMailbox("b.ob@example.com", "bob@example.com"), false);
});

test("delivery and identity forms are allowed to differ, and do", () => {
  const result = normalizeEmailAddress("B.Ob+x@GoogleMail.com");
  assert.equal(result.normalized, "b.ob+x@googlemail.com");
  assert.equal(result.mailbox_identity, "bob@gmail.com");
  assert.notEqual(result.normalized, result.mailbox_identity);
});

// ── refusals: every one of these is a send that must not happen ─────────────

test("a comma-separated list REFUSES rather than taking the first entry", () => {
  const result = normalizeEmailAddress("a@example.com, b@example.com");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "multiple_addresses_supplied");
});

test("a semicolon-separated list also refuses", () => {
  assert.equal(normalizeEmailAddress("a@x.com;b@y.com").ok, false);
});

test("an address with no domain TLD refuses", () => {
  assert.equal(normalizeEmailAddress("bob@localhost").reason, "domain_missing_tld");
});

test("internal whitespace refuses", () => {
  assert.equal(normalizeEmailAddress("bo b@example.com").reason, "whitespace_in_address");
});

test("two at-signs refuse", () => {
  assert.equal(normalizeEmailAddress("a@b@example.com").reason, "multiple_at_signs");
});

test("an address that is nothing but a plus tag refuses", () => {
  // It folds to an empty mailbox, which is not an inbox.
  assert.equal(normalizeEmailAddress("+tag@example.com").ok, false);
});

test("mismatched brackets refuse rather than being parsed optimistically", () => {
  assert.equal(normalizeEmailAddress("Bob <bob@example.com").reason, "malformed_address_brackets");
});

test("a numeric TLD refuses: that is a mangled import, not a mail domain", () => {
  assert.equal(normalizeEmailAddress("bob@192.168.1.1").reason, "invalid_domain_tld");
});

test("an over-long local part refuses", () => {
  assert.equal(normalizeEmailAddress(`${"a".repeat(65)}@example.com`).reason, "local_part_too_long");
});

test("empty input refuses without throwing", () => {
  for (const value of [undefined, null, "", "   "]) {
    const result = normalizeEmailAddress(value);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(value)}`);
  }
});

// ── classification signals ──────────────────────────────────────────────────

test("role accounts are flagged, on the folded local part", () => {
  assert.equal(normalizeEmailAddress("info@acme.com").is_role_account, true);
  assert.equal(normalizeEmailAddress("no-reply@acme.com").is_role_account, true);
  // Folding matters: support+ticket@ is still the support mailbox.
  assert.equal(normalizeEmailAddress("support+ticket@acme.com").is_role_account, true);
  assert.equal(normalizeEmailAddress("bob@acme.com").is_role_account, false);
});

test("disposable domains are flagged after alias folding", () => {
  assert.equal(normalizeEmailAddress("x@mailinator.com").is_disposable_domain, true);
  assert.equal(normalizeEmailAddress("x@example.com").is_disposable_domain, false);
});

// ── the convenience wrapper cannot leak a falsy string ──────────────────────

test("toNormalizedEmail returns null, never an empty string, for a bad address", () => {
  assert.equal(toNormalizedEmail("not-an-address"), null);
  assert.equal(toNormalizedEmail("Bob@Example.com"), "bob@example.com");
});

test("isSameMailbox is false when either side is unparseable, never true by accident", () => {
  assert.equal(isSameMailbox("bob@example.com", "garbage"), false);
  assert.equal(isSameMailbox("garbage", "garbage"), false);
});

test("normalization never throws, for any input shape", () => {
  const hostile = [undefined, null, 0, {}, [], () => {}, "@", "@@", "a@", "@b.com", "\n@\n"];
  for (const value of hostile) {
    assert.doesNotThrow(() => normalizeEmailAddress(value), `threw on ${String(value)}`);
  }
});
