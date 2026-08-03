/**
 * N.2 — server side of the automation-mode contract.
 *
 * Before this lane `patchUniversalLeadState` had no branch for `automation_state`:
 * `normalizePatchToCanonical` let `autopilot_mode` through its allowlist, `buildRowPatch`
 * ignored it, and the upsert's `.select(...)` did not include the column. Every operator
 * automation write was therefore accepted, dropped, and reported as a success.
 *
 * These tests cover the three things that changed:
 *   1. `automation_state` is allowlisted, strictly normalized, persisted and selected back;
 *   2. `manual_stage_lock` / `manual_temperature_lock` are writable on their own, not only
 *      as a side effect of a `lifecycle_stage` write;
 *   3. a resume (`running`) on a suppressed or terminal record is refused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_STATE_CODES,
  UNIVERSAL_LEAD_STATE_PATCH_FIELDS,
  normalizeAutomationState,
  normalizePatchToCanonical,
} from '@/lib/domain/lead-state/universal-lead-state-registry.js';
import { patchUniversalLeadState } from '@/lib/domain/lead-state/patch-universal-lead-state.js';

const THREAD_KEY = '+19015551234';

/**
 * Minimal Supabase double.
 *
 * Records the upserted row so a test can assert on the exact patch, and returns whatever
 * the test set as the existing row for `fetchCurrentLeadState`.
 */
function makeSupabase({ existing = null } = {}) {
  const state = { upserted: null, audits: [], selectList: null };
  const client = {
    from(table) {
      if (table === 'inbox_thread_state') {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: existing, error: null }) };
              },
            };
          },
          upsert(row) {
            state.upserted = row;
            return {
              select(list) {
                state.selectList = list;
                const columns = String(list).split(',');
                const projected = {};
                for (const column of columns) {
                  if (column in row) projected[column] = row[column];
                }
                return { maybeSingle: async () => ({ data: projected, error: null }) };
              },
            };
          },
        };
      }
      if (table === 'universal_lead_state_events') {
        return {
          insert(rows) {
            state.audits.push(...rows);
            return { select: async () => ({ data: rows.map((_, i) => ({ id: `audit-${i}` })), error: null }) };
          },
        };
      }
      return {
        upsert() {
          return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
        },
      };
    },
  };
  return { client, state };
}

const patch = (patchBody, { existing = null, meta = {} } = {}) => {
  const { client, state } = makeSupabase({ existing });
  return patchUniversalLeadState({ threadKey: THREAD_KEY, patch: patchBody, meta, supabase: client })
    .then((result) => ({ result, state }));
};

// ── allowlist and normalization ──────────────────────────────────────────────

test('automation_state is an allowlisted, selected-back patch field', () => {
  assert.ok(UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes('automation_state'));
  // The upsert selects this list, so the column must be in it or the client can never
  // confirm the write from the authoritative row.
});

test('automation_status is NOT a patchable field', () => {
  assert.ok(!UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes('automation_status'),
    'the queue/execution column is owned by the send pipeline, not by this route');
});

test('only the located automation states normalize', () => {
  assert.equal(normalizeAutomationState('running'), 'running');
  assert.equal(normalizeAutomationState('PAUSED'), 'paused');
  assert.equal(normalizeAutomationState('  manual '), 'manual');
  assert.equal(normalizeAutomationState('active'), null, 'the canonical UI code is not a DB value');
  assert.equal(normalizeAutomationState('quantum'), null);
  assert.equal(normalizeAutomationState(''), null);
  assert.equal(normalizeAutomationState(null), null);
});

test('an unrecognised automation_state is dropped, never coerced', () => {
  assert.deepEqual(normalizePatchToCanonical({ automation_state: 'quantum' }), {});
  assert.deepEqual(normalizePatchToCanonical({ automation_state: 'running' }), { automation_state: 'running' });
});

