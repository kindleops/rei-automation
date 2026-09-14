/**
 * INBOX-COMPOSER-LOCK-1 — an unresolved template variable must never reach a seller.
 *
 * Templates are authored with {{variable}}. When a variable cannot be resolved,
 * the dashboard's renderTemplate substitutes `[[variable]]` -- a deliberately
 * visible marker so the operator can see what is missing. The transport guard,
 * the last check before the provider call, only knew the {{ }} form.
 *
 * So the one shape that actually reached the wire unresolved was the only one the
 * guard could not see: "Hey [[seller_first_name]], quick question about..." with
 * nothing in the UI stopping Send Now either.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const providerSource = readFileSync(
  fileURLToPath(new URL("../../src/lib/providers/textgrid.js", import.meta.url)),
  "utf8",
);

/** The guard, read from the transport module so the test cannot drift from it. */
function loadPlaceholderPattern() {
  const match = providerSource.match(/const UNRESOLVED_PLACEHOLDER_RE = (\/.*\/);/);
  assert.ok(match, "UNRESOLVED_PLACEHOLDER_RE must exist in the transport module");
  // eslint-disable-next-line no-eval
  return eval(match[1]);
}

const RE = loadPlaceholderPattern();

test("the renderer's own unresolved form is blocked", () => {
  // renderTemplate: `return \`[[${variable}]]\`` on a missing value.
  assert.equal(RE.test("Hey [[seller_first_name]], quick question about your property"), true);
  assert.equal(RE.test("What would you need for [[property_address]]?"), true);
  assert.equal(RE.test("This is [[agent_name]] following up"), true);
});

test("the authored form is still blocked", () => {
  assert.equal(RE.test("Hi {{first_name}}, are you still open to an offer?"), true);
  assert.equal(RE.test("{{ seller_first_name }}"), true);
});

test("a fully resolved message passes", () => {
  assert.equal(RE.test("Hey Ronald, it's Greg. Just checking back on 5115 Michigan Ave."), false);
  assert.equal(RE.test("Would you consider selling if the numbers made sense?"), false);
  assert.equal(RE.test("Hola, habla Carlos."), false);
});

test("ordinary punctuation a seller might send is not mistaken for a placeholder", () => {
  assert.equal(RE.test("I'd need around $150k [firm]"), false);
  assert.equal(RE.test("Call me (after 5pm)"), false);
  assert.equal(RE.test("Price: 250,000 - 275,000"), false);
});

test("the guard runs before the provider call, not after", () => {
  // Ordering matters: a refusal has to happen while it is still a refusal. Once
  // the provider has accepted the message there is nothing left to block.
  const guardAt = providerSource.indexOf("UNRESOLVED_PLACEHOLDER_RE.test");
  const requestAt = providerSource.search(/await\s+fetch\s*\(/);
  assert.ok(guardAt > 0, "the guard must be applied, not merely defined");
  assert.ok(requestAt > 0, "the provider request must exist");
  assert.ok(guardAt < requestAt, "the placeholder guard must precede the provider request");
});

test("the blank-greeting guard still stands alongside it", () => {
  // These are different failures: a placeholder is a token we could not fill,
  // a blank greeting is a name we filled with nothing ("Hello ,").
  assert.ok(providerSource.includes("blank_seller_greeting"));
  assert.ok(providerSource.includes("BLANK_GREETING_RE.test"));
});
