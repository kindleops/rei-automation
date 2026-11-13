#!/usr/bin/env node
// Offline replay of conversation turns through the CANONICAL runtime (rc-8.5.21):
//   node --import ./tests/register-aliases.mjs scripts/conversation-ai/eval-replay.mjs <turns.json>
// <turns.json> = [{ input, deterministic?, eligibility?, establishedPersona?, now? }, …] (context rows,
// already masked / synthetic). No model is called (deterministic decisions only) unless the caller
// builds its own harness around replayTurnForEvaluation with an injected model client. Reads one
// local file, writes JSON to stdout, touches no database and no provider.
import fs from 'node:fs'
import { replayTurnForEvaluation } from '../../src/lib/domain/conversation-ai/runtime/evaluation-entry.js'

const file = process.argv[2]
if (!file) { console.error('usage: eval-replay.mjs <turns.json>'); process.exit(2) }
const turns = JSON.parse(fs.readFileSync(file, 'utf8'))
const out = []
for (const t of Array.isArray(turns) ? turns : []) {
  const r = await replayTurnForEvaluation({ input: t.input, deterministic: t.deterministic || null, eligibility: t.eligibility || null, establishedPersona: t.establishedPersona || null, now: t.now || t.input?.now })
  out.push({ inbound_message_id: r.inbound_message_id, versions: r.versions, terminal: r.terminal, plan_reasons: r.plan?.reasons || [], reply: r.reply })
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
