// One audit record per tool call (allowed, refused or failed). PII-free by
// construction: identifiers are short salted hashes, inputs are a hash, the
// record holds classes / counts / timings only, and the whole line passes the
// secret + phone + email redactor before it is written.
//
// Sinks: stderr (JSON lines — stdout belongs to the MCP stdio protocol), an
// optional append-only file (LEADCOMMAND_MCP_AUDIT_FILE), or an injected
// function (tests). A sink failure never fails the call; it is counted.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { canonicalJson } from '@/lib/agent/research/pii.js'
import { redactDeep } from '../safety/redact.mjs'

export const AUDIT_FIELDS = Object.freeze(['ts', 'event', 'correlation_id', 'principal', 'org', 'tool', 'scope', 'outcome', 'error_class', 'error_code', 'latency_ms', 'rows', 'bytes', 'truncated', 'input_hash', 'transport', 'data_mode', 'upstream_timeout_pref'])

export function createAuditor({ salt = crypto.randomBytes(16).toString('hex'), sink = null, file = null, stderr = process.stderr, now = () => new Date() } = {}) {
  const h = (v) => (v == null ? null : `#${crypto.createHash('sha256').update(`${salt}:${v}`).digest('hex').slice(0, 12)}`)
  let failures = 0
  const records = []
  function write(rec) {
    const line = JSON.stringify(redactDeep(rec))
    try {
      if (sink) sink(JSON.parse(line))
      else if (file) fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
      else stderr.write(`${line}\n`)
    } catch {
      failures += 1
    }
  }
  return {
    hashId: h,
    inputHash: (input) => crypto.createHash('sha256').update(canonicalJson(input ?? {})).digest('hex').slice(0, 16),
    record(fields) {
      const rec = { ts: now().toISOString(), event: 'tool_call' }
      for (const k of AUDIT_FIELDS) if (k in fields) rec[k] = fields[k]
      rec.principal = h(fields.principal)
      rec.org = h(fields.org)
      records.push(rec)
      if (records.length > 500) records.shift()
      write(rec)
      return rec
    },
    event(name, fields = {}) {
      write({ ts: now().toISOString(), event: name, ...fields })
    },
    get failures() { return failures },
    recent: () => [...records],
  }
}
