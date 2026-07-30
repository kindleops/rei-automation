// auto-reply-live-limited-scope.test.mjs
//
// Proves the live_limited activation scope: an eligibility cutoff plus an
// optional thread allowlist bound which inbound messages may receive an
// automatic seller-visible reply. Without these, setting auto_reply_mode to
// live_limited would make every inbound message already in the database
// eligible — including the unanswered backlog that the */5 recover-inbound
// cron re-scans on a rolling 72-hour lookback.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoReplyModeAllowsQueue,
  evaluateAutoReplyScope,
  normalizeAutoReplyThreadAllowlist,
  resolveAutoReplyScopeConfig,
  AUTO_REPLY_CUTOFF_KEY,
  AUTO_REPLY_ALLOWLIST_KEY,
} from '@/lib/domain/seller-flow/auto-reply-mode.js';

const CUTOFF = '2026-07-30T00:00:00.000Z';
const BEFORE_CUTOFF = '2026-07-22T04:26:52.424Z'; // a real stale-backlog reply time
const AFTER_CUTOFF = '2026-07-30T18:00:00.000Z';
const CANARY_THREAD = '+16128072000';
const STALE_THREAD = '+14043724312'; // a real Waiting-bucket thread

test('live_limited fails closed when no eligibility cutoff is configured', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: CANARY_THREAD,
    threadKey: CANARY_THREAD,
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: null,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'auto_reply_cutoff_not_configured');
});

test('live_limited fails closed when the inbound arrival time is unknown', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: CANARY_THREAD,
    threadKey: CANARY_THREAD,
    inboundReceivedAt: null,
    cutoffAt: CUTOFF,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'auto_reply_inbound_timestamp_missing');
});

test('a pre-existing reply stays ineligible after the mode flips to live_limited', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: STALE_THREAD,
    threadKey: STALE_THREAD,
    inboundReceivedAt: BEFORE_CUTOFF,
    cutoffAt: CUTOFF,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'auto_reply_inbound_before_cutoff');
});

test('an allowlisted canary thread after the cutoff is eligible', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: CANARY_THREAD,
    threadKey: CANARY_THREAD,
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: `${CANARY_THREAD}, +19995551234`,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'live_limited');
  assert.equal(result.scope.allowlist_enforced, true);
});

test('a non-allowlisted thread after the cutoff is blocked while an allowlist is set', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: '+14042937151',
    threadKey: '+14042937151',
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: CANARY_THREAD,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'auto_reply_thread_not_allowlisted');
});

test('an empty allowlist leaves the cutoff as the only bound (ramp / full volume)', () => {
  const allowed = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: '+14042937151',
    threadKey: '+14042937151',
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '',
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.scope.allowlist_enforced, false);

  const blocked = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: '+14042937151',
    threadKey: '+14042937151',
    inboundReceivedAt: BEFORE_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '',
  });
  assert.equal(blocked.allowed, false);
});

test('allowlist matching tolerates formatting and US country-code differences', () => {
  const set = normalizeAutoReplyThreadAllowlist('+1 (612) 807-2000');
  assert.equal(set.has('16128072000'), true);
  assert.equal(set.has('6128072000'), true);

  const result = evaluateAutoReplyScope({
    threadKey: '+16128072000',
    inboundFrom: '',
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '612-807-2000',
  });
  assert.equal(result.allowed, true);
});

test('scope enforcement does not alter disabled / dry_run / internal_only', () => {
  assert.equal(autoReplyModeAllowsQueue({ mode: 'disabled' }).allowed, false);
  assert.equal(autoReplyModeAllowsQueue({ mode: 'dry_run' }).allowed, false);

  // internal_only remains bounded by the internal test-phone list alone.
  const internal = autoReplyModeAllowsQueue({
    mode: 'internal_only',
    inboundFrom: CANARY_THREAD,
    threadKey: CANARY_THREAD,
  });
  assert.equal(internal.allowed, true);

  const external = autoReplyModeAllowsQueue({
    mode: 'internal_only',
    inboundFrom: STALE_THREAD,
    threadKey: STALE_THREAD,
  });
  assert.equal(external.allowed, false);
  assert.equal(external.reason, 'internal_only_non_internal');
});

test('capability probes bypass scope but never widen a real send decision', () => {
  const probe = autoReplyModeAllowsQueue({ mode: 'live_limited', enforceScope: false });
  assert.equal(probe.allowed, true);
  assert.equal(probe.scope_enforced, false);

  // The default is scope-enforced, so a caller that forgets the scope inputs
  // is denied rather than allowed.
  const defaulted = autoReplyModeAllowsQueue({ mode: 'live_limited' });
  assert.equal(defaulted.allowed, false);
});

test('scope config is read from the canonical system_control keys', async () => {
  const reads = [];
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: async (key) => {
      reads.push(key);
      if (key === AUTO_REPLY_CUTOFF_KEY) return CUTOFF;
      if (key === AUTO_REPLY_ALLOWLIST_KEY) return `${CANARY_THREAD}`;
      return null;
    },
  });

  assert.deepEqual(reads.sort(), [AUTO_REPLY_ALLOWLIST_KEY, AUTO_REPLY_CUTOFF_KEY].sort());
  assert.equal(config.cutoffAt, CUTOFF);
  assert.equal(config.threadAllowlist, CANARY_THREAD);
});

test('a failing system_control read degrades to denied, not to open', async () => {
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: async () => {
      throw new Error('system_control unavailable');
    },
  });
  assert.equal(config.cutoffAt, null);

  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: CANARY_THREAD,
    threadKey: CANARY_THREAD,
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: config.cutoffAt,
    threadAllowlist: config.threadAllowlist,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'auto_reply_cutoff_not_configured');
});
