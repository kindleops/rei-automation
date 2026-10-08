/**
 * outbound-persona-848.test.mjs — hotfix 8.4.8.
 *
 * 2026-10-08: ~75% of campaign targets have no master_owner_id; the owner
 * persona join found nothing and the feeder's HARDCODED literal fallback
 * signed them all "Alex". Owner decision: Alex is a legitimate persona —
 * sellers who already heard from Alex keep Alex — but the literal fallback
 * path is forbidden. Order: persona already shown on the thread -> campaign ->
 * master owner -> the existing master_owners distribution. Conflicts hold.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERSONA_CONFLICT,
  PERSONA_UNRESOLVED,
  agentNameForRow,
  distributionPersona,
  hydrateContextPersona,
  loadThreadPersonas,
  resolveOutboundPersona,
} from "@/lib/domain/outbound/outbound-persona.js";
import { PERSONA_DISTRIBUTION } from "@/lib/domain/outbound/outbound-persona-distribution.generated.js";
import { normalizeCandidateRow, renderOutboundTemplate } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import { buildNurtureRenderContext } from "@/lib/domain/seller-flow/nurture-render-context.js";
import { buildOutboundMergeValues } from "@/lib/domain/campaigns/outbound-agent-identity.js";
import { renderAcquisitionTemplate } from "@/lib/domain/acquisition/acquisition-template-service.js";

const OPENER = {
  id: "tpl-848-opener",
  template_id: "ownership-s1-848",
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  is_active: true,
  template_body: "Hey {seller_first_name}, this is {agent_name}. Do you still own {property_address}?",
};

const phoneFor = (i) => `+1${String(2025550000 + i * 37).slice(0, 10)}`;
const KNOWN_PERSONAS = new Set(Object.keys(PERSONA_DISTRIBUTION.all));

function candidateFor(i, extra = {}) {
  // The planner sets thread facts on the candidate AFTER normalization.
  const { thread_agent_personas, thread_persona_unreadable, ...row } = extra;
  const candidate = normalizeCandidateRow({
    display_name: "John Smith",
    canonical_e164: phoneFor(i),
    property_address_full: "10 Palm St, Tampa, FL 33601",
    property_address_state: "FL",
    touch_number: 1,
    template_use_case: "ownership_check",
    stage_code: "S1",
    ...row,
  });
  if (thread_agent_personas) candidate.thread_agent_personas = thread_agent_personas;
  if (thread_persona_unreadable) candidate.thread_persona_unreadable = true;
  return candidate;
}

async function render(candidate, options = {}) {
  return renderOutboundTemplate(candidate, options, {
    getRecentTemplateIds: async () => ({ ok: true, template_ids: [], errors: [] }),
    fetchSmsTemplates: async () => [OPENER],
  });
}

/** Minimal send_queue client: returns rows whose phone AND status match. */
function queueClient(rows = [], { fail = false } = {}) {
  return {
    from() {
      const filters = [];
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        in(col, vals) { filters.push([col, vals]); return chain; },
        order() { return chain; },
        limit() {
          if (fail) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: rows.filter((r) => filters.every(([c, v]) => v.includes(r[c]))), error: null });
        },
      };
      return chain;
    },
  };
}

test("the literal fallback path is gone: no owner, blank owner, family label -> a distribution persona", async () => {
  for (const [i, extra] of [[2, {}], [4, { agent_persona: "" }], [5, { agent_family: "Spanish Local" }], [8, { agent_persona: "   " }]]) {
    const r = await render(candidateFor(i, extra));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.agent_persona_source, "master_owners_distribution");
    assert.ok(KNOWN_PERSONAS.has(r.agent_persona), r.agent_persona);
    assert.match(r.rendered_message_body, new RegExp(`this is ${r.agent_first_name}\\.`));
    assert.doesNotMatch(r.rendered_message_body, /this is \.|this is (General|Spanish)/);
  }
  const owned = await render(candidateFor(6, { agent_persona: "Michael Hargrove" }));
  assert.match(owned.rendered_message_body, /this is Michael\./);
  assert.equal(owned.agent_persona_source, "master_owners.agent_persona");
});

test("the distribution is the existing master_owners assignment, chosen by a stable hash", () => {
  // "Alex" was never an owner assignment, so a FIRST touch never draws it.
  assert.equal(KNOWN_PERSONAS.has("Alex"), false);
  const counts = new Map();
  for (let i = 0; i < 2000; i += 1) {
    const r = resolveOutboundPersona({ stable_key: phoneFor(i), language: "English" });
    assert.equal(r.ok, true);
    counts.set(r.persona, (counts.get(r.persona) || 0) + 1);
  }
  assert.ok(counts.size > 5, "multi-persona, not one name");
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(top, "Helen Crawford", "mirrors the owner distribution (Helen is the most-assigned English persona)");
  assert.equal(resolveOutboundPersona({ stable_key: "(312) 555-0101" }).persona, resolveOutboundPersona({ stable_key: "+13125550101" }).persona, "one key per phone");
  assert.equal(distributionPersona("", "English"), null);
  assert.equal(resolveOutboundPersona({ stable_key: "" }).reason, PERSONA_UNRESOLVED, "no key -> no persona -> no render");
});

