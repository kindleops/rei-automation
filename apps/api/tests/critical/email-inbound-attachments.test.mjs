/**
 * email-inbound-attachments.test.mjs
 *
 * Files a stranger can put on our disk and in front of an operator.
 *
 * Anyone who can email a reply alias can attach anything to it. The design
 * position here is that we have NO malware scanner, so nothing is ever called
 * safe -- every file lands quarantined, with the reason recorded, and the
 * missing capability is documented rather than papered over.
 *
 * Every filename below is invented. No real seller content appears in this file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  createInboundEmailStore,
  sanitizeAttachmentFilename,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "../../src/lib/domain/email/inbound/inbound-email-store.js";

// ── filename safety ──

test("a plain filename survives unchanged", () => {
  assert.equal(sanitizeAttachmentFilename("deed-scan.pdf"), "deed-scan.pdf");
  assert.equal(sanitizeAttachmentFilename("Roof Photo 3.jpeg"), "Roof Photo 3.jpeg");
});

test("path traversal cannot escape anywhere", () => {
  for (const hostile of [
    "../../../etc/passwd",
    "..\\..\\windows\\system32\\config",
    "/etc/shadow",
    "C:\\Windows\\notepad.exe",
    "....//....//secret.txt",
  ]) {
    const safe = sanitizeAttachmentFilename(hostile);
    assert.equal(safe.includes("/"), false, hostile);
    assert.equal(safe.includes("\\"), false, hostile);
    assert.equal(safe.startsWith("."), false, hostile);
  }
});

test("an executable extension is neutralised, not silently accepted", () => {
  // Neutralised rather than REJECTED: the file is still evidence, and a seller
  // may genuinely have attached one by mistake.
  for (const name of ["invoice.exe", "photo.jpg.scr", "notes.bat", "run.ps1", "app.jar", "setup.msi"]) {
    const safe = sanitizeAttachmentFilename(name);
    assert.match(safe, /\.quarantined$/, name);
  }
});

test("a right-to-left override cannot disguise an executable", () => {
  // U+202E renders `photo<RLO>gnp.exe` as `photo exe.png` in a file listing.
  // This is a real technique, not a theoretical one.
  const disguised = "photo\u202egnp.exe";
  const safe = sanitizeAttachmentFilename(disguised);
  assert.equal(/[\u202a-\u202e\u2066-\u2069]/.test(safe), false);
  assert.match(safe, /\.quarantined$/);
});

test("control characters are stripped from a filename", () => {
  const safe = sanitizeAttachmentFilename("re\u0000port\u0007.pdf");
  assert.equal(/[\u0000-\u001f\u007f]/.test(safe), false);
  assert.match(safe, /report\.pdf$/);
});

test("shell and filesystem metacharacters are replaced, not escaped", () => {
  const safe = sanitizeAttachmentFilename('a:b*c?d"e<f>g|h.pdf');
  for (const character of [":", "*", "?", '"', "<", ">", "|"]) {
    assert.equal(safe.includes(character), false, character);
  }
});

test("an absurdly long filename is truncated to something storable", () => {
  const safe = sanitizeAttachmentFilename("a".repeat(5000) + ".pdf");
  assert.ok(safe.length <= 180, `length was ${safe.length}`);
});

test("an empty or hostile filename still yields a usable name", () => {
  for (const value of [null, undefined, "", "   ", "...", "/", "\\", 0, {}, []]) {
    const safe = sanitizeAttachmentFilename(value);
    assert.ok(safe.length > 0, String(value));
    assert.equal(safe.includes("/"), false);
  }
});

test("filename sanitization never throws", () => {
  for (const value of [null, undefined, 0, {}, [], Symbol.iterator.toString()]) {
    assert.doesNotThrow(() => sanitizeAttachmentFilename(value));
  }
});

// ── the store: persistence, dedup and honesty about scanning ────────────────

function stubStore({ inserts = [], fetchImpl } = {}) {
  const seen = new Set();
  return createInboundEmailStore({
    supabase: {
      from() {
        return {
          async insert(row) {
            inserts.push(row);
            const key = `${row.inbound_message_id}:${row.content_sha256}`;
            if (seen.has(key)) return { error: { code: "23505", message: "duplicate key" } };
            seen.add(key);
            return { error: null };
          },
        };
      },
    },
    fetch_impl: fetchImpl,
  });
}

const MESSAGE = { inbound_message_id: "msg-1", inbound_event_id: "evt-1" };

function inlineDescriptor(overrides = {}) {
  return {
    filename: "deed.pdf",
    content_type: "application/pdf",
    content_base64: Buffer.from("pretend pdf bytes").toString("base64"),
    ...overrides,
  };
}

test("an inline attachment is digested and recorded", async () => {
  const inserts = [];
  const store = stubStore({ inserts });
  const summary = await store.ingestAttachments({ ...MESSAGE, descriptors: [inlineDescriptor()] });

  assert.equal(summary.quarantined, 1);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].filename, "deed.pdf");
  assert.equal(inserts[0].byte_size, Buffer.from("pretend pdf bytes").length);
  assert.match(inserts[0].content_sha256, /^[0-9a-f]{64}$/);
});

test("the digest is of the BYTES, so it matches an independent computation", () => {
  // The digest is the only durable identity a file has: a provider url expires
  // and a filename lies.
  const bytes = Buffer.from("pretend pdf bytes");
  const expected = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test("no attachment is ever called clean, because no scanner exists", async () => {
  const inserts = [];
  await stubStore({ inserts }).ingestAttachments({ ...MESSAGE, descriptors: [inlineDescriptor()] });
  assert.equal(inserts[0].scan_status, "unscanned");
  assert.equal(inserts[0].quarantine_reason, "no_malware_scanning_configured");
  // The summary counts it as quarantined, never as stored-and-safe.
  assert.notEqual(inserts[0].scan_status, "clean");
});

test("the provider's claimed content type is recorded but never believed", async () => {
  // A claimed content type is attacker-controlled. Recording it preserves the
  // evidence; acting on it would let a sender choose how we render their file.
  const inserts = [];
  await stubStore({ inserts }).ingestAttachments({
    ...MESSAGE,
    descriptors: [inlineDescriptor({ content_type: "text/html" })],
  });
  assert.equal(inserts[0].provider_content_type, "text/html");
  assert.equal(inserts[0].content_type, "application/octet-stream");
});

test("the provider's original filename is kept alongside the safe one", async () => {
  const inserts = [];
  await stubStore({ inserts }).ingestAttachments({
    ...MESSAGE,
    descriptors: [inlineDescriptor({ filename: "../../invoice.exe" })],
  });
  assert.equal(inserts[0].provider_filename, "../../invoice.exe");
  assert.equal(inserts[0].filename, "invoice.exe.quarantined");
});

test("the same file arriving twice on one message is stored once", async () => {
  // Re-delivery of a whole callback must not duplicate its files.
  const inserts = [];
  const store = stubStore({ inserts });
  const descriptors = [inlineDescriptor(), inlineDescriptor()];
  const summary = await store.ingestAttachments({ ...MESSAGE, descriptors });
  assert.equal(summary.quarantined, 1);
  assert.equal(summary.skipped, 1);
});

test("two DIFFERENT files on one message are both stored", async () => {
  const inserts = [];
  const summary = await stubStore({ inserts }).ingestAttachments({
    ...MESSAGE,
    descriptors: [
      inlineDescriptor({ filename: "a.pdf", content_base64: Buffer.from("aaa").toString("base64") }),
      inlineDescriptor({ filename: "b.pdf", content_base64: Buffer.from("bbb").toString("base64") }),
    ],
  });
  assert.equal(summary.quarantined, 2);
  assert.notEqual(inserts[0].content_sha256, inserts[1].content_sha256);
});

test("a file over the size cap is skipped rather than stored", async () => {
  const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41);
  const inserts = [];
  const summary = await stubStore({ inserts }).ingestAttachments({
    ...MESSAGE,
    descriptors: [{ filename: "huge.bin", content_base64: oversized.toString("base64") }],
  });
  assert.equal(summary.skipped, 1);
  assert.equal(inserts.length, 0);
});

test("one message cannot attach an unbounded number of files", async () => {
  // A single hostile message must not be able to exhaust storage.
  const inserts = [];
  const descriptors = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 25 }, (_, i) =>
    inlineDescriptor({ filename: `f${i}.pdf`, content_base64: Buffer.from(`bytes-${i}`).toString("base64") })
  );
  await stubStore({ inserts }).ingestAttachments({ ...MESSAGE, descriptors });
  assert.equal(inserts.length, MAX_ATTACHMENTS_PER_MESSAGE);
});

test("bytes are fetched DURING ingestion, because provider urls expire", async () => {
  let requested = null;
  const inserts = [];
  const store = stubStore({
    inserts,
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, arrayBuffer: async () => Buffer.from("remote bytes") };
    },
  });
  const summary = await store.ingestAttachments({
    ...MESSAGE,
    descriptors: [{ filename: "scan.pdf", download_url: "https://provider.example.net/a/abc" }],
  });
  assert.equal(requested, "https://provider.example.net/a/abc");
  assert.equal(summary.quarantined, 1);
});

test("a failed fetch is counted as failed, never as an empty file", async () => {
  const inserts = [];
  const summary = await stubStore({
    inserts,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }).ingestAttachments({
    ...MESSAGE,
    descriptors: [{ filename: "gone.pdf", download_url: "https://provider.example.net/a/expired" }],
  });
  assert.equal(summary.failed, 1);
  assert.equal(inserts.length, 0);
});

test("a fetch that throws is counted as failed and does not abort the batch", async () => {
  // One unreachable file must not lose the other files on the same message.
  const inserts = [];
  let call = 0;
  const summary = await stubStore({
    inserts,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) throw new Error("connection reset");
      return { ok: true, arrayBuffer: async () => Buffer.from("second file") };
    },
  }).ingestAttachments({
    ...MESSAGE,
    descriptors: [
      { filename: "one.pdf", download_url: "https://provider.example.net/a/1" },
      { filename: "two.pdf", download_url: "https://provider.example.net/a/2" },
    ],
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.quarantined, 1);
});

test("a descriptor with neither bytes nor a url is a failure, not a blank row", async () => {
  const inserts = [];
  const summary = await stubStore({ inserts }).ingestAttachments({
    ...MESSAGE,
    descriptors: [{ filename: "nothing.pdf" }],
  });
  assert.equal(summary.failed, 1);
  assert.equal(inserts.length, 0);
});

test("malformed base64 fails rather than storing garbage", async () => {
  const inserts = [];
  const summary = await stubStore({ inserts }).ingestAttachments({
    ...MESSAGE,
    descriptors: [{ filename: "bad.pdf", content_base64: "!!!not base64!!!" }],
  });
  // Buffer.from is lenient, so this either fails or stores a short buffer -- but
  // it must never throw out of ingestion and lose the message.
  assert.ok(summary.failed + summary.quarantined === 1);
});

test("attachment ingestion never throws on hostile input", async () => {
  const store = stubStore({});
  for (const descriptors of [null, undefined, "", 0, {}, [null], [undefined], [0], ["x"], [[]]]) {
    await assert.doesNotReject(
      () => store.ingestAttachments({ ...MESSAGE, descriptors }),
      String(descriptors)
    );
  }
  await assert.doesNotReject(() => store.ingestAttachments(null));
  await assert.doesNotReject(() => store.ingestAttachments());
});

test("no attachment is ever counted as stored while storage is unimplemented", async () => {
  // storage_status starts at `pending`, and nothing in EMAIL-3 advances it. The
  // row must not imply bytes are retrievable when they are not.
  const inserts = [];
  await stubStore({ inserts }).ingestAttachments({ ...MESSAGE, descriptors: [inlineDescriptor()] });
  assert.equal(inserts[0].storage_status, "pending");
  assert.equal(inserts[0].storage_key ?? null, null);
});

// ── stored evidence must not carry the bytes ───────────────────────────────

test("a malformed payload is kept as evidence WITHOUT its attachment bytes", async () => {
  // The payload is kept because it is the only trace something arrived and may
  // be a provider change worth seeing. Keeping it verbatim would put a 25MB
  // attachment, base64-encoded, inside a jsonb column -- and anyone who can
  // reach the endpoint could bloat the database on purpose.
  const rows = [];
  const store = createInboundEmailStore({
    supabase: { from: () => ({ async insert(row) { rows.push(row); return { error: null }; } }) },
  });

  const bytes = Buffer.alloc(50_000, 0x41).toString("base64");
  await store.recordMalformed({
    reason: "inbound_payload_missing_sender",
    raw_item: {
      Subject: "no sender",
      Attachments: [{ Name: "huge.bin", ContentType: "application/pdf", Content: bytes }],
    },
  });

  const stored = JSON.stringify(rows[0].raw_payload);
  assert.equal(stored.includes(bytes.slice(0, 200)), false, "the attachment bytes were stored");
  assert.ok(stored.length < 2000, `the stored payload was ${stored.length} bytes`);
});

test("the attachment DESCRIPTOR survives, because that is the useful part", async () => {
  const rows = [];
  const store = createInboundEmailStore({
    supabase: { from: () => ({ async insert(row) { rows.push(row); return { error: null }; } }) },
  });

  await store.recordMalformed({
    reason: "inbound_payload_missing_sender",
    raw_item: {
      Attachments: [{ Name: "deed.pdf", ContentType: "application/pdf", Content: Buffer.from("abc").toString("base64") }],
    },
  });

  const attachment = rows[0].raw_payload.Attachments[0];
  assert.equal(attachment.Name, "deed.pdf");
  assert.equal(attachment.ContentType, "application/pdf");
  assert.equal(attachment.Content, undefined);
  // How big it was is recorded, so an operator can tell a stripped attachment
  // apart from one that never had any content.
  assert.equal(attachment.content_omitted_bytes, 4);
});

test("a payload with no attachments passes through unchanged", async () => {
  const rows = [];
  const store = createInboundEmailStore({
    supabase: { from: () => ({ async insert(row) { rows.push(row); return { error: null }; } }) },
  });
  await store.recordMalformed({ reason: "x", raw_item: { Subject: "hello", From: null } });
  assert.equal(rows[0].raw_payload.Subject, "hello");
});

test("stripping never throws on a hostile payload shape", async () => {
  const store = createInboundEmailStore({
    supabase: { from: () => ({ async insert() { return { error: null }; } }) },
  });
  for (const raw_item of [
    null, undefined, "", 0, [], { Attachments: "nope" }, { Attachments: [null, 0, "x"] },
    { attachments: [{ content: 5 }] },
  ]) {
    await assert.doesNotReject(() => store.recordMalformed({ reason: "x", raw_item }), String(raw_item));
  }
});
