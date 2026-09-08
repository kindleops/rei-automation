/**
 * email-schema-column-contract.test.mjs
 *
 * EVERY COLUMN THE EMAIL CODE NAMES MUST ACTUALLY EXIST.
 *
 * This guard exists because the same defect happened three times in one phase,
 * and every instance was invisible:
 *
 *   email_queue.rfc_message_id           tier 2 could never match
 *   contact_outreach_state.podio_prospect_id   tier 4 could never match
 *   (and, before this phase, two code layers targeting tables that had never
 *    been created at all -- the EMAIL-0 finding)
 *
 * PostgREST rejects the WHOLE select for ONE unknown column. The code then logs
 * the error and returns an empty list, because that is the safe thing to do with
 * a failed lookup. So a typo'd or imagined column does not crash, does not fail
 * a test, and does not show up in review: it silently converts a working control
 * into a control that returns nothing, forever.
 *
 * That is the worst shape a defect can have. An absent feature is a known gap;
 * an inert one is a documented protection that is not there.
 *
 * HOW THIS WORKS. Column names are read out of the migration DDL and compared
 * against every column named in a `.select("…")` in the email domain. It is a
 * static check over text, so it cannot prove a query RUNS -- the executed
 * migration proof does that. What it can do is catch the exact failure above,
 * cheaply, on every commit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../supabase/migrations");
const EMAIL_SRC = path.resolve(HERE, "../../src/lib/domain/email");

/** Every migration, oldest first, so later ALTERs are applied over earlier DDL. */
function migrationSql() {
  return fs.readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8"))
    .join("\n");
}

/**
 * Columns per table, accumulated from CREATE TABLE bodies and ADD COLUMN
 * statements. Deliberately permissive: a column this misses produces a false
 * alarm a human resolves in seconds, while a column it invents would defeat the
 * whole point.
 */
function columnsByTable(sql) {
  const tables = new Map();
  // Tables whose FULL shape this reader has seen, because it read their CREATE
  // TABLE. A table known only through ALTER statements is known INCOMPLETELY,
  // and enforcing against a partial column set would report real columns as
  // phantom -- false alarms are how a guard like this gets ignored.
  const fully_known = new Set();
  const add = (table, column) => {
    const key = table.replace(/^public\./, "").toLowerCase();
    if (!tables.has(key)) tables.set(key, new Set());
    tables.get(key).add(column.toLowerCase());
  };

  const create = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_.]+)\s*\(([\s\S]*?)\n\);/gi;
  let match;
  while ((match = create.exec(sql)) !== null) {
    fully_known.add(match[1].replace(/^public\./, "").toLowerCase());
    for (const line of match[2].split("\n")) {
      const column = /^\s{2,}([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
      // Skip table-level constraints, which look like columns until you read them.
      if (column && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(column[1])) {
        add(match[1], column[1]);
      }
    }
  }

  const alter = /ALTER TABLE(?:\s+IF EXISTS)?\s+([a-z_.]+)([\s\S]*?);/gi;
  while ((match = alter.exec(sql)) !== null) {
    const body = match[2];
    const column = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi;
    let found;
    while ((found = column.exec(body)) !== null) add(match[1], found[1]);
  }

  return { tables, fully_known };
}

/** Source files in the email domain, recursively. */
function emailSources(dir = EMAIL_SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) emailSources(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Every `.from("table")…​.select("a, b, c")` pair in a file.
 *
 * Only literal selects are checked. A select built from a variable cannot be
 * read statically, and guessing at one would produce false alarms that train
 * people to ignore this test.
 */
function literalSelects(source) {
  const pairs = [];
  const pattern = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)([\s\S]{0,600}?)\.select\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    pairs.push({ table: match[1], columns: match[3] });
  }
  return pairs;
}

/** `a, b, c` -> ["a","b","c"]. Ignores embedded resource syntax and `*`. */
function splitColumns(list) {
  return list
    .split(",")
    .map((entry) => entry.trim().split(":").pop().trim())
    .filter((entry) => entry && entry !== "*" && !entry.includes("(") && /^[a-z_][a-z0-9_]*$/i.test(entry));
}

