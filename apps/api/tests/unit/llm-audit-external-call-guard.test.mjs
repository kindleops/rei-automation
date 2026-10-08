import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoHold,
  assertRequestsScrubbed,
  estimateRequestCostUsd,
  HOLD_FILE_NAME,
  ledgerTotal,
  reserveOrThrow,
  settle,
} from "../../scripts/llm-audit/external-call-guard.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "llm-guard-"));
const req = (text, id = "R1") => ({ custom_id: id, params: { model: "m", max_tokens: 100, system: "sys", messages: [{ role: "user", content: text }] } });

test("owner hold file blocks every call", () => {
  const d = dir();
  assert.doesNotThrow(() => assertNoHold(d));
  writeFileSync(join(d, HOLD_FILE_NAME), "owner order");
  assert.throws(() => assertNoHold(d), /owner hold/);
});

test("requests with residual PII are refused before sending", () => {
  assert.ok(assertRequestsScrubbed([req("Reply: <NAME> says no, <PHONE>")]));
  assert.throws(() => assertRequestsScrubbed([req("call 555-867-5309")]), /residual PII/);
  assert.throws(() => assertRequestsScrubbed([req("ask Maria")], () => ({ names: ["Maria Lopez"] })), /record_name/);
});

test("reserve is written BEFORE the call and the budget counts it", () => {
  const d = dir();
  const ledgerPath = join(d, "ledger.jsonl");
  const r = reserveOrThrow({ ledgerPath, budgetUsd: 1, estimateUsd: 0.6, phase: "p" });
  assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);
  // A second worst-case reservation would exceed the budget: refused, nothing written.
  assert.throws(() => reserveOrThrow({ ledgerPath, budgetUsd: 1, estimateUsd: 0.6, phase: "p" }), /budget/);
  settle({ ledgerPath, reservation: r, actualUsd: 0.1, phase: "p" });
  assert.ok(Math.abs(ledgerTotal(ledgerPath) - 0.1) < 1e-9);
  assert.doesNotThrow(() => reserveOrThrow({ ledgerPath, budgetUsd: 1, estimateUsd: 0.6, phase: "p" }));
});

test("cost estimate is a worst case (full max_tokens) and halves for batches", () => {
  const one = estimateRequestCostUsd(req("hello"), { priceIn: 1e-7, priceOut: 5e-7 });
  assert.ok(one >= 100 * 5e-7);
  assert.equal(estimateRequestCostUsd(req("hello"), { priceIn: 1e-7, priceOut: 5e-7, batch: true }), one / 2);
});