test('a dropped automation_state produces an explicit refusal, not a silent success', async () => {
  const { result } = await patch({ automation_state: 'quantum' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_allowed_patch_fields');
});

// ── persistence ──────────────────────────────────────────────────────────────

test('automation_state is written to the row and returned in the authoritative response', async () => {
  const { result, state } = await patch({ automation_state: AUTOMATION_STATE_CODES.PAUSED });
  assert.equal(result.ok, true);
  assert.equal(state.upserted.automation_state, 'paused');
  assert.equal(result.row.automation_state, 'paused', 'the client needs this to confirm the write');
});

test('an automation_state write never touches automation_status', async () => {
  const { state } = await patch({ automation_state: 'paused' });
  assert.ok(!('automation_status' in state.upserted));
});

test('an automation_state change is audited', async () => {
  const { state } = await patch(
    { automation_state: 'paused' },
    { existing: { thread_key: THREAD_KEY, automation_state: 'running' } },
  );
  const event = state.audits.find((row) => row.field_name === 'automation_state');
  assert.ok(event, 'the mode change must be traceable');
  assert.equal(event.previous_value, 'running');
  assert.equal(event.new_value, 'paused');
});

test('manual_stage_lock is writable on its own, with no lifecycle_stage in the patch', async () => {
  const { result, state } = await patch({ automation_state: 'manual', manual_stage_lock: true });
  assert.equal(result.ok, true);
  assert.equal(state.upserted.automation_state, 'manual');
  assert.equal(state.upserted.manual_stage_lock, true);
  assert.ok(!('lifecycle_stage' in state.upserted));
});

test('releasing both manual locks works without a stage or temperature write', async () => {
  const { result, state } = await patch({ manual_stage_lock: false, manual_temperature_lock: false });
  assert.equal(result.ok, true);
  assert.equal(state.upserted.manual_stage_lock, false);
  assert.equal(state.upserted.manual_temperature_lock, false);
});

// ── resume guard ─────────────────────────────────────────────────────────────

const RESUME = { automation_state: AUTOMATION_STATE_CODES.RUNNING };

test('resuming a suppressed record is refused', async () => {
  const { result, state } = await patch(RESUME, {
    existing: { thread_key: THREAD_KEY, is_suppressed: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'automation_resume_blocked_suppressed');
  assert.equal(state.upserted, null, 'nothing was written');
});

test('resuming a record with blocking contactability is refused', async () => {
  for (const contactability of ['opted_out', 'dnc', 'invalid_number', 'do_not_text', 'provider_blacklisted']) {
    const { result } = await patch(RESUME, {
      existing: { thread_key: THREAD_KEY, contactability_status: contactability },
    });
    assert.equal(result.ok, false, contactability);
    assert.equal(result.reason, 'automation_resume_blocked_suppressed');
  }
});

test('resuming a closed record is refused', async () => {
  const { result } = await patch(RESUME, {
    existing: { thread_key: THREAD_KEY, lifecycle_stage: 'closed' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'automation_resume_blocked_terminal_stage');
});

test('resuming a terminally-dispositioned record is refused', async () => {
  for (const disposition of ['not_interested', 'wrong_number', 'sold', 'duplicate', 'unqualified', 'wrong_person']) {
    const { result } = await patch(RESUME, {
      existing: { thread_key: THREAD_KEY, disposition },
    });
    assert.equal(result.ok, false, disposition);
    assert.equal(result.reason, 'automation_resume_blocked_terminal_disposition');
  }
});

test('the guard is evaluated against the RESULT, so lifting suppression and resuming in one call works', async () => {
  const { result, state } = await patch(
    { automation_state: 'running', contactability_status: 'contactable' },
    { existing: { thread_key: THREAD_KEY, contactability_status: 'opted_out' } },
  );
  assert.equal(result.ok, true);
  assert.equal(state.upserted.automation_state, 'running');
});

test('PAUSING a suppressed record is still allowed — the guard only blocks resume', async () => {
  const { result, state } = await patch(
    { automation_state: 'paused' },
    { existing: { thread_key: THREAD_KEY, is_suppressed: true } },
  );
  assert.equal(result.ok, true);
  assert.equal(state.upserted.automation_state, 'paused');
});

test('taking MANUAL control of a suppressed record is allowed', async () => {
  const { result } = await patch(
    { automation_state: 'manual', manual_stage_lock: true },
    { existing: { thread_key: THREAD_KEY, is_suppressed: true } },
  );
  assert.equal(result.ok, true);
});

test('a live record resumes normally', async () => {
  const { result, state } = await patch(RESUME, {
    existing: { thread_key: THREAD_KEY, lifecycle_stage: 'offer', disposition: 'interested' },
  });
  assert.equal(result.ok, true);
  assert.equal(state.upserted.automation_state, 'running');
});
