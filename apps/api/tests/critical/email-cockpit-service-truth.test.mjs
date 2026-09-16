/**
 * EMAIL-COMMAND-MOBILE-LOCK-1 §43 — the cockpit email service.
 *
 * Every case here pins a defect that was live in production on 2026-09-16.
 * All Supabase access is injected, so nothing touches a real database.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  getEmailOverview,
  getEmailRecords,
  getEmailThreads,
  getEmailThread,
  sendManualEmail,
  saveEmailDraft,
  __setEmailServiceDeps,
  __resetEmailServiceDeps,
} from "@/lib/domain/email/email-service.js";

/**
 * A Supabase stand-in. `rpc` answers from a map; `from(...)` records inserts
 * and answers selects. Anything not configured returns an ERROR, so a test
 * cannot accidentally pass because a read quietly returned nothing.
 */
function fakeDb({ rpc = {}, tables = {}, inserts = [] } = {}) {
  return {
    inserts,
    rpc(name, args) {
      if (!(name in rpc)) return Promise.resolve({ data: null, error: { message: `unmocked rpc ${name}` } });
      const value = typeof rpc[name] === "function" ? rpc[name](args) : rpc[name];
      return Promise.resolve(value);
    },
    from(table) {
      const state = { table, filters: {} };
      const builder = {
        select() { return builder; },
        eq(col, val) { state.filters[col] = val; return builder; },
        gte() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve(tables[table] ?? { data: null, error: null }); },
        insert(row) {
          inserts.push({ table, row });
          return {
            select() { return this; },
            maybeSingle() {
              return Promise.resolve(tables[`${table}:insert`] ?? { data: { id: "row-1", ...row }, error: null });
            },
          };
        },
        upsert(row) {
          inserts.push({ table, row, upsert: true });
          const result = tables[`${table}:upsert`] ?? { data: { id: "row-1", ...row }, error: null };
          // Chainable, because the real client is: .upsert().select().maybeSingle()
          const chain = {
            select() { return chain; },
            maybeSingle() { return Promise.resolve(result); },
            then(resolve) { return Promise.resolve(result).then(resolve); },
          };
          return chain;
        },
        update(patch) {
          inserts.push({ table, patch, update: true });
          return { eq() { return Promise.resolve({ error: null }); } };
        },
        then(resolve) { return Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve); },
      };
      return builder;
    },
  };
}

test.afterEach(() => __resetEmailServiceDeps());

// ---------------------------------------------------------------------------
// §28/§30 — a failed read is never a zero
// ---------------------------------------------------------------------------

/**
 * THE DEFECT. getEmailOverview() derived every headline from
 * getEmailRecords({limit:5000}) and fell back to `[]` when that failed, then
 * returned ok:true. Production answered HTTP 200 with nine zeros over a
 * 165,655-row corpus, so the surface told the operator there was no email data.
 */
test("overview reports a failed count read instead of returning zeros", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({ rpc: { get_email_overview_counts: { data: null, error: { message: "boom" } } } }),
  });
  const res = await getEmailOverview();
  assert.equal(res.ok, false, "a failed count must not be reported as success");
  assert.equal(res.total_emails, undefined, "no fabricated total may be published");
});

test("overview counts come from the predicate, not from a page of rows", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({
      rpc: {
        get_email_overview_counts: {
          data: [{
            total_emails: 165655, email_eligible: 165654, high_confidence: 159766,
            suppressed: 1, bounced: 1, unsubscribed: 0, ready_for_campaign: 165654,
          }],
          error: null,
        },
      },
      tables: { email_events: { data: [], error: null } },
    }),
  });
  const res = await getEmailOverview();
  assert.equal(res.ok, true);
  assert.equal(res.total_emails, 165655);
  assert.equal(res.suppressed, 1);
  assert.equal(res.sent_today, 0, "an empty event ledger is a true zero");
});

test("records report a failed count rather than claiming the page is the corpus", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({
      rpc: {
        get_email_records: { data: [{ email: "a@b.com" }], error: null },
        get_email_records_count: { data: null, error: { message: "count exploded" } },
      },
    }),
  });
  const res = await getEmailRecords({ limit: 25 });
  assert.equal(res.ok, false, "a page without a trustworthy count is not a success");
  assert.equal(res.error, "email_records_count_failed");
});