test("an established persona wins, Alex included; conflicting shown personas hold", () => {
  const key = "+13125550101";
  assert.equal(resolveOutboundPersona({ thread_persona: ["Alex"], owner_persona: "Helen Crawford", stable_key: key }).first_name, "Alex");
  assert.equal(resolveOutboundPersona({ thread_persona: "Carmen Rivera", owner_persona: "Helen Crawford", stable_key: key }).persona, "Carmen Rivera");
  const conflict = resolveOutboundPersona({ thread_persona: ["Alex", "Helen Crawford"], stable_key: key });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, PERSONA_CONFLICT);
  assert.equal(resolveOutboundPersona({ thread_persona: ["Helen", "Helen Crawford"], stable_key: key }).ok, true, "same first name is not a conflict");
});

test("continuity: opener -> auto-reply -> follow-up -> retry all reuse the shown persona", async () => {
  const phone = phoneFor(7);
  const opener = await render(candidateFor(7, { agent_persona: "Helen Crawford", thread_agent_personas: ["Alex"] }));
  assert.equal(opener.ok, true);
  assert.match(opener.rendered_message_body, /this is Alex\./, "an Alex conversation keeps Alex");

  const delivered = { to_phone_number: phone, queue_status: "delivered", agent_name: opener.agent_first_name, metadata: { agent_persona: opener.agent_persona }, message_body: opener.rendered_message_body };
  const client = queueClient([delivered]);
  assert.deepEqual((await loadThreadPersonas(client, [phone])).get(phone.slice(2)), ["Alex"]);

  const reply = await hydrateContextPersona({ supabase: client, context: { summary: { agent_name: "" } }, threadKey: phone });
  assert.equal(reply.summary.agent_name, "Alex");
  assert.equal(personalizeTemplate("Thanks, {{agent_name}} here again.", { agent_name: reply.summary.agent_name }).text, "Thanks, Alex here again.");

  const nurture = buildNurtureRenderContext({ known: { thread_key: phone }, sent_rows_newest_first: [{ ...delivered, agent_name: null, metadata: {} }] });
  assert.equal(nurture.agent_name, "Alex", "persona read from the delivered body itself");

  // A spam-recycled retry re-renders from the prior row: same persona.
  assert.equal(agentNameForRow({ ...delivered, queue_status: "failed" }), "Alex");

  // Only SHOWN rows establish a persona: a queued/failed row does not.
  const notShown = queueClient([{ ...delivered, queue_status: "failed" }]);
  assert.equal((await loadThreadPersonas(notShown, [phone])).size, 0);
});

test("fail closed: unreadable history, conflicts and missing keys render nothing", async () => {
  const unreadable = await hydrateContextPersona({ supabase: queueClient([], { fail: true }), context: { summary: {} }, threadKey: phoneFor(9) });
  assert.equal(unreadable.summary.agent_name, "");
  assert.equal(personalizeTemplate("Hi, this is {{agent_name}}.", unreadable.summary).ok, false);

  const held = await render(candidateFor(10, { thread_agent_personas: ["Alex", "Helen Crawford"] }));
  assert.equal(held.ok, false);
  assert.equal(held.reason_code, PERSONA_CONFLICT);
  assert.equal(held.rendered_message_body, null);

  const blind = await render(candidateFor(11, { thread_persona_unreadable: true }));
  assert.equal(blind.ok, false);
  assert.equal(blind.reason_code, PERSONA_UNRESOLVED);

  assert.equal(personalizeTemplate("Hi, this is {{agent_name}}.", { agent_name: "" }).ok, false, "a blank name never renders");
});

test("every other renderer: no literal fallback and no blank name", () => {
  const acq = renderAcquisitionTemplate({ template_body: "This is {{agent_first_name}} about {{property_address}}" }, { thread_key: "+13125550110" });
  assert.ok(acq && !/^This is  /.test(acq));
  assert.ok(KNOWN_PERSONAS.has([...KNOWN_PERSONAS].find((p) => acq.startsWith(`This is ${p.split(" ")[0]} `)) || ""), acq);
  assert.equal(renderAcquisitionTemplate({ template_body: "This is {{agent_first_name}}" }, {}), null, "no key -> no persona -> no render (was: 'Ryan')");

  const merge = buildOutboundMergeValues({ target: { to_phone_number: "+13125550111", metadata: { candidate_snapshot: {} } }, masterOwner: null });
  assert.equal(merge.ok, true, "no master owner is no longer an identity failure");
  assert.ok(KNOWN_PERSONAS.has(merge.persona));
  assert.equal(buildOutboundMergeValues({ target: { metadata: {} }, masterOwner: null }).reason, PERSONA_UNRESOLVED);
});

test("no hardcoded persona fallback literal remains in apps/api/src", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(m?js|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const code = (await readFile(full, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
        // `|| "Alex"` / `pick(..., "Alex")` / `|| "Ryan"`: a literal name used as a default value.
        if (/(\|\||\?\?|,)\s*["'`](Alex|Ryan)["'`]/.test(code)) offenders.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  assert.deepEqual(offenders, []);
});
