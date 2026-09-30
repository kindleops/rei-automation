/**
 * campaign-owner-persona.test.mjs
 *
 * 652 campaign texts said "this is Alex" (2026-09-19..30): the campaign planner
 * never passed the owner's persona (master_owners.agent_persona) to the
 * renderer, so it fell back to the feeder's literal default, even for owners
 * whose record names "Michael Hargrove" or "Nathan Brooks".
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyOwnerPersona,
  launchCandidateFromTarget,
  loadOwnerPersonas,
} from "@/lib/domain/campaigns/campaign-automation-service.js";

function ownersClient(rows, { failWith = null, throwOnIn = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, "master_owners");
      return {
        select(columns) {
          assert.equal(columns, "master_owner_id,agent_persona");
          return {
            in(column, ids) {
              if (throwOnIn) throw new Error("boom");
              assert.equal(column, "master_owner_id");
              calls.push(ids);
              if (failWith) return Promise.resolve({ data: null, error: failWith });
              return Promise.resolve({ data: rows.filter((row) => ids.includes(String(row.master_owner_id))), error: null });
            },
          };
        },
      };
    },
  };
}

test("personas come from the owner records, batched and de-duplicated", async () => {
  const rows = [
    { master_owner_id: "101", agent_persona: "Michael Hargrove" },
    { master_owner_id: "102", agent_persona: "Nathan Brooks" },
    { master_owner_id: "103", agent_persona: "" },
  ];
  const client = ownersClient(rows);
  const personas = await loadOwnerPersonas(client, ["101", "102", "101", null, "", "103", "999"], { chunkSize: 2 });
  assert.equal(personas.get("101"), "Michael Hargrove");
  assert.equal(personas.get("102"), "Nathan Brooks");
  assert.equal(personas.has("103"), false, "a blank persona is not a persona");
  assert.equal(personas.has("999"), false);
  assert.deepEqual(client.calls, [["101", "102"], ["103", "999"]], "unique ids, chunked");
});

test("a failed read degrades to the old behaviour instead of holding the plan", async () => {
  assert.equal((await loadOwnerPersonas(ownersClient([], { failWith: { message: "timeout" } }), ["1"])).size, 0);
  assert.equal((await loadOwnerPersonas(ownersClient([], { throwOnIn: true }), ["1"])).size, 0);
});

test("the owner's persona reaches the render candidate; an explicit one is never overwritten", () => {
  const personas = new Map([["101", "Michael Hargrove"]]);
  const candidate = launchCandidateFromTarget(
    { master_owner_id: "101", prospect_id: "p1", to_phone_number: "+16125550100", timezone: "Central" },
    { id: "c1", metadata: {} },
  );
  assert.equal(applyOwnerPersona(candidate, personas).agent_persona, "Michael Hargrove");

  const explicit = { master_owner_id: "101", agent_persona: "Helen Crawford" };
  assert.equal(applyOwnerPersona(explicit, personas).agent_persona, "Helen Crawford");

  const unlinked = { master_owner_id: null };
  assert.equal(applyOwnerPersona(unlinked, personas).agent_persona, undefined, "no owner record -> no invented persona");
});

test("the planner applies owner personas, and the renderer reads agent_persona first", async () => {
  const service = await readFile(new URL("../../src/lib/domain/campaigns/campaign-automation-service.js", import.meta.url), "utf8");
  assert.match(service, /const candidate = applyOwnerPersona\(launchCandidateFromTarget\(target, campaign\), ownerPersonas\)/);
  assert.match(service, /agent_name: clean\(campaign\.agent_persona\) \|\| clean\(candidate\.agent_persona\) \|\| null/);

  const feeder = await readFile(new URL("../../src/lib/domain/outbound/supabase-candidate-feeder.js", import.meta.url), "utf8");
  const chain = feeder.slice(feeder.indexOf("const agent_name_raw = clean("));
  assert.match(chain, /pick\(\s*candidate\.agent_persona,/, "persona is the first source the renderer consults");
});
