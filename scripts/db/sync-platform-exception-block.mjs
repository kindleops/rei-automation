#!/usr/bin/env node
// The Supabase pg_net platform exception is ONE block of plpgsql (docs/SUPABASE-PG-NET-POSTURE.md). Its source
// of truth is action_gateway.platform_egress_exceptions in PROPOSED_20261019160000_action_gateway.sql (#26); the
// read-only credential's self-check (PROPOSED_20261019150000_lc_mcp_reader.sql, #25: it creates no helper schema)
// carries the SAME block inline. This script copies it (--write) or verifies it is identical (default; exit 1).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SOURCE = path.join(ROOT, 'supabase/migrations/PROPOSED_20261019160000_action_gateway.sql')
export const TARGET = path.join(ROOT, 'supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql')
const BEGIN = '  -- lc-platform-exception:block-begin'
const END = '  -- lc-platform-exception:block-end'

/** The block between the markers, minus the marker line's own trailing comment (which names the other file). */
export function platformExceptionBlock(src) {
  const a = src.indexOf(BEGIN)
  const b = src.indexOf(END)
  if (a < 0 || b < 0 || b < a) throw new Error('platform exception markers not found')
  const firstNl = src.indexOf('\n', a)
  return src.slice(firstNl + 1, b)
}

function splice(src, block) {
  const a = src.indexOf(BEGIN)
  const b = src.indexOf(END)
  const firstNl = src.indexOf('\n', a)
  return src.slice(0, firstNl + 1) + block + src.slice(b)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = platformExceptionBlock(fs.readFileSync(SOURCE, 'utf8'))
  const target = fs.readFileSync(TARGET, 'utf8')
  if (platformExceptionBlock(target) === source) { console.log('platform exception block: identical'); process.exit(0) }
  if (process.argv.includes('--write')) { fs.writeFileSync(TARGET, splice(target, source)); console.log('platform exception block: copied into', path.relative(ROOT, TARGET)); process.exit(0) }
  console.error('platform exception block: DIFFERS (run with --write)')
  process.exit(1)
}