const { tables: SCHEMA, fully_known: FULLY_KNOWN } = columnsByTable(migrationSql());

test("the schema reader found the tables this guard depends on", () => {
  // If the reader silently found nothing, every check below would pass vacuously
  // -- which is exactly the failure shape this whole file is about.
  for (const table of [
    "email_reply_aliases", "email_inbound_events", "email_inbound_messages",
    "email_inbound_attachments", "contact_outreach_state", "seller_logical_communications",
  ]) {
    assert.ok(SCHEMA.has(table), `schema reader missed ${table}`);
    assert.ok(SCHEMA.get(table).size > 3, `schema reader found too few columns on ${table}`);
  }
});

test("the schema reader knows the columns the phantom-column defects named", () => {
  // Pinning both sides of the three real defects, so this guard is proven to be
  // capable of catching them rather than merely present.
  assert.ok(SCHEMA.get("contact_outreach_state").has("podio_master_owner_id"), "a real column was missed");
  assert.equal(
    SCHEMA.get("contact_outreach_state").has("podio_prospect_id"), false,
    "the phantom column would not have been caught"
  );
  // The other defect cannot be pinned the same way: email_queue's CREATE TABLE
  // is not in supabase/migrations, so this reader deliberately does not enforce
  // against it. What IS provable, and what actually made tier 2 inert, is that
  // nothing anywhere writes email_queue.rfc_message_id -- so even had the column
  // existed, it would have been null on every row.
  assert.equal(FULLY_KNOWN.has("email_queue"), false,
    "email_queue is now fully described; this guard should start enforcing on it");
});

test("nothing writes email_queue.rfc_message_id, which is what made tier 2 inert", () => {
  // A regression pin for the fix, not for the defect: if a future change starts
  // populating this column, the header lookup could legitimately use it again --
  // and someone should make that decision deliberately rather than discover it.
  const writers = emailSources()
    .filter((file) => !file.includes(`${path.sep}inbound${path.sep}`))
    .filter((file) => /rfc_message_id/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(writers, [], "something now references rfc_message_id outside the inbound path");
});

test("every literal select in the email domain names columns that exist", () => {
  const problems = [];

  for (const file of emailSources()) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(path.resolve(HERE, "../.."), file);

    for (const { table, columns } of literalSelects(source)) {
      // Only tables whose CREATE TABLE lives in supabase/migrations. email_queue,
      // for one, was created outside them, so this reader sees only the columns
      // later migrations ALTERed in -- enforcing on that partial set would report
      // `id` as a phantom column.
      if (!FULLY_KNOWN.has(table)) continue;
      const known = SCHEMA.get(table);
      if (!known) continue;

      for (const column of splitColumns(columns)) {
        if (!known.has(column)) problems.push(`${relative}: ${table}.${column}`);
      }
    }
  }

  assert.deepEqual(
    problems, [],
    "these columns are selected but do not exist in any migration.\n" +
    "PostgREST rejects the WHOLE select for one unknown column, so each of these\n" +
    "silently returns nothing forever rather than failing loudly:\n  " +
    problems.join("\n  ")
  );
});

test("every literal select in the inbound path in particular is clean", () => {
  // Named separately so a failure points straight at the code path where an
  // inert lookup means a seller's reply is not attributed.
  const inbound = emailSources(path.join(EMAIL_SRC, "inbound"));
  assert.ok(inbound.length >= 5, "the inbound directory was not read");

  for (const file of inbound) {
    for (const { table, columns } of literalSelects(fs.readFileSync(file, "utf8"))) {
      if (!FULLY_KNOWN.has(table)) continue;
      const known = SCHEMA.get(table);
      if (!known) continue;
      for (const column of splitColumns(columns)) {
        assert.ok(known.has(column), `${path.basename(file)} selects ${table}.${column}, which does not exist`);
      }
    }
  }
});
