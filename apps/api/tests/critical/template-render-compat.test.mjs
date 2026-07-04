import test from "node:test";
import assert from "node:assert/strict";

import { renderTemplate, evaluateTemplatePlaceholders } from "@/lib/domain/templates/render-template.js";

test("renderTemplate replaces legacy single-brace placeholders", () => {
  const result = renderTemplate({
    template_text:
      "Hi, this is {agent_first_name}. Quick question — are you the owner of {property_address}?",
    context: {
      summary: {
        agent_name: "Ryan Kindle",
        property_address: "2717 S 124TH EAST AVE",
      },
    },
  });

  assert.equal(
    result.rendered_text,
    "Hi, this is Ryan. Quick question — are you the owner of 2717 S 124TH EAST AVE?"
  );
});

test("renderTemplate still replaces double-brace placeholders", () => {
  const result = renderTemplate({
    template_text:
      "Hi, this is {{agent_first_name}}. Quick question — are you the owner of {{property_address}}?",
    context: {
      summary: {
        agent_name: "Ryan Kindle",
        property_address: "2717 S 124TH EAST AVE",
      },
    },
  });

  assert.equal(
    result.rendered_text,
    "Hi, this is Ryan. Quick question — are you the owner of 2717 S 124TH EAST AVE?"
  );
});

test("renderTemplate agent aliases render first name only", () => {
  const result = renderTemplate({
    template_text:
      "{{agent_name}}/{{agent_first_name}}/{{sms_agent_name}}/{{sender_name}}/{{rep_name}}",
    context: {
      summary: {
        agent_name: "Helen Marie Carter",
        agent_first_name: "Helen Marie Carter",
      },
    },
  });

  assert.equal(result.rendered_text, "Helen/Helen/Helen/Helen/Helen");
});

test("renderTemplate maps legacy Stage 1 first_name and street_address placeholders to seller data", () => {
  const result = renderTemplate({
    template_text:
      "Hi {{first_name}}, checking on {{street_address}}. Do you still own it?",
    use_case: "ownership_check",
    context: {
      summary: {
        seller_first_name: "Maria",
        property_address: "123 Main St",
        agent_name: "Ryan Kindle",
      },
    },
  });

  assert.equal(
    result.rendered_text,
    "Hi Maria, checking on 123 Main St. Do you still own it?"
  );
});

// Launch blocker: Master Owner / entity names must never populate seller_first_name
// or be sent out as the greeting recipient name.
test("renderTemplate never derives seller_first_name from an entity-shaped owner_name", () => {
  const result = renderTemplate({
    template_text: "Hi {{first_name}}, checking on {{street_address}}. Do you still own it?",
    use_case: "ownership_check",
    context: {
      summary: {
        owner_name: "West 7th Apartments LLC",
        property_address: "2246 7th St W",
      },
    },
  });

  assert.equal(result.variables.seller_first_name, "");
  assert.equal(result.ok, false);
  assert.ok(!result.rendered_text.includes("West"));
});

test("renderTemplate falls back to a safe greeting when only an entity owner_name is available", () => {
  const result = renderTemplate({
    template_text: "Hi {{first_name}}, checking on {{street_address}}. Do you still own it?",
    use_case: "ownership_check",
    context: {
      summary: {
        owner_name: "D & D Divide LLC",
        property_address: "100 Main St",
      },
    },
  });

  assert.equal(result.rendered_text, "Hi, checking on 100 Main St. Do you still own it?");
  assert.ok(!result.rendered_text.includes("Divide"));
  assert.equal(result.ok, false);
});

test("evaluateTemplatePlaceholders rejects a rendered preview whose greeting resolves to an entity name", () => {
  const evaluation = evaluateTemplatePlaceholders({
    template_text: "Hey {{first_name}}, is this still your property at {{street_address}}?",
    use_case: "ownership_check",
    context: {
      summary: {
        seller_first_name: "West 7th Apartments LLC",
        property_address: "2246 7th St W",
      },
    },
  });

  assert.equal(evaluation.safety_violations.has_entity_greeting, true);
  assert.equal(evaluation.ok, false);
});

test("evaluateTemplatePlaceholders accepts a real human first name in the greeting", () => {
  const evaluation = evaluateTemplatePlaceholders({
    template_text: "Hey {{first_name}}, is this still your property at {{street_address}}?",
    use_case: "ownership_check",
    context: {
      summary: {
        seller_first_name: "Maria",
        property_address: "2246 7th St W",
      },
    },
  });

  assert.equal(evaluation.safety_violations.has_entity_greeting, false);
});
