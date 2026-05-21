import fs from 'node:fs'
import path from 'node:path'

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8')

const assertContains = (name, file, needles) => {
  const source = read(file)
  const missing = needles.filter((needle) => !source.includes(needle))
  if (missing.length > 0) throw new Error(`${name} missing ${missing.join(', ')} in ${file}`)
  console.log(`✅ ${name}`)
}

const runProof = () => {
  console.log('── Timeline Intelligence Events Proof ──')

  assertContains('Timeline Panel consumes Phase 3', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    'TimelinePanel = ({ thread, messages, phase3 }',
    'phase3.routingDecisions.forEach',
    'phase3.aiDecisions.forEach',
    'phase3.negotiationEvents.forEach'
  ])

  assertContains('Intelligence Labels', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    'AI Routing:',
    'AI Decision:',
    'NEGOTIATION'
  ])

  console.log('✅ Timeline Intelligence Events Proof Complete')
}

runProof()
