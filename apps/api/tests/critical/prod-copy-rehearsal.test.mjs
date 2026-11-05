/**
 * PRODUCTION-COPY REHEARSAL — guard and "unknown eligibility is never contactable" (docs/PRODUCTION-COPY-REHEARSAL.md).
 *
 * The rehearsal tool (scripts/db/prod-copy-rehearsal.mjs) restores an owner-supplied backup into an ISOLATED local
 * PostgreSQL. These tests never connect anywhere: the guard is static (it refuses before any process is spawned) and the
 * eligibility rule is a pure function over the reader's eligibility read.
 *
 *   node --test tests/critical/prod-copy-rehearsal.test.mjs          (from apps/api)
 *   node --test apps/api/tests/critical/prod-copy-rehearsal.test.mjs (from the repository root)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRODUCTION_PROJECT_REF } from "../../../../scripts/db/db-target-guard.mjs";
import { MIGRATION_TESTS } from "../../../../scripts/db/migration-tests.manifest.mjs";
import {
  guardTarget,
  assertRehearsalUrl,
  assertDbName,
  eligibilityVerdict,
  aggregateEligibility,
  assertContactInvariant,
  finalizeRanking,
  projectRanked,
  assertNoPii,
  foldSmallCells,
  switchesOff,
  auditPins,
  planSection1Sql,
  extractGrantees,
  parseTocList,
  summarizeRestoreErrors,
  LINKS,
  SYNTH_PREFIX,
  main,
} from "../../../../scripts/db/prod-copy-rehearsal.mjs";

const LOCAL = "postgres://postgres@127.0.0.1:54341/postgres";
// hosted names are assembled at run time so this file never carries a literal production-shaped host
const SB = ["supa", "base"].join("");
const HOSTED = [
  `postgresql://postgres:secret@db.example-project.${SB}.co:5432/postgres`,
  `postgresql://postgres.abcdefghij:secret@aws-0-us-east-1.${["poo", "ler"].join("")}.${SB}.com:6543/postgres`,
  `postgresql://postgres:secret@db.${PRODUCTION_PROJECT_REF}.example:5432/postgres`,
  "postgresql://admin:secret@prod-db.abc123.us-east-1.rds.amazonaws.com:5432/postgres",
  "postgresql://admin:secret@ep-quiet-sky-123456.us-east-2.aws.neon.tech/neondb",
  "postgresql://admin:secret@10.0.0.5:5432/postgres",
  "postgresql://admin:secret@db.internal:5432/postgres",
  "postgresql://admin@127.0.0.1:5432,10.0.0.5:5432/postgres",
  "postgresql://admin@localhost/postgres?host=db.internal",
  "postgresql://admin@localhost/postgres?hostaddr=192.168.1.20",
];

test("guard: refuses every hosted / remote / Supabase-looking target, before connecting", () => {
  for (const url of HOSTED) {
    assert.throws(() => guardTarget({ adminUrl: url, db: "lc_prodcopy_test" }), /refused/, url);
    assert.throws(() => assertRehearsalUrl(url), /refused/, url);
  }
});

test("guard: LC_DISPOSABLE_DB_HOST (the migration runner's CI escape hatch) is never honoured", () => {
  const before = process.env.LC_DISPOSABLE_DB_HOST;
  process.env.LC_DISPOSABLE_DB_HOST = "db.internal";
  try {
    assert.throws(() => guardTarget({ adminUrl: "postgresql://admin@db.internal:5432/postgres", db: "lc_prodcopy_test" }), /refused/);
  } finally {
    if (before === undefined) delete process.env.LC_DISPOSABLE_DB_HOST;
    else process.env.LC_DISPOSABLE_DB_HOST = before;
  }
});

test("guard: refuses keyword conninfo, a URL without an explicit host, and an admin URL that names a rehearsal database", () => {
  assert.throws(() => assertRehearsalUrl("host=127.0.0.1 dbname=postgres"), /postgres:\/\//);
  assert.throws(() => assertRehearsalUrl("postgresql:///postgres"), /names no host/);
  assert.throws(() => assertRehearsalUrl(""), /no database URL/);
  assert.throws(() => guardTarget({ adminUrl: "postgres://postgres@127.0.0.1:54341/lc_prodcopy_other", db: "lc_prodcopy_test" }), /maintenance database/);
});

test("guard: refuses a database not named lc_prodcopy_<tag>", () => {
  for (const db of ["postgres", "template1", "lc_prodcopy", "lc_prodcopy_", "LC_PRODCOPY_x", "lc_prodcopy_X", "lc_prodcopy_a;drop", "lc_prodcopy_a-b", "prod_lc_prodcopy_a", "lc_mt_test", null, undefined, ""]) {
    assert.throws(() => guardTarget({ adminUrl: LOCAL, db }), /refused/, String(db));
  }
  // the synthetic builder only ever writes lc_prodcopy_synth_* (a restored production copy is lc_prodcopy_<tag>)
  assert.throws(() => assertDbName("lc_prodcopy_real_20261030", SYNTH_PREFIX), /does not start with lc_prodcopy_synth_/);
  assert.equal(assertDbName("lc_prodcopy_synth_20261030", SYNTH_PREFIX), "lc_prodcopy_synth_20261030");
});

test("guard: accepts a loopback or unix-socket server and derives the rehearsal database URL", () => {
  const ok = [
    ["postgres://postgres@127.0.0.1:54341/postgres", "postgres://postgres@127.0.0.1:54341/lc_prodcopy_20261030"],
    ["postgresql://postgres@localhost:5432/postgres", "postgresql://postgres@localhost:5432/lc_prodcopy_20261030"],
    ["postgresql://postgres@[::1]:5432/postgres", "postgresql://postgres@[::1]:5432/lc_prodcopy_20261030"],
    ["postgresql://postgres@/postgres?host=/tmp/lcpg-automsg&port=54341", "postgresql://postgres@/lc_prodcopy_20261030?host=/tmp/lcpg-automsg&port=54341"],
  ];
  for (const [admin, expected] of ok) {
    const g = guardTarget({ adminUrl: admin, db: "lc_prodcopy_20261030" });
    assert.equal(g.url, expected);
    assert.equal(g.db, "lc_prodcopy_20261030");
  }
});

test("guard: the CLI refuses a hosted target with exit 3 and writes nothing", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lc-prodcopy-test-"));
  const evidence = path.join(out, "ev");
  const code = await main(["guard", "--admin-url", HOSTED[0], "--db", "lc_prodcopy_test", "--out", evidence]);
  assert.equal(code, 3);
  assert.equal(fs.existsSync(evidence), false);
  const code2 = await main(["guard", "--admin-url", LOCAL, "--db", "postgres", "--out", evidence]);
  assert.equal(code2, 3);
  fs.rmSync(out, { recursive: true, force: true });
});

// ── eligibility: eligible / blocked / UNKNOWN, unknown never contactable ──────────────────────────────────
const COMPLETE = Object.freeze({
  thread_found: true,
  eligible_for_outreach: true,
  blocking_reasons: [],
  sources: { sms_suppression_list: true, automation_suppressions: true, automation_hold_for: true, contact_property_resolution: true, phones: true },
  contact_property: { role: "confirmed_owner", rejected: false },
  thread_flags: { contactability_status: "contactable", paused: false },
  phone_rows: [{ phone_type: "wireless", contact_status: "active", activity_status: "active", wrong_number_at: null }],
});
const variant = (patch) => ({ ...COMPLETE, ...patch });

test("eligibility: only a complete, affirmed read is eligible (and only eligible is contactable)", () => {
  const v = eligibilityVerdict({ eligibility: COMPLETE });
  assert.equal(v.verdict, "eligible");
  assert.equal(v.contactable, true);
  assert.equal(v.authoritative, false);
});

test("eligibility: every missing input is UNKNOWN, and UNKNOWN is never contactable", () => {
  const unknowns = [
    [null, "eligibility_read_unavailable"],
    [{ thread_found: false }, "thread_not_found"],
    [variant({ contact_property: null }), "ownership_unconfirmed"],
    [variant({ contact_property: { role: "unknown", rejected: false } }), "ownership_unconfirmed"],
    [variant({ phone_rows: [] }), "no_phone_record"],
    [variant({ phone_rows: [{ phone_type: null, contact_status: "active", activity_status: "active" }] }), "line_type_unknown"],
    [variant({ phone_rows: [{ phone_type: "wireless", contact_status: "active", activity_status: null }] }), "phone_activity_unknown"],
    [variant({ sources: { ...COMPLETE.sources, automation_hold_for: false } }), "holds_unavailable"],
    [variant({ sources: { ...COMPLETE.sources, contact_property_resolution: false } }), "ownership_source_unavailable"],
    [variant({ thread_flags: { contactability_status: null } }), "contactability_not_recorded"],
    [variant({ eligible_for_outreach: null }), "eligibility_not_affirmed"],
  ];
  for (const [input, reason] of unknowns) {
    const v = eligibilityVerdict({ eligibility: input });
    assert.equal(v.verdict, "unknown", reason);
    assert.equal(v.contactable, false, reason);
    assert.ok(v.unknown_reasons.includes(reason), `${reason} in ${v.unknown_reasons}`);
  }
  // the worklist's own reading: a possible opt-out text is unknown even when every input is complete
  const w = eligibilityVerdict({ eligibility: COMPLETE, worklistContact: { state: "unknown", blockers: [], unknowns: ["possible_opt_out_text", "phone_and_ownership_not_read_here"] } });
  assert.equal(w.verdict, "unknown");
  assert.equal(w.contactable, false);
  assert.deepEqual(w.unknown_reasons, ["possible_opt_out_text"]);
});

test("eligibility: any blocker wins (blocked, never contactable)", () => {
  const blocked = [
    variant({ eligible_for_outreach: false, blocking_reasons: ["suppression_list_active"] }),
    variant({ contact_property: { role: "not_owner", rejected: false } }),
    variant({ contact_property: { role: "confirmed_owner", rejected: true } }),
    variant({ phone_rows: [{ phone_type: "landline", contact_status: "active", activity_status: "active" }] }),
    variant({ phone_rows: [{ phone_type: "wireless", contact_status: "opted_out", activity_status: "active" }] }),
    variant({ thread_flags: { contactability_status: "contactable", paused: true } }),
    // blocked even when another input is unknown
    variant({ eligible_for_outreach: false, blocking_reasons: ["hold_blocks_ai_action"], contact_property: null }),
  ];
  for (const input of blocked) {
    const v = eligibilityVerdict({ eligibility: input });
    assert.equal(v.verdict, "blocked", JSON.stringify(input));
    assert.equal(v.contactable, false);
  }
  const fromWorklist = eligibilityVerdict({ eligibility: COMPLETE, worklistContact: { blockers: ["opt_out_text_read"], unknowns: [] } });
  assert.equal(fromWorklist.verdict, "blocked");
});

test("eligibility: the census aggregate counts unknown apart and never as contactable", () => {
  const verdicts = [
    eligibilityVerdict({ eligibility: COMPLETE }),
    eligibilityVerdict({ eligibility: variant({ contact_property: null }) }),
    eligibilityVerdict({ eligibility: null }),
    eligibilityVerdict({ eligibility: variant({ eligible_for_outreach: false, blocking_reasons: ["thread_opt_out"] }) }),
  ];
  const a = aggregateEligibility(verdicts);
  assert.equal(a.threads, 4);
  assert.equal(a.eligible, 1);
  assert.equal(a.unknown, 2);
  assert.equal(a.blocked, 1);
  assert.equal(a.contactable, 1);
  assert.equal(a.contactable, a.eligible);
  assert.equal(a.unknown_counted_as_contactable, 0);
  assert.deepEqual(a.by_unknown_reason, { ownership_unconfirmed: 1, eligibility_read_unavailable: 1 });
  // a forged record that calls unknown contactable is refused, never counted
  assert.throws(() => aggregateEligibility([{ verdict: "unknown", contactable: true, blocking_reasons: [], unknown_reasons: [] }]), /only eligible is contactable/);
  assert.throws(() => assertContactInvariant([{ verdict: "blocked", contactable: true }]), /only eligible is contactable/);
  assert.throws(() => assertContactInvariant([{ verdict: "maybe", contactable: false }]), /unknown verdict/);
});

test("hidden-gold: an unknown-eligibility opportunity is ranked but marked not contactable, and its next step is human review", () => {
  const row = {
    thread_id: "5e000000-0000-4000-8000-000000000102", property_id: "2109512384", last_inbound_at: "2026-10-29T00:00:00.000Z",
    interest: { state: "interest", basis: [{ signal: "interest", message_id: "5e000000-0000-4000-8000-00000000a022" }] },
    readings: { price_mentions: [], timeline_mentions: [] }, inbound: [{ id: "5e000000-0000-4000-8000-00000000a022" }], verified: { state: "unanswered" },
  };
  const ranked = { score: 75, factors: [{ factor: "interest", points: 40, evidence: "x" }, { factor: "unanswered_verified", points: 15, evidence: "y" }], flags: [], next_step: "draft_reply_for_human_approval" };
  const unknown = eligibilityVerdict({ eligibility: variant({ contact_property: null }) });
  const rec = projectRanked(row, ranked, unknown);
  assert.equal(rec.eligibility.verdict, "unknown");
  assert.equal(rec.eligibility.contactable, false);
  assert.equal(rec.next_step, "human_review_eligibility_unknown");
  assert.equal(rec.category, "unanswered_interested_seller");
  assert.deepEqual(rec.evidence_message_ids, ["5e000000-0000-4000-8000-00000000a022"]);
  assert.equal(JSON.stringify(rec).includes('"evidence"'), false, "factor evidence text stays out of the default output");
  const eligible = projectRanked({ ...row, thread_id: "t-eligible" }, { ...ranked, score: 90 }, eligibilityVerdict({ eligibility: COMPLETE }));
  const out = finalizeRanking([rec, eligible]);
  assert.deepEqual(out.map((r) => [r.rank, r.thread_id, r.eligibility.contactable]), [[1, "t-eligible", true], [2, row.thread_id, false]]);
  assert.ok(out.every((r) => r.eligibility.verdict === "eligible" || r.eligibility.contactable === false));
  assert.throws(() => finalizeRanking([{ ...rec, eligibility: { ...rec.eligibility, contactable: true } }]), /only eligible is contactable/);
});

test("privacy: default outputs refuse names, phones, emails, addresses and message text; opaque ids pass", () => {
  assert.throws(() => assertNoPii({ ranked: [{ latest_seller_text: "hi" }] }), /forbidden key/);
  assert.throws(() => assertNoPii({ note: "call 555-010-0101" }), /phone-shaped/);
  assert.throws(() => assertNoPii({ note: "+15550100101" }), /phone-shaped/);
  assert.throws(() => assertNoPii({ note: "seller@example.invalid" }), /email-shaped/);
  assert.throws(() => assertNoPii({ note: "101 Example Rd" }), /street-address-shaped/);
  assert.throws(() => assertNoPii({ thread_key: "x" }), /forbidden key/);
  assert.equal(assertNoPii({ property_id: "2109512384", evidence_message_ids: ["5e000000-0000-4000-8000-000000000101"], sha256: "0123456789012345678901234567890123456789012345678901234567890123", as_of: "2026-10-30T05:12:01.123Z", n: 5550100101 }), true);
  assert.deepEqual(foldSmallCells({ a: 10, b: 2, c: 1 }, 5), { a: 10, "(2 group(s) under 5, folded)": 3 });
});

test("switches: OFF means absent or false; anything else stops the rehearsal", () => {
  assert.equal(switchesOff({}).ok, true);
  assert.equal(switchesOff({ ai_agent_text_enabled: "false", ai_agent_message_enabled: "FALSE", ai_conversation_send_enabled: "false" }).ok, true);
  assert.equal(switchesOff({ ai_agent_text_enabled: "true" }).ok, false);
  assert.equal(switchesOff({ ai_conversation_send_enabled: "true" }).ok, false);
  assert.equal(switchesOff({ ai_agent_message_enabled: "yes" }).ok, false);
});

test("migrate inputs: the five links are pinned by the diff audit and exist in the runner manifest", () => {
  const pins = auditPins();
  assert.equal(LINKS.length, 5);
  for (const L of LINKS) {
    const t = MIGRATION_TESTS.find((x) => x.id === L.id);
    assert.ok(t, L.id);
    const pin = pins[path.basename(t.apply[0])];
    assert.ok(pin, `pin for ${t.apply[0]}`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.ok(t.pretest && t.posttest?.length && t.rollback?.length && t.rollbackPosttest?.length, `${L.id} has its full fixture set`);
  }
  assert.match(planSection1Sql(), /^select to_regclass\('public\.ai_generated_messages'\)/);
});

test("restore helpers: grantees, TOC parsing and error summaries carry metadata only", () => {
  const sql = [
    "GRANT ALL ON TABLE public.t TO anon;",
    "REVOKE ALL ON FUNCTION public.f(text) FROM PUBLIC;",
    "GRANT EXECUTE ON FUNCTION public.g() TO lc_mcp_reader, \"service_role\";",
    "CREATE POLICY p ON public.t FOR SELECT TO authenticated USING ((exists (select 1 from public.u)));",
    "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;",
  ].join("\n");
  assert.deepEqual(extractGrantees(sql), ["anon", "authenticated", "lc_mcp_reader", "postgres", "service_role", "supabase_admin"]);
  const toc = parseTocList([
    "; Archive created at 2026-10-30 05:00:00 UTC",
    ";     dbname: postgres",
    "4; 2615 2200 SCHEMA - public pg_database_owner",
    "5000; 0 16400 TABLE DATA public message_events postgres",
    "6000; 0 0 ACL public TABLE message_events postgres",
    "6001; 0 0 DEFAULT ACL - DEFAULT PRIVILEGES FOR TABLES postgres",
  ].join("\n"));
  assert.equal(toc.header.dbname, "postgres");
  assert.deepEqual(toc.by_type, { SCHEMA: 1, "TABLE DATA": 1, ACL: 1, "DEFAULT ACL": 1 });
  assert.deepEqual(toc.table_data, ["public.message_events"]);
  const s = summarizeRestoreErrors([
    "pg_restore: error: COPY failed for table \"message_events\": ERROR:  invalid input syntax",
    "CONTEXT:  COPY message_events, line 1: \"Call me at 555-010-0101, 101 Example Rd\"",
    "pg_restore: error: could not execute query: ERROR:  role \"supabase_admin\" does not exist",
    "Command was: ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin GRANT ALL ON TABLES TO postgres;",
    "pg_restore: warning: errors ignored on restore: 2",
  ].join("\n"));
  assert.equal(s.errors, 2);
  assert.deepEqual(s.by_class, { copy_failed: 1, role_missing: 1 });
  assert.equal(JSON.stringify(s).includes("555"), false);
  assert.equal(JSON.stringify(s).includes("Example"), false);
});
