/**
 * PII scrubber for external-model audits (scripts/llm-audit/scrub.mjs).
 * Adversarial cases: every phone shape, e-mail obfuscations, addresses with
 * units / directionals / PO boxes / rural routes, record names (case, accents,
 * possessives, common-word names), relatives, signatures, our sender names.
 * Each case asserts the PII is gone AND the seller's meaning (prices, intent
 * words) survives. Known residual gaps are pinned at the bottom.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scrub, detectResidualPII, assertScrubbed, nameTokens } from "../../scripts/llm-audit/scrub.mjs";

const gone = (out, ...needles) => {
  for (const n of needles) assert.ok(!out.toLowerCase().includes(String(n).toLowerCase()), `"${n}" survived in: ${out}`);
};
const kept = (out, ...needles) => {
  for (const n of needles) assert.ok(out.includes(n), `"${n}" was lost in: ${out}`);
};

// ── phones ──────────────────────────────────────────────────────────────────
for (const [text, digits] of [
  ["call me 555-867-5309", "867"],
  ["Call (555) 867-5309 anytime", "867"],
  ["my cell is 555.867.5309", "867"],
  ["5558675309", "5558675309"],
  ["+1 555 867 5309", "867"],
  ["+15558675309", "5558675309"],
  ["1-555-867-5309 ext 22", "867"],
  ["text 555 867 5309 instead", "867"],
  ["(555)867-5309", "867"],
  ["reach him at 867-5309", "867"],
  ["５５５-８６７-５３０９ full width", "５３０９"],
  ["5 5 5 8 6 7 5 3 0 9", "5 3 0 9"],
  ["His number:555–867–5309.", "867"],
  ["call5558675309now", "5558675309"],
  ["+44 20 7946 0958 (UK)", "7946"],
  ["555/867/5309", "867"],
]) {
  test(`phone scrubbed: ${JSON.stringify(text)}`, () => {
    const out = scrub(text);
    gone(out, digits);
    assert.match(out, /<PHONE>/);
  });
}

for (const text of ["I want $1500000 for it", "asking 250k", "$250,000 firm", "1.5 million", "2019-2020 roof", "built in 1985", "it has 3 bedrooms 2 baths", "I'd take 150000 dollars"]) {
  test(`money / years survive phone scrub: ${JSON.stringify(text)}`, () => {
    assert.equal(scrub(text), text);
  });
}

// ── e-mail ──────────────────────────────────────────────────────────────────
for (const text of [
  "email me at john.doe+house@gmail.com",
  "JOHN_DOE@Sub.Example.CO.uk",
  "john dot doe at gmail dot com",
  "johndoe (at) yahoo (dot) com",
  "jdoe[at]outlook[dot]com",
  "write jdoe at gmail",
  "maria.lópez@correo.mx",
]) {
  test(`email scrubbed: ${JSON.stringify(text)}`, () => {
    const out = scrub(text);
    assert.match(out, /<EMAIL>/);
    gone(out, "doe", "jdoe", "lópez", "johndoe");
  });
}

// ── addresses ───────────────────────────────────────────────────────────────
for (const [text, needles] of [
  ["I own 606 Winterbrooke Way", ["606", "Winterbrooke"]],
  ["123 Main St Apt 4B is mine", ["123", "Main", "4B"]],
  ["4021 W 23rd St #5", ["4021", "23rd", "#5"]],
  ["742 Evergreen Terrace, Springfield, IL 62704", ["742", "Evergreen", "62704"]],
  ["1600 Pennsylvania Avenue NW, Washington, DC 20500", ["1600", "Pennsylvania", "20500"]],
  ["mail it to P.O. Box 1234", ["1234"]],
  ["it's on County Road 12", ["County Road 12"]],
  ["RR 2 Box 55", ["RR 2", "Box 55"]],
  ["12-B Oak Ln unit 3", ["12-B", "Oak Ln", "unit 3"]],
  ["I live at 1234 Elmwood", ["1234", "Elmwood"]],
  ["Calle Sol 123 interior 4", ["Calle Sol", "123"]],
  ["Avenida Juárez #45", ["Juárez", "#45"]],
  ["the house at 55 N. Cedar Hollow Rd. Suite 200", ["55", "Cedar Hollow", "200"]],
  ["zip code 38106", ["38106"]],
  ["123 Martin Luther King Jr Blvd", ["123", "Martin Luther King"]],
]) {
  test(`address scrubbed: ${JSON.stringify(text)}`, () => {
    const out = scrub(text);
    assert.match(out, /<ADDR>/);
    gone(out, ...needles);
  });
}

test("record address: full, street line and bare street name", () => {
  const addresses = ["606 Winterbrooke Way, Dallas, TX 75201"];
  const out = scrub("Is this about Winterbrooke? I sold 606 winterbrooke way last year", { addresses });
  gone(out, "winterbrooke", "606");
  kept(out, "sold", "last year");
});

for (const text of ["it has 3 bedrooms", "I want 150 for it", "2 units both rented", "over 20 years", "1200 sq ft", "$5 million", "100 Times no"]) {
  test(`non-address numbers survive: ${JSON.stringify(text)}`, () => {
    assert.equal(scrub(text), text);
  });
}

// ── names from our records ──────────────────────────────────────────────────
const RECORD = { names: ["JOHNSON MARIA & JOSE", "Maria Johnson", "José Johnson"], agentNames: ["Alex"] };

test("record names: case-insensitive, possessive, accent-insensitive", () => {
  const out = scrub("maria johnson here. Maria's husband Jose says no. JOHNSON family", RECORD);
  gone(out, "maria", "johnson", "jose");
  kept(out, "says no");
});

test("record name with accents in text but not in records (and back)", () => {
  gone(scrub("José says no", { names: ["Jose Ruiz"] }), "jos");
  gone(scrub("Jose says no", { names: ["José Ruiz"] }), "jose");
});

test("our sender (agent) first name is scrubbed", () => {
  const out = scrub("Hi Alex, not interested", RECORD);
  gone(out, "alex");
  kept(out, "not interested");
});

test("common-word record names are scrubbed only when capitalized", () => {
  const out = scrub("Will says I will not sell, Rose agrees the rose bush stays", { names: ["Will Rose"] });
  assert.equal(out, "<NAME> says I will not sell, <NAME> agrees the rose bush stays");
});

test("entity / trust name tokens", () => {
  assert.deepEqual(nameTokens("SMITH FAMILY REVOCABLE TRUST"), ["SMITH"]);
  gone(scrub("the Smith trust owns it", { names: ["SMITH FAMILY REVOCABLE TRUST"] }), "smith");
});

// ── relatives, cues, signatures (names NOT in our records) ──────────────────
for (const [text, needle] of [
  ["Talk to my daughter Maria", "Maria"],
  ["my son, Jose, handles it", "Jose"],
  ["Maria is my daughter", "Maria"],
  ["mi hijo José se encarga", "José"],
  ["my wife Linda Kay owns half", "Linda"],
  ["her husband's name is Robert", "Robert"],
  ["My name is Derrick and I own it", "Derrick"],
  ["This is Tamika", "Tamika"],
  ["Soy Guadalupe", "Guadalupe"],
  ["ask for Clarence", "Clarence"],
  ["His name is Terrence Wallace", "Terrence"],
  ["Not Shirley!", "Shirley"],
  ["no soy Dan", "Dan"],
  ["Hi Bob, not for sale", "Bob"],
  ["Hola Lupita, no gracias", "Lupita"],
  ["Not interested. Thanks, Darnell", "Darnell"],
  ["No thank you\nRegina Mays", "Regina"],
  ["not selling - Carol", "Carol"],
  ["Note: Not for sell, thanks for checking ***Bernadette***", "Bernadette"],
  ["Atentamente, Juan Pérez", "Pérez"],
  ["Bob and I own it", "Bob"],
  ["it belongs to Earline now", "Earline"],
]) {
  test(`cued name scrubbed: ${JSON.stringify(text)}`, () => {
    const out = scrub(text);
    gone(out, needle);
    assert.match(out, /<NAME>/);
  });
}

for (const text of ["Not interested", "Yes", "No it isn't", "Stop", "This is not for sale", "I am not selling", "Thanks", "Hi, who is this?", "Not for sale. Thank you!", "Talk to you later"]) {
  test(`no false name scrub: ${JSON.stringify(text)}`, () => {
    assert.equal(scrub(text), text);
  });
}

// ── residual gate ───────────────────────────────────────────────────────────
test("detectResidualPII flags leftovers and passes clean text", () => {
  assert.ok(detectResidualPII("call 555 867 5309").includes("phone"));
  assert.ok(detectResidualPII("x@y.com").includes("email"));
  assert.ok(detectResidualPII("123 Oak Street").includes("street_address"));
  assert.ok(detectResidualPII("ask Maria", { names: ["Maria Lopez"] }).includes("record_name"));
  assert.deepEqual(detectResidualPII(scrub("ask Maria at 555-867-5309, 123 Oak St", { names: ["Maria Lopez"] }), { names: ["Maria Lopez"] }), []);
  assert.throws(() => assertScrubbed("555-867-5309"), /residual PII/);
});

test("scrub is idempotent", () => {
  const once = scrub("Hi Alex, my daughter Maria (555-867-5309) lives at 123 Main St Apt 2", RECORD);
  assert.equal(scrub(once, RECORD), once);
});

// ── documented residual risk (pinned so a change is noticed) ────────────────
test("RESIDUAL: an uncued lowercase name not in our records survives", () => {
  assert.equal(scrub("tell bob i said no"), "tell bob i said no");
});
test("RESIDUAL: a phone number spelled in words survives", () => {
  assert.equal(scrub("five five five eight six seven five three oh nine"), "five five five eight six seven five three oh nine");
});
test("RESIDUAL: a city name is not scrubbed", () => {
  assert.equal(scrub("I live in Panama City"), "I live in Panama City");
});
