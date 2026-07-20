// Adversarial scenario suite: every pair/property check in scenarios/suite.mjs
// must hold. Failures here mean a real ranking-logic defect, not a style issue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenarios, SCENARIOS } from '../scenarios/suite.mjs';

const { rows, checks, byId } = runScenarios();

test('all 22 scenarios score without error and expose route + horizon', () => {
  assert.equal(rows.length, SCENARIOS.length);
  for (const r of rows) {
    assert.equal(typeof r.execution_priority, 'number', r.id);
    assert.ok(r.route, r.id);
    assert.ok(r.horizon_days >= 90, r.id);
  }
});

for (const c of checks) {
  test(`${c.kind === 'pair' ? `${c.a} > ${c.b}` : c.a}: ${c.why}`, () => {
    if (c.kind === 'pair') {
      assert.ok(c.pass, `${c.a} (${byId.get(c.a).execution_priority}) must outrank ${c.b} (${byId.get(c.b).execution_priority})`);
    } else {
      assert.ok(c.pass, `${c.a}: route=${byId.get(c.a).route} priority=${byId.get(c.a).execution_priority}`);
    }
  });
}

test('every scored contribution in explanations is real (no phantom components)', () => {
  for (const r of rows) {
    for (const e of r.explanations) {
      if (e.direction === 'positive') {
        assert.ok(typeof e.contribution === 'number' && e.contribution > 0,
          `${r.id}: positive explanation ${e.component} must carry its actual contribution`);
      }
    }
  }
});

test('marker: high distress + no equity never outranks the same distress with equity', () => {
  assert.ok(byId.get('S10').execution_priority >= 2 * byId.get('S09').execution_priority,
    'IX-17 must separate rescueable from short-sale by a wide margin');
});
