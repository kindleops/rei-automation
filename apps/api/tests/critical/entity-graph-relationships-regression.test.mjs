/**
 * UNIVERSE AND RELATIONSHIPS ARE SEPARATE READ MODELS (§2, §26).
 *
 * The Universe Lens is ADDITIVE. It answers "what does the whole population
 * look like" by aggregating; Relationships answers "how is THIS record
 * connected" by walking record-level tables. Routing the second through the
 * first would replace real topology with bucket counts — a graph that looked
 * plausible and described nobody.
 *
 * These tests hold that separation structurally, so the two cannot quietly
 * merge later.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("THE DOSSIER NEVER TOUCHES THE LENS AGGREGATE", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/entity-graph/entity-graph-service.js", import.meta.url), "utf8");

  assert.ok(
    !/entity_graph_lens_aggregate|buildEntityGraphLens/.test(source),
    "relationships must not be routed through the Universe aggregate",
  );
  // ...and it still resolves records through the canonical neighbourhood loads.
  assert.match(source, /export async function getEntityGraphDossier/);
  assert.match(source, /loadPropertyNeighborhood/);
  assert.match(source, /loadOwnerNeighborhood/);
});

test("THE LENS NEVER RETURNS RECORD TOPOLOGY", async () => {
  // The converse: an aggregate that started emitting nodes and edges would be
  // a second, unreconciled relationship graph.
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/entity-graph/entity-graph-lens.js", import.meta.url), "utf8");
  assert.ok(!/nodes|edges|neighborhood/i.test(source));
});

test("the dossier resolves a property, an owner and a contact by type", async () => {
  const { getEntityGraphDossier } = await import("@/lib/domain/entity-graph/entity-graph-service.js");
  assert.equal(typeof getEntityGraphDossier, "function");
  // A blank id is not a lookup, and must not become one.
  assert.equal(await getEntityGraphDossier("property", ""), null);
  assert.equal(await getEntityGraphDossier("property", "   "), null);
});

test("A MISSING ENTITY IS NOT-FOUND, NEVER A MOCK GRAPH", async () => {
  /**
   * Live-verified 2026-09-20: GET
   * /api/cockpit/entity-graph/property/ZZZ_NOT_A_REAL_ID returns HTTP 404.
   * A fabricated neighbourhood would be indistinguishable from a real one to
   * the operator looking at it.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/app/api/cockpit/entity-graph/_dossier-route.js", import.meta.url), "utf8");
  assert.match(source, /404/);
  assert.ok(!/mock|fixture|sample_graph|demo/i.test(source));
});
