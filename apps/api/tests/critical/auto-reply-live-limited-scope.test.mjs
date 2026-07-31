// auto-reply-live-limited-scope.test.mjs
//
// Proves the live_limited activation scope: an eligibility cutoff plus an
// optional thread allowlist bound which inbound messages may receive an
// automatic seller-visible reply. Without these, setting auto_reply_mode to
// live_limited would make every inbound message already in the database
// eligible — including the unanswered backlog that the */5 recover-inbound
// cron re-scans on a rolling 72-hour lookback.
//
// Every phone fixture here is a synthetic +1555 value. Production-derived
// numbers must never enter source control, and the internal_only case injects
// its own isInternalTestPhoneImpl rather than depending on the real registry.

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
const BEFORE_CUTOFF = '2026-07-22T04:26:52.424Z'; // stale-backlog arrival time
const AFTER_CUTOFF = '2026-07-30T18:00:00.000Z';

const CANARY_THREAD = '+15550001000'; // synthetic allowlisted proof thread
const STALE_THREAD = '+15550002000'; // synthetic stale Waiting-bucket thread
const OUTSIDE_THREAD = '+15550003000'; // synthetic non-allowlisted thread

/** Only the canary fixture counts as internal, so internal_only is deterministic. */
const isInternalTestPhoneStub = (phone) =>
  String(phone ?? '').replace(/\D+/g, '') === CANARY_THREAD.replace(/\D+/g, '');

test('live_limited fails closed when the cutoff is missing, blank, or malformed', () => {
  for (const cutoffAt of [null, undefined, '', '   ', '\t\n', 'not-a-timestamp', '2026-13-45']) {
    const result = autoReplyModeAllowsQueue({
      mode: 'live_limited',
      inboundFrom: CANARY_THREAD,
      threadKey: CANARY_THREAD,
      inboundReceivedAt: AFTER_CUTOFF,
      cutoffAt,
    });

    assert.equal(result.allowed, false, `cutoffAt ${JSON.stringify(cutoffAt)} must deny`);
    assert.equal(result.reason, 'auto_reply_cutoff_not_configured');
  }
});

test('live_limited fails closed when the inbound arrival time is missing or malformed', () => {
  for (const inboundReceivedAt of [null, undefined, '', '   ', 'not-a-timestamp', '2026-02-31T99:99:99Z']) {
    const result = autoReplyModeAllowsQueue({
      mode: 'live_limited',
      inboundFrom: CANARY_THREAD,
      threadKey: CANARY_THREAD,
      inboundReceivedAt,
      cutoffAt: CUTOFF,
    });

    assert.equal(
      result.allowed,
      false,
      `inboundReceivedAt ${JSON.stringify(inboundReceivedAt)} must deny`
    );
    assert.equal(result.reason, 'auto_reply_inbound_timestamp_missing');
  }
});

test('a whitespace-only allowlist is treated as no allowlist, not as an empty deny-all', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: OUTSIDE_THREAD,
    threadKey: OUTSIDE_THREAD,
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '   \n  ',
  });

  // The cutoff is still the binding constraint — the mode never opens up on its
  // own, it just is not thread-scoped in this configuration.
  assert.equal(result.allowed, true);
  assert.equal(result.scope.allowlist_enforced, false);
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
    threadAllowlist: `${CANARY_THREAD}, +15550009999`,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'live_limited');
  assert.equal(result.scope.allowlist_enforced, true);
});

test('a non-allowlisted thread after the cutoff is blocked while an allowlist is set', () => {
  const result = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: OUTSIDE_THREAD,
    threadKey: OUTSIDE_THREAD,
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
    inboundFrom: OUTSIDE_THREAD,
    threadKey: OUTSIDE_THREAD,
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '',
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.scope.allowlist_enforced, false);

  const blocked = autoReplyModeAllowsQueue({
    mode: 'live_limited',
    inboundFrom: OUTSIDE_THREAD,
    threadKey: OUTSIDE_THREAD,
    inboundReceivedAt: BEFORE_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '',
  });
  assert.equal(blocked.allowed, false);
});

test('allowlist matching tolerates formatting and US country-code differences', () => {
  const set = normalizeAutoReplyThreadAllowlist('+1 (555) 000-1000');
  assert.equal(set.has('15550001000'), true);
  assert.equal(set.has('5550001000'), true);

  const result = evaluateAutoReplyScope({
    threadKey: CANARY_THREAD,
    inboundFrom: '',
    inboundReceivedAt: AFTER_CUTOFF,
    cutoffAt: CUTOFF,
    threadAllowlist: '555-000-1000',
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
    isInternalTestPhoneImpl: isInternalTestPhoneStub,
  });
  assert.equal(internal.allowed, true);
  assert.equal(internal.reason, 'internal_test_phone');

  const external = autoReplyModeAllowsQueue({
    mode: 'internal_only',
    inboundFrom: STALE_THREAD,
    threadKey: STALE_THREAD,
    isInternalTestPhoneImpl: isInternalTestPhoneStub,
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

test('blank and whitespace system_control values normalize to null, not to a live scope', async () => {
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: async (key) => (key === AUTO_REPLY_CUTOFF_KEY ? '   ' : '\n\t'),
  });
  assert.equal(config.cutoffAt, null);
  assert.equal(config.threadAllowlist, null);

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

test('a malformed stored cutoff denies rather than parsing to epoch-zero and allowing', async () => {
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: async (key) => (key === AUTO_REPLY_CUTOFF_KEY ? 'yesterday-ish' : ''),
  });
  assert.equal(config.cutoffAt, 'yesterday-ish');

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

test('a rejecting system_control read degrades to denied, not to open', async () => {
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: async () => {
      throw new Error('system_control unavailable');
    },
  });
  assert.equal(config.cutoffAt, null);
  assert.equal(config.threadAllowlist, null);

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

test('a synchronously throwing reader degrades to denied instead of propagating', async () => {
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: () => {
      throw new Error('sync boom');
    },
  });
  assert.equal(config.cutoffAt, null);
  assert.equal(config.threadAllowlist, null);
});

test('a reader that resolves to a rejected promise degrades to denied', async () => {
  const config = await resolveAutoReplyScopeConfig({
    getSystemValue: () => Promise.reject(new Error('async boom')),
  });
  assert.equal(config.cutoffAt, null);
  assert.equal(config.threadAllowlist, null);
});
