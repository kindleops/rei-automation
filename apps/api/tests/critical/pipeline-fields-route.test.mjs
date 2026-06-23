import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const fieldsRouteUrl = new URL("../../src/app/api/cockpit/pipeline/fields/route.js", import.meta.url);
const pipelineSharedUrl = new URL("../../src/app/api/cockpit/pipeline/_shared.js", import.meta.url);

test("pipeline fields route imports pipeline shared module", async () => {
  const source = await fs.readFile(fieldsRouteUrl, "utf8");
  assert.match(source, /from '\.\.\/_shared\.js'/);
  assert.doesNotMatch(source, /from '\.\.\/\.\.\/_shared\.js'/);
});

test("pipeline shared exports unauthorizedJson helper", async () => {
  const source = await fs.readFile(pipelineSharedUrl, "utf8");
  assert.match(source, /export function unauthorizedJson/);
});