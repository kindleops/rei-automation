import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  inboxSnapshotScope,
  loadInboxBootSnapshot,
  rememberInboxBootSnapshot,
  __resetInboxBootSnapshotForTests,
} from "../../src/lib/domain/inbox/live-inbox-service.js";

// The live route's timeout fallback serves the boot snapshot. It used to serve
// the last list of ANY filter, so a slow "Needs Review" returned Priority rows.
beforeEach(() => __resetInboxBootSnapshotForTests());

const row = (key, bucket) => ({ thread_key: key, inbox_bucket: bucket });

test("a snapshot answers only the list that produced it", () => {
  rememberInboxBootSnapshot([row("+1", "priority")], inboxSnapshotScope({ filter: "priority", limit: "30", timeout_mode: "manual_bucket_switch" }));
  assert.equal(loadInboxBootSnapshot(undefined, inboxSnapshotScope({ filter: "needs_review", limit: "30" })), null);
  assert.equal(loadInboxBootSnapshot(undefined, inboxSnapshotScope({ filter: "priority", advanced: '{"stage":"S2"}' })), null);
  const same = loadInboxBootSnapshot(undefined, inboxSnapshotScope({ filter: "priority", limit: "25", refresh_reason: "desk_lens", skip_counts: "1" }));
  assert.equal(same?.threads?.[0]?.thread_key, "+1");
});

test("filter=all, bucket alias and direction=all normalise to the same scope", () => {
  assert.equal(inboxSnapshotScope({ filter: "all", direction: "all", limit: "25" }), "all");
  assert.equal(inboxSnapshotScope({}), "all");
  assert.equal(inboxSnapshotScope({ bucket: "waiting" }), inboxSnapshotScope({ filter: "waiting" }));
});

test("later pages are never remembered or served", () => {
  assert.equal(inboxSnapshotScope({ filter: "priority", cursor: "abc" }), null);
  rememberInboxBootSnapshot([row("+2", "priority")], null);
  assert.equal(loadInboxBootSnapshot(undefined, "all"), null);
});

test("the default (unscoped) load still serves the unfiltered list", () => {
  rememberInboxBootSnapshot([row("+3", "waiting")]);
  assert.equal(loadInboxBootSnapshot()?.threads?.[0]?.thread_key, "+3");
});