test("records pass the subject through to the database, not a client filter", async () => {
  let seen = null;
  __setEmailServiceDeps({
    supabase_override: fakeDb({
      rpc: {
        get_email_records: (args) => { seen = args; return { data: [], error: null }; },
        get_email_records_count: { data: 0, error: null },
      },
    }),
  });
  const res = await getEmailRecords({ limit: 10, property_id: "237787391" });
  assert.equal(res.ok, true);
  assert.equal(seen.p_property_id, "237787391", "the subject must be a server-side predicate");
  assert.equal(res.count, 0, "an unknown subject yields zero, never the whole corpus");
  assert.deepEqual(res.subject, { property_id: "237787391", master_owner_id: null });
});

// ---------------------------------------------------------------------------
// §30 — empty and failed are different
// ---------------------------------------------------------------------------

test("an empty thread ledger is ok with zero, not an error", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({
      rpc: {
        get_email_threads: { data: [], error: null },
        get_email_threads_count: { data: 0, error: null },
        get_email_folder_counts: { data: [{ folder: "all", thread_count: 0 }], error: null },
      },
    }),
  });
  const res = await getEmailThreads({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.threads, []);
  assert.equal(res.count, 0);
});

/** This is the read that used to answer "table not found" with HTTP 500. */
test("a failed thread read is reported as a failure", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({ rpc: { get_email_threads: { data: null, error: { message: "no such table" } } } }),
  });
  const res = await getEmailThreads({});
  assert.equal(res.ok, false);
  assert.equal(res.error, "email_threads_query_failed");
});

test("a missing thread is reported as missing, not as a blank thread", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({ rpc: { get_email_thread_messages: { data: [], error: null } } }),
  });
  const res = await getEmailThread("nobody@example.invalid");
  assert.equal(res.ok, true);
  assert.equal(res.thread, null, "no fabricated thread object");
  assert.equal(res.reason, "thread_not_found");
});

test("folder counts are omitted rather than reported as zero when unreadable", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({
      rpc: {
        get_email_threads: { data: [], error: null },
        get_email_threads_count: { data: 0, error: null },
        get_email_folder_counts: { data: null, error: { message: "nope" } },
      },
    }),
  });
  const res = await getEmailThreads({});
  assert.equal(res.ok, true);
  assert.equal(res.folder_counts, null, '"unknown" and "0" are different claims');
});

// ---------------------------------------------------------------------------
// §13 — suppression is the first gate
// ---------------------------------------------------------------------------

/**
 * Sender identity used to be resolved BEFORE suppression, so sending to a
 * suppressed address reported `sender_identity_missing` — hiding a compliance
 * refusal behind a configuration one, and leaving the suppression guard
 * unreachable until a sender existed.
 */
test("a suppressed recipient is refused for suppression, even with no sender configured", async () => {
  __setEmailServiceDeps({
    supabase_override: fakeDb({
      tables: {
        email_suppression: { data: { email_address: "x@y.com", reason: "hard_bounce", is_active: true }, error: null },
      },
    }),
  });
  const res = await sendManualEmail({ to: "x@y.com", subject: "s", body: "<p>b</p>" });
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.equal(res.error, "email_suppressed", "the compliance reason, not sender_identity_missing");
});

test("a send is never attempted for an invalid or bulk recipient", async () => {
  __setEmailServiceDeps({ supabase_override: fakeDb() });
  for (const [to, expected] of [["", "missing_email"], ["nope", "invalid_email"], ["a@b.com, c@d.com", "bulk_email_not_allowed"]]) {
    const res = await sendManualEmail({ to, subject: "s", body: "b" });
    assert.equal(res.ok, false, `${to} must be refused`);
    assert.equal(res.error, expected);
  }
});

// ---------------------------------------------------------------------------
// §19 — a draft is not a send
// ---------------------------------------------------------------------------

test("a draft is written with a non-dispatchable status and is not sent", async () => {
  const inserts = [];
  __setEmailServiceDeps({ supabase_override: fakeDb({ inserts, tables: { "email_queue:upsert": { error: null } } }) });
  const res = await saveEmailDraft({
    to: "draft@example.invalid", subject: "s", body: "<p>b</p>", draft_key: "d1",
  });
  assert.equal(res.ok, true);
  assert.equal(res.sent, false);
  assert.equal(res.status, "draft");
  const written = inserts.find((i) => i.table === "email_queue");
  assert.ok(written, "the draft must be durable");
  assert.equal(written.row.queue_status, "draft", "draft is not a dispatchable status");
  assert.equal(written.upsert, true, "re-saving updates rather than queueing a second copy");
});
