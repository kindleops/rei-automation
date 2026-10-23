#!/usr/bin/env node
// Two blocks of plpgsql are shared, byte-identical, between the two role migrations (docs/SUPABASE-PG-NET-POSTURE.md):
//   1. the Supabase pg_net platform exception (action_gateway.platform_egress_exceptions in
//      PROPOSED_20261019160000_action_gateway.sql, #26; inlined into lc_mcp_reader_self_check in
//      PROPOSED_20261019150000_lc_mcp_reader.sql, #25, which creates no helper schema);
//   2. the bounded transitive-reachability helper public.lc_reachable_egress_indirect(oid), created by BOTH
//      migrations (create-or-replace), so an independent apply of either still carries the identical rule.
// #26 is the source of truth for both; #25 carries the SAME text. This script copies it (--write) or verifies it is
// identical (default; exit 1).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SOURCE = path.join(ROOT, 'supabase/migrations/PROPOSED_20261019160000_action_gateway.sql')
export const TARGET = path.join(ROOT, 'supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql')

export const BLOCKS = [
  { name: 'platform exception block', begin: '  -- lc-platform-exception:block-begin', end: '  -- lc-platform-exception:block-end' },
  { name: 'indirect-egress block', begin: '-- lc-indirect-egress:block-begin', end: '-- lc-indirect-egress:block-end' },
]

/** The text between a block's markers (from the line after BEGIN up to END), ignoring the begin line's trailing comment. */
export function namedBlock(src, begin, end) {
  const a = src.indexOf(begin)
  const b = src.indexOf(end)
  if (a < 0 || b < 0 || b < a) throw new Error(`block markers not found: ${begin}`)
  const firstNl = src.indexOf('\n', a)
  return src.slice(firstNl + 1, b)
}

/** Back-compat: the pg_net platform exception block. */
export function platformExceptionBlock(src) {
  return namedBlock(src, BLOCKS[0].begin, BLOCKS[0].end)
}

function splice(src, begin, end, block) {
  const a = src.indexOf(begin)
  const b = src.indexOf(end)
  const firstNl = src.indexOf('\n', a)
  return src.slice(0, firstNl + 1) + block + src.slice(b)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write')
  const source = fs.readFileSync(SOURCE, 'utf8')
  let target = fs.readFileSync(TARGET, 'utf8')
  let diffs = 0
  for (const { name, begin, end } of BLOCKS) {
    const want = namedBlock(source, begin, end)
    if (namedBlock(target, begin, end) === want) { console.log(`${name}: identical`); continue }
    if (write) { target = splice(target, begin, end, want); console.log(`${name}: copied into ${path.relative(ROOT, TARGET)}`); continue }
    console.error(`${name}: DIFFERS (run with --write)`)
    diffs += 1
  }
  if (write) fs.writeFileSync(TARGET, target)
  process.exit(diffs > 0 ? 1 : 0)
}
