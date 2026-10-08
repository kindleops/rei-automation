// 8.4.8 (owner 2026-10-08): a language mismatch ("I don't speak Spanish" to a
// Spanish opener, "I cannot speak Arabic" to an Arabic one) is answered
// automatically in English, repeating the ORIGINAL question, signed with the
// persona the seller already saw (Alex included). No restart, no new question,
// no human review for a straightforward mismatch.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { extractSignedPersonaName } from "@/lib/domain/outbound/outbound-persona.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../fixtures/reply-quality/${name}`, import.meta.url), "utf8"));
const CASES = read("2026-10-05to06-all-inbound.json").cases;
const CATALOG = read("2026-10-06-safe-templates-en-es.json").rows;
const byId = (id) => CASES.find((c) => c.fixture_id.endsWith(`-${id}`));
const replyText = (r) => {
  const m = JSON.stringify(r.result).match(/"(?:message_body|message_text|rendered_message|rendered_text|body|message)":"([^"]{20,})"/);
  return m ? m[1] : "";
};

for (const [id, persona, opener_language] of [["296", "Alex", "Spanish"], ["140", "Michael", "Arabic"]]) {
  test(`language switch #${id} (${opener_language} opener) -> English ownership question, persona ${persona} kept`, async () => {
    const c = byId(id);
    assert.ok(c, `fixture ${id}`);
    const r = await replayReply(c, { catalog: CATALOG });
    assert.equal(r.outcome, "auto_reply");
    assert.equal(r.template?.use_case, "ownership_check", "same question as the opener");
    assert.equal(r.template?.language, "English");
    const text = replyText(r);
    assert.match(text, new RegExp(`\\bthis is ${persona}\\b`), `signed ${persona}: ${text}`);
    assert.match(text, /own\b/i, "repeats the ownership question");
  });
}

test("signature extraction recognises every language our templates sign in, never streets or seller names", () => {
  const cases = [
    ["Marhaba Pat, ana Michael. Astathmir fi Van Nuys.", "Michael"],
    ["Hola Pat, soy Alex. Invierto en Los Angeles.", "Alex"],
    ["Bonjour Pat, Helen ici.", "Helen"],
    ["Pat, je suis Greg.", "Greg"],
    ["Hallo Pat, Nathan hier.", "Nathan"],
    ["Pat, main Kevin hoon.", "Kevin"],
    ["Konnichiwa Pat, Jake desu.", "Jake"],
    ["Pat, wo shi Sean.", "Sean"],
    ["Chào Pat, Minh đây.", "Minh"],
    ["Hey James, this is Carlos. Do you own it?", "Carlos"],
    ["Still interested in 1 Main St? Let me know.", null],
    ["Hi Ana, do you still own 22 Oak Ave?", null],
  ];
  for (const [body, want] of cases) assert.equal(extractSignedPersonaName(body), want, body);
});
