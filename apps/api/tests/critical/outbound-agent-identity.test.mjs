import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_IDENTITY_FAILURE,
  AGENT_IDENTITY_SOURCE,
  buildOutboundMergeValues,
  resolveAgentIdentity,
} from "@/lib/domain/campaigns/outbound-agent-identity.js";
import { renderTemplateBody } from "@/lib/domain/campaigns/template-render-validation.js";

const SPANISH_201362 =
  "Hola {{seller_first_name}}, {{agent_name}} aqui. Pregunta rapida. Sigues siendo el dueno de {{property_address}}?";

const target = (over = {}) => ({
  id: "0cc25ba6-353f-4fa8-beeb-d0471c324a79",
  property_address: "618 Hoefner Ave, Los Angeles, Ca 90022",
  metadata: { candidate_snapshot: { seller_first_name: "Rodolfo" } },
  ...over,
});

const owner = (persona) => ({ master_owner_id: "mo-1", agent_persona: persona });

// ── the contract ──────────────────────────────────────────────────────────

test("agent_name is the first name of master_owners.agent_persona", () => {
  // The production rule: 423/423 historical sends match
  // split_part(agent_persona, ' ', 1).
  const resolved = resolveAgentIdentity(owner("Carmen Rivera"));

  assert.equal(resolved.ok, true);
  assert.equal(resolved.agent_name, "Carmen");
  assert.equal(resolved.persona, "Carmen Rivera");
  assert.equal(resolved.source, AGENT_IDENTITY_SOURCE);
});

test("a single-word persona is used as-is", () => {
  assert.equal(resolveAgentIdentity(owner("Alex")).agent_name, "Alex");
});

test("irregular whitespace in a persona cannot produce a padded or empty name", () => {
  assert.equal(resolveAgentIdentity(owner("  Carlos   Mendez  ")).agent_name, "Carlos");
});

test("a missing owner fails closed", () => {
  for (const value of [null, undefined, "not an object"]) {
    const resolved = resolveAgentIdentity(value);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, AGENT_IDENTITY_FAILURE.NO_OWNER);
  }
});

test("a missing or blank persona fails closed — there is no default identity", () => {
  for (const persona of [null, undefined, "", "   "]) {
    const resolved = resolveAgentIdentity(owner(persona));
    assert.equal(resolved.ok, false, `persona ${JSON.stringify(persona)} must not resolve`);
    assert.equal(resolved.reason, AGENT_IDENTITY_FAILURE.NO_PERSONA);
  }
});

test("a persona with no usable name fails closed rather than rendering punctuation", () => {
  const resolved = resolveAgentIdentity(owner("   -   "));

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, AGENT_IDENTITY_FAILURE.UNUSABLE_PERSONA);
});

test("no fallback identity is ever substituted", () => {
  // Guards against a future edit reintroducing a company name, a placeholder,
  // or a default operator to make rendering succeed.
  const resolved = resolveAgentIdentity(owner(""));

  assert.equal(resolved.ok, false);
  assert.equal(resolved.agent_name, undefined);
});

// ── merge values ──────────────────────────────────────────────────────────

test("merge values assemble from the target and its owner", () => {
  const result = buildOutboundMergeValues({ target: target(), masterOwner: owner("Carmen Rivera") });

  assert.equal(result.ok, true);
  assert.deepEqual(result.values, {
    agent_name: "Carmen",
    seller_first_name: "Rodolfo",
    property_address: "618 Hoefner Ave, Los Angeles, Ca 90022",
  });
});

test("no persona means no merge values at all", () => {
  const result = buildOutboundMergeValues({ target: target(), masterOwner: owner(null) });

  assert.equal(result.ok, false);
  assert.equal(result.reason, AGENT_IDENTITY_FAILURE.NO_PERSONA);
  assert.equal(result.values, undefined);
});

test("a target with no candidate snapshot yields a blank seller name, which render then rejects", () => {
  // Identity resolves, but the body must still fail closed downstream. The two
  // guards are independent and both have to hold.
  const result = buildOutboundMergeValues({
    target: target({ metadata: {} }),
    masterOwner: owner("Carlos Mendez"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.values.seller_first_name, "");

  const rendered = renderTemplateBody(SPANISH_201362, result.values);
  assert.equal(rendered.ok, false);
  assert.deepEqual(rendered.missing, ["seller_first_name"]);
});

// ── preflight / send-time parity ──────────────────────────────────────────

test("preflight and send-time renders are byte-identical", () => {
  // Both paths call the same constructor over the same rows. This is the
  // property that makes an operator's preflight approval meaningful.
  const t = target();
  const o = owner("Carmen Rivera");

  const preflight = buildOutboundMergeValues({ target: t, masterOwner: o });
  const sendTime = buildOutboundMergeValues({ target: t, masterOwner: o });

  assert.deepEqual(preflight.values, sendTime.values);

  const a = renderTemplateBody(SPANISH_201362, preflight.values);
  const b = renderTemplateBody(SPANISH_201362, sendTime.values);

  assert.equal(a.ok, true);
  assert.equal(a.body, b.body);
  assert.equal(
    a.body,
    "Hola Rodolfo, Carmen aqui. Pregunta rapida. Sigues siendo el dueno de 618 Hoefner Ave, Los Angeles, Ca 90022?"
  );
});

test("resolution is deterministic across repeated calls", () => {
  const o = owner("Carlos Mendez");
  const runs = Array.from({ length: 25 }, () => resolveAgentIdentity(o).agent_name);

  assert.equal(new Set(runs).size, 1);
  assert.equal(runs[0], "Carlos");
});

test("identity depends only on the owner, not the campaign, template or sender", () => {
  // Sender ••9881 has historically carried six different agent names. Identity
  // must therefore not be derived from the sending number.
  const o = owner("Carmen Rivera");

  const viaCampaignA = buildOutboundMergeValues({
    target: target({ campaign_id: "A", from_phone_number: "+13105550001" }),
    masterOwner: o,
  });
  const viaCampaignB = buildOutboundMergeValues({
    target: target({ campaign_id: "B", from_phone_number: "+13105559999" }),
    masterOwner: o,
  });

  assert.equal(viaCampaignA.values.agent_name, viaCampaignB.values.agent_name);
});

test("the live blank-render defect is now impossible", () => {
  // Podio-sourced agent_name resolved to "" and shipped "Hola Rodolfo,  aqui."
  // With no persona, there are no merge values, so nothing can render.
  const result = buildOutboundMergeValues({ target: target(), masterOwner: owner("") });
  assert.equal(result.ok, false);

  // And if a caller forced a blank through anyway, render still refuses.
  const forced = renderTemplateBody(SPANISH_201362, {
    seller_first_name: "Rodolfo",
    agent_name: "",
    property_address: "618 Hoefner Ave",
  });
  assert.equal(forced.ok, false);
  assert.deepEqual(forced.missing, ["agent_name"]);
});
