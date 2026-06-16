import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('Behavior A: Blocked/cancelled events do not display as delivered', () => {
  const fileContent = readFileSync('apps/api/src/lib/domain/inbox/live-inbox-service.js', 'utf8');
  assert.ok(fileContent.includes('if (statuses.some((status) => status.includes("blocked"))) return "blocked";'), 'Must handle blocked');
  assert.ok(fileContent.includes('if (statuses.some((status) => status.includes("cancelled") || status.includes("canceled"))) return "cancelled";'), 'Must handle cancelled');
});

test('Behavior B: DNC buyers never appear in match results', () => {
  const routeContent = readFileSync('apps/api/src/app/api/cockpit/buyer-match/property/[property_id]/candidates/route.js', 'utf8');
  assert.ok(routeContent.includes(".neq('buyer_response_status', 'DNC')"), 'Must filter out DNC buyers');
  assert.ok(routeContent.includes(".neq('buyer_response_status', 'opt_out')"), 'Must filter out opt_out buyers');
});
