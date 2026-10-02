/**
 * NDJSON.gz storage for IC8 dataset snapshots.
 *
 * Each page of records is appended as its own gzip member. A multi-member gzip
 * file is valid gzip (RFC 1952) and gunzips to the concatenated pages, which
 * makes resume safe: the builder truncates the file back to the byte length
 * recorded in its last checkpoint (discarding a partial page) and appends.
 * Same pages in, same bytes out, whether or not the build was interrupted.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const GZIP_OPTIONS = Object.freeze({ level: 9 });

export function encodeNdjson(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/** Append one gzip member; returns the number of bytes appended. */
export function appendGzipMember(filePath, text) {
  const member = zlib.gzipSync(Buffer.from(text, "utf8"), GZIP_OPTIONS);
  fs.appendFileSync(filePath, member);
  return member.length;
}

export function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Truncate (or create) a file to exactly `bytes` bytes. */
export function truncateFile(filePath, bytes) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.alloc(0));
  }
  fs.truncateSync(filePath, bytes);
}

export function readNdjsonGz(filePath) {
  const content = zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export function sha256OfBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** sha256 of the gz bytes and of the decompressed NDJSON content. */
export function hashGzipFile(filePath) {
  const gz = fs.readFileSync(filePath);
  const content = zlib.gunzipSync(gz);
  return { sha256: sha256OfBuffer(gz), contentSha256: sha256OfBuffer(content), bytes: gz.length, contentBytes: content.length };
}

/** Write JSON via a temp file + rename, so a crash never leaves a torn file. */
export function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, filePath);
}

export function removeFile(filePath) {
  fs.rmSync(filePath, { force: true });
}

export function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}
