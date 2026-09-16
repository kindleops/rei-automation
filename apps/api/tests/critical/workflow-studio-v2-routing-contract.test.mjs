import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listWorkflowStudioCatalog,
  getWorkflowStudioDetail,
  listWorkflowNodeRegistry,
} from '../../src/lib/domain/workflow-v2/workflow-studio-bridge.js';
import { workflowSuccess, workflowError } from '../../src/app/api/cockpit/_shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(__dirname, '../../../dashboard/src');

test('workflow API envelopes expose ok/data/meta contract', () => {
  const success = workflowSuccess({ workflows: [] }, Date.now() - 12);
  assert.equal(success.ok, true);
  assert.ok(success.data);
  assert.ok(success.meta?.request_id);
  assert.equal(typeof success.meta.duration_ms, 'number');

  const failure = workflowError('WORKFLOW_NOT_FOUND', 'Workflow could not be loaded.', false, Date.now() - 8);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'WORKFLOW_NOT_FOUND');
  assert.equal(failure.error.retryable, false);
  assert.ok(failure.meta?.request_id);
});

test('catalog lightweight mode avoids per-workflow stats hydration', async () => {
  let enrollmentQueries = 0;
  const fake = {
    from(table) {
      const state = { table, filters: [], op: 'select', payload: null, one: false, order: null, limit: null };
      const api = {
        select() { return api; },
        eq(col, val) { state.filters.push(['eq', col, val]); return api; },
        in(col, vals) { state.filters.push(['in', col, vals]); return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        maybeSingle() { state.one = true; return api; },
        then(resolve) {
          if (table === 'workflow_definitions') {
            resolve({
              data: [{
                id: 'wf-1',
                name: 'Test Workflow',
                description: 'desc',
                definition_key: 'test_workflow',
                status: 'draft',
                trigger_type: 'trigger.lead_entered_workflow',
                version: 1,
                updated_at: '2026-06-22T00:00:00.000Z',
                created_at: '2026-06-22T00:00:00.000Z',
                published_at: null,
                metadata: { channel: 'sms' },
                is_system_template: false,
                is_locked: false,
              }],
              error: null,
            });
            return;
          }
          if (table === 'workflows') {
            resolve({ data: [], error: null });
            return;
          }
          if (table === 'workflow_enrollments') {
            enrollmentQueries += 1;
            resolve({ data: [], error: null });
            return;
          }
          if (table === 'workflow_nodes' || table === 'workflow_edges') {
            resolve({ data: [], error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return api;
    },
  };

  const result = await listWorkflowStudioCatalog({ summary: true, include_stats: false }, { supabase: fake });
  assert.equal(result.ok, true);
  assert.equal(result.summary, true);
  assert.equal(result.workflows.length, 1);
  assert.equal(enrollmentQueries, 0);
});

test('workflow detail skips analytics unless explicitly requested', async () => {
  const fake = {
    from(table) {
      const state = { table, filters: [], op: 'select', one: false, limit: null };
      const api = {
        select() { return api; },
        eq() { return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        maybeSingle() { state.one = true; return api; },
        then(resolve) {
          if (table === 'workflow_definitions' && state.one) {
            resolve({
              data: {
                id: 'wf-1',
                name: 'Detail Workflow',
                definition_key: 'detail_workflow',
                status: 'draft',
                metadata: {},
                trigger_type: 'trigger.lead_entered_workflow',
              },
              error: null,
            });
            return;
          }
          if (table === 'workflow_nodes') {
            resolve({ data: [{ id: 'n1', workflow_definition_id: 'wf-1', node_key: 'a', node_type: 'trigger.lead_entered_workflow', label: 'Start', config: {}, position_x: 0, position_y: 0, is_active: true }], error: null });
            return;
          }
          if (table === 'workflow_edges') {
            resolve({ data: [], error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return api;
    },
  };

  const withoutAnalytics = await getWorkflowStudioDetail('wf-1', { include_analytics: false }, { supabase: fake });
  assert.equal(withoutAnalytics.ok, true);
  assert.deepEqual(withoutAnalytics.analytics_summary, {});

  const withAnalytics = await getWorkflowStudioDetail('wf-1', { include_analytics: true }, { supabase: fake });
  assert.equal(withAnalytics.ok, true);
  assert.ok(withAnalytics.analytics_summary);
});

test('node registry is memoized within TTL', async () => {
  let dbReads = 0;
  const fake = {
    from(table) {
      return {
        select() { return this; },
        order() { return this; },
        then(resolve) {
          if (table === 'workflow_node_registry') {
            dbReads += 1;
            resolve({ data: [], error: { message: 'forced fallback' } });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
    },
  };

  await listWorkflowNodeRegistry({}, { supabase: fake });
  await listWorkflowNodeRegistry({}, { supabase: fake });
  assert.equal(dbReads, 1);

  await listWorkflowNodeRegistry({ bypass_cache: true }, { supabase: fake });
  assert.equal(dbReads, 2);
});

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1 §2 — the routing contract, EXECUTED.
 *
 * This test failed for several phases, and the behaviour it guards was correct
 * the whole time. It read `app/routes.tsx` as text and asserted the alias
 * literals appeared in it:
 *
 *   assert.match(routes, /'\/workflows-v2': '\/workflow-studio'/)
 *
 * Commit 6ef12bc9 moved the aliases into the canonical app registry, where the
 * rest of the navigation truth already lived. Nothing about routing broke — the
 * string moved, so a test asserting the LOCATION OF A STRING went red and stayed
 * red. A grep cannot tell "this route is gone" from "this route is declared
 * somewhere else", which is exactly the distinction that matters.
 *
 * So it now imports the registry and calls the function the shell actually calls.
 * `canonicalizeRoutePath` is the single resolver; if Workflow Studio stops being
 * reachable, or an alias stops resolving, or a second alias table appears, these
 * assertions fail. If the declarations move again, they do not.
 *
 * Node strips the types (>= 22.6 with --experimental-strip-types, default from
 * 23.6). The registry imports only `import type`, so there is nothing to compile.
 */
const registry = await import('../../../dashboard/src/domain/app-registry/app-registry.ts').catch((cause) => {
  throw new Error(
    'the routing contract must be executed, not grepped: could not load the dashboard app registry. '
    + `Node ${process.version} needs --experimental-strip-types below 23.6. Cause: ${cause.message}`,
  );
});

test('Workflow Studio is registered at exactly one canonical route', () => {
  const entry = registry.getApp('workflow-studio');
  assert.ok(entry, 'workflow-studio must be a registered application');
  assert.equal(entry.route, '/workflow-studio');
  assert.equal(registry.canonicalizeRoutePath('/workflow-studio'), '/workflow-studio');
  assert.equal(registry.resolveAppForRoute('/workflow-studio').id, 'workflow-studio');
});

/** Existing bookmarks and deep links are part of the product contract. */
test('both legacy Workflow Studio paths resolve to the canonical surface', () => {
  for (const legacy of ['/workflows-v2', '/workflow-studio-v1']) {
    const resolved = registry.canonicalizeRoutePath(legacy);
    assert.equal(resolved, '/workflow-studio', `${legacy} must land on the studio, not 404`);
    assert.equal(registry.resolveAppForRoute(resolved).id, 'workflow-studio');
  }
});

test('canonicalization never invents a Workflow Studio route', () => {
  for (const path of ['/pipeline', '/inbox', '/campaign-command', '/nope']) {
    assert.notEqual(registry.canonicalizeRoutePath(path), '/workflow-studio', path);
  }
});

/** §40 — a surface a phone cannot reach does not exist on mobile. */
test('Workflow Studio is reachable from the mobile application set', () => {
  assert.ok(
    registry.MOBILE_APPS.some((app) => app.id === 'workflow-studio'),
    'Workflow Studio must appear in the mobile app set',
  );
});

/** One authority: every alias has to land on a route the registry declares. */
test('every route alias resolves to a registered application route', () => {
  const registered = new Set(registry.NEXUS_APPS.map((app) => app.route));
  for (const alias of ['/workflows-v2', '/workflow-studio-v1', '/']) {
    const resolved = registry.canonicalizeRoutePath(alias);
    assert.ok(registered.has(resolved), `${alias} -> ${resolved} is not a registered route`);
  }
});

/**
 * The half a registry cannot answer: which component the route renders. Asserted
 * as ABSENCE across the whole tree rather than presence in one file, so it
 * survives the route table moving. `views/workflow-studio/WorkflowStudio.tsx`
 * still exists and still carries the `isWorkflowStudioV2Enabled` toggle, but
 * nothing imports it — it is orphaned, not mounted. This fails the moment
 * something wires it back in.
 */
test('no reachable surface mounts the legacy Workflow Studio', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // The legacy switcher importing itself is not a mount.
      if (full.endsWith('views/workflow-studio/WorkflowStudio.tsx')) continue;
      const src = readFileSync(full, 'utf8');
      if (/from\s+['"][^'"]*workflow-studio\/WorkflowStudio['"]/.test(src)) {
        offenders.push(full.slice(dashboardRoot.length + 1));
      }
    }
  };
  walk(dashboardRoot);
  assert.deepEqual(offenders, [], `legacy Workflow Studio mounted by: ${offenders.join(', ')}`);
});
