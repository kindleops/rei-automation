/**
 * RC 7.1 D8 (owner: "paused templates must never send") — the SEND-TIME gate.
 *
 * The planner keeps governance-paused templates out of new campaign rows; this
 * gate covers every producer at dispatch (legacy feeder, bulk follow-ups,
 * operator template picks, rows queued before the fix). Production history:
 * paused templates went out from `inbox:` (153 delivered, July), `feed:`
 * (132, June-Aug) and `campaign:` (107, Sept) rows.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSmsHealthGuard } from "@/lib/domain/delivery/sms-health-guard.js";
import {
  loadGovernancePausedTemplateIds,
  rowMayCarryGovernedTemplate,
} from "@/lib/domain/queue/process-send-queue.js";

const GOVERNANCE = [
  { template_id: "200049", rotation_status: "pause", daily_cap: 0, last_40d_total_sent: null },
  { template_id: "208481", rotation_status: "testing", daily_cap: 25, last_40d_total_sent: null },
];

function governanceClient(rows, { fail = false } = {}) {
  const calls = { n: 0 };
  return {
    calls,
    from(table) {
      assert.equal(table, "ownership_template_rotation_control");
      return {
        select() {
          calls.n += 1;
          return Promise.resolve(fail ? { data: null, error: { message: "rotation control unreadable" } } : { data: rows, error: null });
        },
      };
    },
  };
}

test("the health guard refuses a governance-paused template for any producer", () => {
  const guard = (template_id) => evaluateSmsHealthGuard({
    from_phone_number: "+16125092623",
    template_id,
    system_control: { governance_paused_template_ids: new Set(["200049"]) },
    env: {},
  });
  const paused = guard("200049");
  assert.equal(paused.allowed, false);
  assert.equal(paused.reason, "template_governance_paused");
  assert.equal(paused.block_class, "template_health_block");
  assert.equal(guard("208481").allowed, true, "a sendable governed template passes");
  assert.equal(guard("204513").allowed, true, "an ungoverned template is not refused (owner decision pending)");
});

test("the operator blocklist still refuses on its own reason", () => {
  const verdict = evaluateSmsHealthGuard({
    template_id: "204273",
    system_control: { sms_blocked_template_ids: "204273", governance_paused_template_ids: new Set() },
    env: {},
  });
  assert.equal(verdict.reason, "blocked_template_id");
});

test("governance ids are read once per client per minute and derived with the planner's rule", async () => {
  const client = governanceClient(GOVERNANCE);
  const first = await loadGovernancePausedTemplateIds({ supabase: client });
  const second = await loadGovernancePausedTemplateIds({ supabase: client });
  assert.deepEqual([...first], ["200049"]);
  assert.equal(second, first);
  assert.equal(client.calls.n, 1, "cached");
});

test("unreadable governance with nothing cached is UNKNOWN (null), never 'allowed'", async () => {
  const ids = await loadGovernancePausedTemplateIds({ supabase: governanceClient(null, { fail: true }) });
  assert.equal(ids, null);
});

test("only rows that could carry a governed (ownership-check) template are deferred when governance is unknown", () => {
  assert.equal(rowMayCarryGovernedTemplate({ template_id: "200049", use_case_template: "ownership_check" }), true);
  assert.equal(rowMayCarryGovernedTemplate({ template_id: "200049" }), true, "use case unknown: assume it could be");
  assert.equal(rowMayCarryGovernedTemplate({ template_id: "300100", use_case_template: "ask_offer_interest" }), false);
  assert.equal(rowMayCarryGovernedTemplate({ message_body: "free text from an operator" }), false);
});

test("the dispatcher wires both: the guard sees governance, and unknown governance defers before the guard", async () => {
  const fs = await import("node:fs");
  const src = await fs.promises.readFile(new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");
  const load = src.indexOf("const governance_paused_template_ids = await loadGovernancePausedTemplateIds(deps);");
  const defer = src.indexOf('"template_governance_unreadable"', load);
  const guard = src.indexOf("const sms_health_guard = evaluateSmsHealthGuard({", load);
  const dispatch = src.indexOf("await dispatchSellerQueueRow(", guard);
  assert.ok(load > 0 && defer > load && guard > defer, "load → defer-if-unknown → guard");
  assert.ok(src.slice(guard, guard + 600).includes("governance_paused_template_ids"), "guard receives the governance ids");
  assert.ok(dispatch === -1 || dispatch > guard, "the guard runs before the provider dispatch");
});
