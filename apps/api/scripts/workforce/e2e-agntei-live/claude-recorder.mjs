#!/usr/bin/env node
// LIVE milestone: a TRANSPARENT recorder in front of the REAL Claude Code CLI (not a stand-in). Agntei starts it exactly
// where it starts `claude` (AGENT_COMMAND_CLAUDE_BIN → a sh wrapper → this file); it runs the real binary with the SAME
// arguments, the SAME environment and the SAME stdin, passes stdout / stderr / the exit status through unchanged, and only
// RECORDS: every stdout line of a turn (Claude Code's stream-json) to <state>/stream-<child pid>.jsonl, and a turn record
// (argv with the per-turn capability URL masked, the environment's variable NAMES, the prompt, whether anything
// credential-shaped reached the process) to <state>/turn-<child pid>.json. The harness kills <child pid> to test a crash.
//   usage: claude-recorder.mjs --state <dir> --real <path to claude> -- <claude args…>
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const all = process.argv.slice(2)
const sep = all.indexOf('--')
const own = all.slice(0, sep)
const args = all.slice(sep + 1)
const opt = (n) => { const i = own.indexOf(n); return i >= 0 ? own[i + 1] : null }
const STATE = opt('--state')
const REAL = opt('--real')
fs.mkdirSync(STATE, { recursive: true })
const turn = args.includes('-p')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const mask = (s) => String(s).replace(/(\/chat-mcp\/)[A-Za-z0-9_-]{43}/g, '$1<capability>')

const child = spawn(REAL, args, { stdio: [turn ? 'pipe' : 'inherit', 'pipe', 'inherit'], env: process.env })
const rec = { wrapper_pid: process.pid, child_pid: child.pid, turn, started_at: new Date().toISOString(), argv: args.map((a, i) => (args[i - 1] === '--system-prompt' ? `<system prompt: ${a.length} chars>` : mask(a))),
  session_id: flag('--session-id'), resume: flag('--resume'), model_flag: flag('--model'), env_names: Object.keys(process.env).sort() }
const recFile = path.join(STATE, `${turn ? 'turn' : 'call'}-${child.pid}.json`)
const save = () => fs.writeFileSync(recFile, JSON.stringify(rec, null, 1))
save()
const stream = turn ? fs.openSync(path.join(STATE, `stream-${child.pid}.jsonl`), 'a') : null
let buf = ''
child.stdout.on('data', (d) => {
  process.stdout.write(d)
  if (!stream) return
  buf += d
  let k
  while ((k = buf.indexOf('\n')) >= 0) { fs.writeSync(stream, `${buf.slice(0, k)}\n`); buf = buf.slice(k + 1) }
})
if (turn) {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { prompt += c; child.stdin.write(c) })
  process.stdin.on('end', () => {
    child.stdin.end()
    const looked = JSON.stringify({ env: process.env, argv: args, prompt })
    rec.prompt = prompt
    rec.credential_check = { lcag_token: /lcag_[A-Za-z0-9_-]{8,}/.test(looked), authorization_header_in_mcp_config: /"authorization"\s*:/i.test(flag('--mcp-config') || ''), bearer_word: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/.test(looked) }
    save()
  })
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig) } catch { /* gone */ } })
child.on('exit', (code, signal) => {
  if (stream) { if (buf) fs.writeSync(stream, `${buf}\n`); fs.closeSync(stream) }
  rec.exited_at = new Date().toISOString()
  rec.exit = { code, signal }
  save()
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) } else process.exit(code ?? 1)
})
