import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(process.cwd())
const resolverPath = path.join(ROOT, 'src/modules/inbox/resolveInboxThreadState.ts')
const tmpPath = path.join(ROOT, '.tmp-inbox-bucket-resolver-proof.mjs')

const source = fs.readFileSync(resolverPath, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: resolverPath,
}).outputText

fs.writeFileSync(tmpPath, transpiled, 'utf8')

const mod = await import(pathToFileURL(tmpPath).href)
const { resolveInboxThreadState } = mod

const now = new Date('2026-05-24T12:00:00.000Z')

const cases = [
  {
    name: 'Yes ownership confirmed',
    thread: {
      id: 't1',
      threadKey: 't1',
      latest_message_direction: 'inbound',
      is_read: false,
      detected_intent: 'ownership_confirmed',
      confidence: 0.9,
      lastMessageAt: '2026-05-24T11:59:00.000Z',
    },
    expectOneOf: ['new_replies', 'needs_review', 'priority'],
  },
  {
    name: 'Stop suppressed',
    thread: {
      id: 't2',
      threadKey: 't2',
      latest_message_direction: 'inbound',
      is_read: false,
      detected_intent: 'stop',
      lastMessageAt: '2026-05-24T11:58:00.000Z',
    },
    expect: 'suppressed',
  },
  {
    name: 'NO follow up not priority',
    thread: {
      id: 't3',
      threadKey: 't3',
      latest_message_direction: 'inbound',
      is_read: false,
      detected_intent: 'not_interested',
      lastMessageBody: 'No thanks',
      lastMessageAt: '2026-05-24T11:57:00.000Z',
    },
    expect: 'follow_up',
    not: ['priority'],
  },
  {
    name: 'Wrong number suppressed or cold never priority',
    thread: {
      id: 't4',
      threadKey: 't4',
      latest_message_direction: 'inbound',
      is_read: false,
      detected_intent: 'wrong_number',
      is_suppressed: true,
      lastMessageAt: '2026-05-24T11:56:00.000Z',
    },
    expectOneOf: ['suppressed', 'cold'],
    not: ['priority'],
  },
  {
    name: 'Interested price reply priority',
    thread: {
      id: 't5',
      threadKey: 't5',
      latest_message_direction: 'inbound',
      is_read: false,
      detected_intent: 'seller_asking_price',
      is_hot_lead: true,
      priority_score: 90,
      lastMessageAt: '2026-05-24T11:55:00.000Z',
    },
    expect: 'priority',
  },
  {
    name: 'Unclear reply needs review',
    thread: {
      id: 't6',
      threadKey: 't6',
      latest_message_direction: 'inbound',
      is_read: false,
      detected_intent: 'unclear',
      confidence: 0.4,
      lastMessageAt: '2026-05-24T11:54:00.000Z',
    },
    expect: 'needs_review',
  },
  {
    name: 'Old outbound-only cold',
    thread: {
      id: 't7',
      threadKey: 't7',
      latest_message_direction: 'outbound',
      is_read: true,
      detected_intent: '',
      lastMessageAt: '2026-05-01T00:00:00.000Z',
    },
    expect: 'cold',
  },
]

let failed = 0
for (const test of cases) {
  const result = resolveInboxThreadState(test.thread, now)
  const okExpect = test.expect ? result.bucket === test.expect : true
  const okOneOf = test.expectOneOf ? test.expectOneOf.includes(result.bucket) : true
  const okNot = test.not ? !test.not.includes(result.bucket) : true
  const ok = okExpect && okOneOf && okNot
  if (!ok) {
    failed += 1
    console.error(`FAIL: ${test.name}`, { got: result.bucket, reasons: result.reasons })
  } else {
    console.log(`PASS: ${test.name} -> ${result.bucket}`)
  }
}

fs.unlinkSync(tmpPath)

if (failed > 0) {
  process.exit(1)
}

console.log('PASS: inbox bucket resolver proof complete')

