import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function readDashboard(relPath) {
  return readFileSync(join(dashboardRoot, relPath), 'utf8');
}

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

test('dashboard routing defaults to Workflow Studio V2', () => {
  const routes = readDashboard('app/routes.tsx');
  const inbox = readDashboard('modules/inbox/InboxPage.tsx');
  const routing = readDashboard('views/workflow-studio/v2/workflow-studio-routing.ts');

  assert.match(routes, /WorkflowStudioV2/);
  assert.match(routes, /'\/workflows-v2': '\/workflow-studio'/);
  assert.match(routes, /'\/workflow-studio-v1': '\/workflow-studio'/);
  assert.doesNotMatch(inbox, /WorkflowStudioLegacy|isWorkflowStudioV2Enabled\(\) \? WorkflowStudioV2 : WorkflowStudio/);
  assert.match(routing, /isWorkflowStudioV2Canonical/);
  assert.match(routing, /migrateLegacyWorkflowStudioDestination/);
});