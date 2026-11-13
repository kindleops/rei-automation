#!/usr/bin/env node
// Create the bearer token file for the loopback Streamable HTTP transport.
//   node scripts/http-token.mjs <path>
// 32 random bytes, base64url, written with O_EXCL at mode 0600 (an existing file is never
// overwritten). The token is NOT printed: the operator reads the file when pasting it into the
// client (e.g. Agntau's Connections → Add by URL → token).
import crypto from 'node:crypto'
import fs from 'node:fs'

const p = process.argv[2]
if (!p) { process.stderr.write('usage: node scripts/http-token.mjs <path>\n'); process.exit(2) }
const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
try { fs.writeSync(fd, `${crypto.randomBytes(32).toString('base64url')}\n`) } finally { fs.closeSync(fd) }
fs.chmodSync(p, 0o600)
process.stdout.write(`${JSON.stringify({ created: p, mode: '0600', bytes: 32 })}\n`)
