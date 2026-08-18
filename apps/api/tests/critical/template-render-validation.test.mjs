import assert from "node:assert/strict";
import test from "node:test";

import {
  RENDER_FAILURE,
  canDetermineOutboundContent,
  renderTemplateBody,
  requiredMergeFields,
} from "@/lib/domain/campaigns/template-render-validation.js";

// The exact bodies of the current canary-eligible templates.
const SPANISH_201362 =
  "Hola {{seller_first_name}}, {{agent_name}} aqui. Pregunta rapida. Sigues siendo el dueno de {{property_address}}?";
const SPANISH_200002 =
  "Hola {{seller_first_name}}, soy {{agent_name}}. Todavia eres el dueno de {{property_address}}?";

test("required merge fields are extracted in order, without duplicates", () => {
  assert.deepEqual(requiredMergeFields(SPANISH_201362), [
    "seller_first_name",
    "agent_name",
    "property_address",
  ]);
  assert.deepEqual(requiredMergeFields("{{a}} {{a}} {{b}}"), ["a", "b"]);
  assert.deepEqual(requiredMergeFields(""), []);
});

test("a fully supplied template renders", () => {
  const result = renderTemplateBody(SPANISH_200002, {
    seller_first_name: "Veronica",
    agent_name: "Ryan",
    property_address: "1347 W 99th St, Los Angeles, CA 90044",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.body,
    "Hola Veronica, soy Ryan. Todavia eres el dueno de 1347 W 99th St, Los Angeles, CA 90044?"
  );
});

test("the live defect — agent_name unresolved — fails closed", () => {
  // agent_name resolves through a chain ending in "" and is NULL on every LA
  // row ever sent. Without this guard the body ships as "Hola Rodolfo,  aqui."
  const result = renderTemplateBody(SPANISH_201362, {
    seller_first_name: "Rodolfo",
    agent_name: "",
    property_address: "618 Hoefner Ave, Los Angeles, CA 90022",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, RENDER_FAILURE.MISSING_VALUE);
  assert.deepEqual(result.missing, ["agent_name"]);
});

test("null and undefined merge values are absences, not values", () => {
  for (const value of [null, undefined]) {
    const result = renderTemplateBody(SPANISH_200002, {
      seller_first_name: "Elsie",
      agent_name: value,
      property_address: "1928 Browning Blvd",
    });
    assert.equal(result.ok, false, `agent_name=${String(value)} must fail`);
    assert.deepEqual(result.missing, ["agent_name"]);
  }
});

test("a whitespace-only value does not satisfy a merge field", () => {
  // "   " is truthy in JS. Accepting it is precisely how a blank lands
  // mid-sentence with no guard tripping.
  const result = renderTemplateBody(SPANISH_201362, {
    seller_first_name: "Juan",
    agent_name: "   ",
    property_address: "1026 E 57th St",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["agent_name"]);
});

test("a blank greeting can never be produced", () => {
  const result = renderTemplateBody(SPANISH_200002, {
    seller_first_name: "",
    agent_name: "Ryan",
    property_address: "1051 Westside Dr",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["seller_first_name"]);
});

test("every missing field is reported, not just the first", () => {
  const result = renderTemplateBody(SPANISH_201362, { property_address: "1 Main St" });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["seller_first_name", "agent_name"]);
});

test("a token surviving substitution refuses the send", () => {
  // A value that itself contains a token would otherwise ship braces to a
  // seller.
  const result = renderTemplateBody("Hi {{seller_first_name}}", {
    seller_first_name: "{{agent_name}}",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, RENDER_FAILURE.UNRESOLVED_TOKEN);
});

test("tokens with inner whitespace are still recognised", () => {
  assert.deepEqual(requiredMergeFields("Hi {{ seller_first_name }}"), ["seller_first_name"]);

  const result = renderTemplateBody("Hi {{ seller_first_name }}", { seller_first_name: "Ana" });
  assert.equal(result.ok, true);
  assert.equal(result.body, "Hi Ana");
});

test("an empty template body is not renderable", () => {
  assert.equal(renderTemplateBody("", {}).reason, RENDER_FAILURE.EMPTY_TEMPLATE);
  assert.equal(renderTemplateBody("   ", {}).reason, RENDER_FAILURE.EMPTY_TEMPLATE);
});

test("a template with no tokens renders unchanged", () => {
  const body = "Are you still the owner? Reply STOP to opt out.";
  const result = renderTemplateBody(body, {});

  assert.equal(result.ok, true);
  assert.equal(result.body, body);
  assert.deepEqual(result.required, []);
});

test("auditability gate mirrors renderability", () => {
  const values = {
    seller_first_name: "David",
    agent_name: "Ryan",
    property_address: "1051 Westside Dr",
  };

  assert.equal(canDetermineOutboundContent(SPANISH_201362, values), true);
  assert.equal(
    canDetermineOutboundContent(SPANISH_201362, { ...values, agent_name: null }),
    false
  );
});
