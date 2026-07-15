import test from "node:test";
import assert from "node:assert/strict";

import {
  threadMatchesBucketFilter,
  threadMatchesWaitingFacts,
  isStaleExplicitInboxBucket,
} from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";
import { threadMatchesInboxTab } from "../../src/lib/domain/inbox/inbox-thread-state-contract.js";
import { resolveOutboundReplyState } from "../../src/lib/domain/inbox/resolve-waiting-cold-state.js";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const minutesAgo = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();

const withNow = (fn) => {
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    fn();
  } finally {
    Date.now = originalNow;
  }
};

test("A: outbound 2h ago, no inbound → Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(2),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), true);
    assert.equal(threadMatchesBucketFilter(row, "waiting", NOW), true);
  });
});

test("B: outbound 23h59m ago, no inbound → Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: minutesAgo((24 * 60) - 1),
      last_inbound_at: null,
      latest_delivery_status: "sent",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), true);
  });
});

test("C: outbound beyond 24h boundary → not Waiting", () => {
  withNow(() => {
    const row = {
      inbox_bucket: "waiting",
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(24.01),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
    assert.equal(threadMatchesBucketFilter(row, "waiting", NOW), false);
    assert.equal(isStaleExplicitInboxBucket(row, "waiting", NOW), true);
  });
});

test("D: outbound followed by newer inbound → not Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "inbound",
      last_outbound_at: hoursAgo(2),
      last_inbound_at: hoursAgo(1),
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
  });
});

test("E: inbound followed by newer outbound within 24h → Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: hoursAgo(5),
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), true);
  });
});

test("F: terminally failed outbound → not Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: null,
      latest_delivery_status: "failed",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
    const state = resolveOutboundReplyState({
      lastOutboundAt: row.last_outbound_at,
      lastInboundAt: row.last_inbound_at,
      latestDeliveryStatus: row.latest_delivery_status,
      now: NOW,
    });
    assert.equal(state.inbox_bucket, null);
  });
});

test("G: cancelled outbound → not Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: null,
      latest_delivery_status: "cancelled",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
  });
});

test("H: suppressed contact → not Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: null,
      is_suppressed: true,
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
  });
});

test("I: opted-out contact → not Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: null,
      opt_out: true,
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
  });
});

test("J: wrong-number contact → not Waiting", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: null,
      disposition: "wrong_number",
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
  });
});

test("K: archived thread → not Waiting", () => {
  withNow(() => {
    const row = {
      is_archived: true,
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(1),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), false);
    assert.equal(threadMatchesInboxTab(row, "waiting", NOW), false);
  });
});

test("L: duplicate delivery event does not change waiting direction", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(2),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
      message_count: 4,
      outbound_count: 2,
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), true);
  });
});

test("M: missing delivery timestamp uses permissive fallback", () => {
  withNow(() => {
    const row = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(2),
      last_inbound_at: null,
      latest_delivery_status: null,
    };
    assert.equal(threadMatchesWaitingFacts(row, NOW), true);
  });
});

test("N: persisted waiting disagrees with facts → resolver removes it", () => {
  withNow(() => {
    const row = {
      inbox_bucket: "waiting",
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(48),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
    };
    assert.equal(threadMatchesBucketFilter(row, "waiting", NOW), false);
    assert.equal(threadMatchesBucketFilter(row, "cold", NOW), true);
  });
});

test("O: All Threads excludes current Waiting threads", () => {
  withNow(() => {
    const waiting = {
      latest_direction: "outbound",
      last_outbound_at: hoursAgo(2),
      last_inbound_at: null,
      latest_delivery_status: "delivered",
    };
    const activeInbound = {
      latest_direction: "inbound",
      last_outbound_at: hoursAgo(5),
      last_inbound_at: hoursAgo(1),
    };
    assert.equal(threadMatchesBucketFilter(waiting, "all_messages", NOW), false);
    assert.equal(threadMatchesBucketFilter(activeInbound, "all_messages", NOW), true);
  });
});