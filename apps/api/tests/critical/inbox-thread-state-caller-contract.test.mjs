import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { isCanonicalThreadKey } from "../../src/lib/cockpit/cockpit-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INBOX_PAGE_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/modules/inbox/InboxPage.tsx"),
  "utf8",
);
// Contract re-pin: the canonical resolver moved to canonical-thread-reference.ts
// (resolveCanonicalThreadStateKey.ts no longer exists).
const RESOLVER_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/domain/inbox/canonical-thread-reference.ts"),
  "utf8",
);

test("thread-state caller resolves E.164 before PATCH", () => {
  // Contract re-pin: the InboxPage call-site now routes through
  // resolveDealDeskWritableThreadKey (shared write contract, DD-003).
  assert.match(INBOX_PAGE_SRC, /resolveDealDeskWritableThreadKey/);
  assert.match(INBOX_PAGE_SRC, /patch:\s*\{\s*is_read:\s*true\s*\}/);
  assert.doesNotMatch(INBOX_PAGE_SRC, /thread_key:\s*threadKey,\s*is_read:\s*true,\s*unread_count:\s*0/);
});

test("canonical resolver accepts phone-only and composite thread records", () => {
  assert.match(RESOLVER_SRC, /canonicalE164/);
  assert.match(RESOLVER_SRC, /seller_phone/);
  assert.match(RESOLVER_SRC, /thread_key/);
  assert.equal(isCanonicalThreadKey("+15551234567"), true);
  assert.equal(isCanonicalThreadKey("ct:property|owner"), false);
  assert.equal(isCanonicalThreadKey("phone:+15551234567"), false);
});