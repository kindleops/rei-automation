/**
 * email-reply-alias.test.mjs
 *
 * The reply identity: minting, uniqueness, tamper resistance, extraction, and
 * the one property the whole design exists for -- that a conversation has ONE
 * reply address no matter how many messages, retries or weeks pass.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  generateReplyToken,
  buildReplyAddress,
  extractReplyToken,
  findReplyTokenInRecipients,
  isReplyToken,
  replyTokenFingerprint,
} from "../../src/lib/domain/email/reply-address.js";
import {
  resolveConversationReplyAddress,
  REPLY_ALIAS_FLAG_KEY,
} from "../../src/lib/domain/email/reply-alias-store.js";
import { dispatchEmailQueueRow } from "../../src/lib/domain/email/dispatch-email-queue-row.js";

const DOMAIN = "reply.example.net";

// ── token generation ────────────────────────────────────────────────────────

test("a minted token is versioned, 128 bits, and lowercase hex", () => {
  const token = generateReplyToken();
  assert.match(token, /^r1\.[0-9a-f]{32}$/);
  assert.equal(isReplyToken(token), true);
});

test("ten thousand tokens collide zero times", () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i += 1) seen.add(generateReplyToken());
  assert.equal(seen.size, 10_000);
});

test("a token carries no information about the conversation it belongs to", () => {
  // Nothing about the input can influence the output, because there is no input.
  assert.equal(generateReplyToken.length, 0);
  const a = generateReplyToken();
  const b = generateReplyToken();
  assert.notEqual(a, b);
});

// ── address construction ────────────────────────────────────────────────────

test("a well-formed token and domain build an address", () => {
  const token = generateReplyToken();
  const built = buildReplyAddress({ token, reply_domain: DOMAIN });
  assert.equal(built.ok, true);
  assert.equal(built.address, `${token}@${DOMAIN}`);
});

test("a leading @ on the domain is tolerated, not rejected as unusable", () => {
  const built = buildReplyAddress({ token: generateReplyToken(), reply_domain: `@${DOMAIN}` });
  assert.equal(built.ok, true);
  assert.equal(built.domain, DOMAIN);
});

test("a malformed token never builds an address", () => {
  for (const token of ["", null, undefined, "r1.short", "r1." + "z".repeat(32), "deadbeef", "r2." + "a".repeat(32)]) {
    assert.equal(buildReplyAddress({ token, reply_domain: DOMAIN }).ok, false, String(token));
  }
});

test("a malformed domain never builds an address", () => {
  for (const domain of ["", null, "localhost", "no dots", "reply.example.net/../evil", "-bad.example.net"]) {
    assert.equal(
      buildReplyAddress({ token: generateReplyToken(), reply_domain: domain }).ok,
      false,
      String(domain)
    );
  }
});

// ── extraction and tamper ───────────────────────────────────────────────────

test("a token round-trips out of the address it was built into", () => {
  const token = generateReplyToken();
  const { address } = buildReplyAddress({ token, reply_domain: DOMAIN });
  const back = extractReplyToken(address);
  assert.equal(back.ok, true);
  assert.equal(back.token, token);
});

test("a display-name form still yields the token", () => {
  const token = generateReplyToken();
  const back = extractReplyToken(`"Reivesti Acquisitions" <${token}@${DOMAIN}>`);
  assert.equal(back.ok, true);
  assert.equal(back.token, token);
});

test("a token that merely APPEARS INSIDE another local part is not a token", () => {
  // bob.r1.<hex>@ is a different mailbox belonging to a different person, and
  // treating it as an alias would attribute their mail to a seller's thread.
  const token = generateReplyToken();
  const hex = token.slice(3);
  for (const local of [`bob.${token}`, `${token}.forwarded`, `x${token}`, `${token}-old`]) {
    const result = extractReplyToken(`${local}@${DOMAIN}`);
    assert.equal(result.ok, false, local);
  }
  // Sanity: the bare form still works, so the negatives above are not vacuous.
  assert.equal(extractReplyToken(`r1.${hex}@${DOMAIN}`).ok, true);
});

test("a tampered token is refused rather than resolved to a neighbour", () => {
  const token = generateReplyToken();
  const flipped = `r1.${token.slice(3, 34).padEnd(31, "0")}Z`;
  assert.equal(extractReplyToken(`${flipped}@${DOMAIN}`).ok, false);
});

test("uppercase in the local part still resolves; a token is case-insensitive hex", () => {
  const token = generateReplyToken();
  const shouty = token.toUpperCase();
  const result = extractReplyToken(`${shouty}@${DOMAIN.toUpperCase()}`);
  assert.equal(result.ok, true);
  assert.equal(result.token, token);
});

test("hostile recipient strings never throw", () => {
  for (const value of [null, undefined, "", "@", "a@", "@b", "<<>>", "x".repeat(5000), {}, []]) {
    assert.doesNotThrow(() => extractReplyToken(value));
  }
});

// ── recipient selection ─────────────────────────────────────────────────────

test("the envelope recipient wins over seller-controlled To and Cc", () => {
  const envelope = generateReplyToken();
  const forged = generateReplyToken();
  const found = findReplyTokenInRecipients({
    envelope_to: `${envelope}@${DOMAIN}`,
    to: [`${forged}@${DOMAIN}`],
  });
  assert.equal(found.ok, true);
  assert.equal(found.token, envelope);
  assert.equal(found.source, "envelope_to");
});

test("two DIFFERENT tokens across recipients is a refusal, not a preference", () => {
  const found = findReplyTokenInRecipients({
    to: [`${generateReplyToken()}@${DOMAIN}`],
    cc: [`${generateReplyToken()}@${DOMAIN}`],
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, "multiple_distinct_reply_tokens");
});

test("the SAME token repeated across recipients resolves normally", () => {
  const token = generateReplyToken();
  const found = findReplyTokenInRecipients({
    to: [`${token}@${DOMAIN}`],
    cc: [{ email: `${token}@${DOMAIN}` }],
  });
  assert.equal(found.ok, true);
  assert.equal(found.token, token);
});

test("no token anywhere is a plain absence, not an error", () => {
  const found = findReplyTokenInRecipients({ envelope_to: "team@example.net", to: ["a@example.net"] });
  assert.equal(found.ok, false);
  assert.equal(found.reason, "no_reply_token_in_recipients");
});

// ── logging safety ──────────────────────────────────────────────────────────

test("a fingerprint correlates without being usable as a credential", () => {
  const token = generateReplyToken();
  const print = replyTokenFingerprint(token);
  assert.equal(print, replyTokenFingerprint(token));
  assert.notEqual(print, replyTokenFingerprint(generateReplyToken()));
  assert.equal(print.length, 12);
  assert.equal(print.includes(token.slice(3)), false);
});

// ── the store: gating ───────────────────────────────────────────────────────

function stubSupabase(handlers = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, filters: {} };
      const chain = {
        select() { return chain; },
        eq(column, value) { state.filters[column] = value; return chain; },
        insert(row) { state.insert = row; return chain; },
        async maybeSingle() {
          calls.push(state);
          if (state.insert) return (handlers.insert || (() => ({ data: null, error: null })))(state);
          return (handlers.select || (() => ({ data: null, error: null })))(state);
        },
      };
      return chain;
    },
  };
}

const CONVERSATION = {
  opportunity_id: "11111111-1111-4111-8111-111111111111",
  master_owner_id: "owner-1",
  property_id: "prop-1",
};

test("with no reply domain configured, aliasing degrades and never touches the database", async () => {
  const supabase = stubSupabase();
  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase,
    reply_domain: "",
    getSystemFlag: async () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.degrade, true);
  assert.equal(result.reason, "reply_domain_not_configured");
  assert.equal(supabase.calls.length, 0);
});

test("with the operator attestation off, aliasing degrades before any query", async () => {
  // This is the control that stops a Reply-To being advertised on a domain whose
  // MX is not live yet. Off must mean OFF, including not reading the table.
  const supabase = stubSupabase();
  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase,
    reply_domain: DOMAIN,
    getSystemFlag: async (key) => {
      assert.equal(key, REPLY_ALIAS_FLAG_KEY);
      return false;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reply_aliases_not_enabled");
  assert.equal(supabase.calls.length, 0);
});

test("a conversation with no anchor at all is refused, never given a dangling alias", async () => {
  const result = await resolveConversationReplyAddress(
    { property_id: "prop-only" },
    { supabase: stubSupabase(), reply_domain: DOMAIN, getSystemFlag: async () => true }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conversation_has_no_anchor");
});

// ── the store: get-or-create ────────────────────────────────────────────────

test("an existing active alias is REUSED, not replaced", async () => {
  const token = generateReplyToken();
  let inserts = 0;
  const supabase = stubSupabase({
    select: () => ({ data: { id: "alias-1", token, reply_domain: DOMAIN, is_active: true }, error: null }),
    insert: () => { inserts += 1; return { data: null, error: null }; },
  });

  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.address, `${token}@${DOMAIN}`);
  assert.equal(result.created, false);
  assert.equal(inserts, 0);
});

test("a conversation with no alias yet gets exactly one minted", async () => {
  let inserted = null;
  const supabase = stubSupabase({
    select: () => ({ data: null, error: null }),
    insert: (state) => {
      inserted = state.insert;
      return { data: { id: "alias-new", token: state.insert.token, reply_domain: DOMAIN, is_active: true }, error: null };
    },
  });

  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.match(result.address, new RegExp(`^r1\\.[0-9a-f]{32}@${DOMAIN}$`));
  assert.equal(inserted.opportunity_id, CONVERSATION.opportunity_id);
  assert.equal(inserted.master_owner_id, CONVERSATION.master_owner_id);
  assert.equal(inserted.token_version, "r1");
});

test("a lost insert race re-reads the winner's alias instead of minting a rival", async () => {
  // Two runner instances send to the same seller at the same moment. The partial
  // unique index makes one insert fail; the loser must adopt the winner's row.
  const winner = generateReplyToken();
  let conflicted = false;
  const supabase = stubSupabase({
    // Before the conflict the loser genuinely sees nothing; after it, the
    // winner's row is committed and visible.
    select: () => (conflicted
      ? { data: { id: "alias-winner", token: winner, reply_domain: DOMAIN, is_active: true }, error: null }
      : { data: null, error: null }),
    insert: () => { conflicted = true; return { data: null, error: { code: "23505", message: "duplicate key" } }; },
  });

  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.raced, true);
  assert.equal(result.address, `${winner}@${DOMAIN}`);
});

test("a revoked alias degrades rather than being handed out again", async () => {
  const supabase = stubSupabase({
    select: () => ({
      data: { id: "alias-dead", token: generateReplyToken(), reply_domain: DOMAIN, is_active: false },
      error: null,
    }),
  });
  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reply_alias_revoked");
});

test("a lookup failure degrades and does NOT mint a duplicate alias", async () => {
  // Minting on a read failure is how a conversation ends up with two live reply
  // addresses: the row exists, we just could not see it.
  let inserts = 0;
  const supabase = stubSupabase({
    select: () => ({ data: null, error: { code: "500", message: "upstream unavailable" } }),
    insert: () => { inserts += 1; return { data: null, error: null }; },
  });
  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reply_alias_lookup_failed");
  assert.equal(inserts, 0);
});

test("an alias keeps the domain it was minted with, even after the config changes", async () => {
  const token = generateReplyToken();
  const supabase = stubSupabase({
    select: () => ({ data: { id: "alias-old", token, reply_domain: "old.example.net", is_active: true }, error: null }),
  });
  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true,
  });
  // Mail already in the seller's inbox names the old domain. Rewriting the row
  // would break exactly the messages a durable alias exists to protect.
  assert.equal(result.ok, true);
  assert.equal(result.address, `${token}@old.example.net`);
});

// ── the dispatch path ───────────────────────────────────────────────────────

function dispatchDeps(overrides = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      getSystemFlag: async () => true,
      getSystemValue: async () => null,
      resolveEligibility: async () => ({ eligible: true }),
      loadSender: async () => ({
        id: "sender-1",
        from_email: "acq@mail.example.net",
        sender_name: "Acquisitions",
        reply_to_email: "team@example.net",
        status: "active",
        daily_limit: 500,
        sent_today: 0,
      }),
      store: {
        getOrCreateLogicalCommunication: async () => ({ ok: true, id: "lc-1" }),
        allocateAttempt: async () => ({ ok: true, attempt_number: 1, id: "att-1" }),
      },
      transport: { send: async (args) => { sent.push(args); return { ok: true, provider_message_id: "m1" }; } },
      ...overrides,
    },
  };
}

const QUEUE_ROW = {
  id: "q-1",
  logical_communication_id: "lc-1",
  to_email: "seller@example.org",
  subject: "Following up on your property",
  email_body: "<p>Hello</p>",
  text_body: "Hello",
  master_owner_id: "owner-1",
  property_id: "prop-1",
  opportunity_id: "11111111-1111-4111-8111-111111111111",
};

test("dry run reports the conversation alias as the reply path", async () => {
  const token = generateReplyToken();
  const { deps } = dispatchDeps({
    dry_run: true,
    resolveReplyAddress: async () => ({ ok: true, address: `${token}@${DOMAIN}`, alias_id: "alias-1" }),
  });
  const result = await dispatchEmailQueueRow(QUEUE_ROW, deps);
  assert.equal(result.ok, true);
  assert.equal(result.would_send.reply_path, "conversation_alias");
  assert.equal(result.would_send.reply_to, `${token}@${DOMAIN}`);
});

test("a degraded alias falls back to the sender's mailbox and SAYS SO", async () => {
  const { deps } = dispatchDeps({
    dry_run: true,
    resolveReplyAddress: async () => ({ ok: false, degrade: true, reason: "reply_aliases_not_enabled" }),
  });
  const result = await dispatchEmailQueueRow(QUEUE_ROW, deps);
  // The send is NOT refused: the seller can still reply, they just land in the
  // unmatched queue instead of resolving at tier 1.
  assert.equal(result.ok, true);
  assert.equal(result.would_send.reply_path, "sender_default");
  assert.equal(result.would_send.reply_to, "team@example.net");
  assert.equal(result.would_send.reply_alias_reason, "reply_aliases_not_enabled");
});

test("the alias resolver is asked for the CONVERSATION, not the queue row", async () => {
  let asked = null;
  const { deps } = dispatchDeps({
    dry_run: true,
    resolveReplyAddress: async (input) => { asked = input; return { ok: false, degrade: true, reason: "x" }; },
  });
  await dispatchEmailQueueRow(QUEUE_ROW, deps);
  assert.equal(asked.opportunity_id, QUEUE_ROW.opportunity_id);
  assert.equal(asked.master_owner_id, "owner-1");
  assert.equal(asked.property_id, "prop-1");
});

test("two sends in the same conversation carry the SAME Reply-To", async () => {
  // The anti-fragmentation property, exercised through the real store against a
  // table that already holds the conversation's alias.
  const token = generateReplyToken();
  const supabase = stubSupabase({
    select: () => ({ data: { id: "alias-1", token, reply_domain: DOMAIN, is_active: true }, error: null }),
  });
  const resolveReplyAddress = (input) =>
    resolveConversationReplyAddress(input, { supabase, reply_domain: DOMAIN, getSystemFlag: async () => true });

  const first = dispatchDeps({ dry_run: true, resolveReplyAddress });
  const second = dispatchDeps({ dry_run: true, resolveReplyAddress });

  const a = await dispatchEmailQueueRow(QUEUE_ROW, first.deps);
  const b = await dispatchEmailQueueRow({ ...QUEUE_ROW, id: "q-2", subject: "Second touch" }, second.deps);

  assert.equal(a.would_send.reply_to, `${token}@${DOMAIN}`);
  assert.equal(b.would_send.reply_to, a.would_send.reply_to);
  assert.equal(b.would_send.reply_path, "conversation_alias");
});

test("a retry of the SAME message reuses the alias rather than minting a rival", async () => {
  const token = generateReplyToken();
  let inserts = 0;
  const supabase = stubSupabase({
    select: () => ({ data: { id: "alias-1", token, reply_domain: DOMAIN, is_active: true }, error: null }),
    insert: () => { inserts += 1; return { data: null, error: null }; },
  });
  const call = () =>
    resolveConversationReplyAddress(CONVERSATION, { supabase, reply_domain: DOMAIN, getSystemFlag: async () => true });

  const first = await call();
  const retry = await call();
  assert.equal(first.address, retry.address);
  assert.equal(inserts, 0);
});

test("a read-only resolution never mints, so a dry run leaves no rows behind", async () => {
  let inserts = 0;
  const supabase = stubSupabase({
    select: () => ({ data: null, error: null }),
    insert: () => { inserts += 1; return { data: null, error: null }; },
  });
  const result = await resolveConversationReplyAddress(CONVERSATION, {
    supabase, reply_domain: DOMAIN, getSystemFlag: async () => true, allow_mint: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reply_alias_not_minted_read_only");
  assert.equal(inserts, 0);
});

test("a dry-run dispatch never asks the resolver to mint", async () => {
  let allow_mint = "unset";
  const { deps } = dispatchDeps({
    dry_run: true,
    resolveReplyAddress: async (_input, options) => {
      allow_mint = options?.allow_mint;
      return { ok: false, degrade: true, reason: "reply_alias_not_minted_read_only" };
    },
  });
  await dispatchEmailQueueRow(QUEUE_ROW, deps);
  assert.equal(allow_mint, false);
});

test("a real dispatch DOES allow minting", async () => {
  let allow_mint = "unset";
  const { deps } = dispatchDeps({
    dry_run: true,
    resolveReplyAddress: async (_input, options) => { allow_mint = options?.allow_mint; return { ok: false, degrade: true, reason: "x" }; },
  });
  // dispatchEmailQueueRow reads deps.dry_run; flip it to prove the other branch.
  // The seam beyond this point needs a fuller store than this test supplies, and
  // does not need one: the assertion is about what the resolver was asked, which
  // happens before the seam is entered at all.
  await dispatchEmailQueueRow(QUEUE_ROW, { ...deps, dry_run: false }).catch(() => null);
  assert.equal(allow_mint, true);
});

test("hostile input to the resolver never throws", async () => {
  for (const input of [null, undefined, "", 0, [], { opportunity_id: {} }]) {
    await assert.doesNotReject(() =>
      resolveConversationReplyAddress(input, {
        supabase: stubSupabase(), reply_domain: DOMAIN, getSystemFlag: async () => true,
      })
    );
  }
});
