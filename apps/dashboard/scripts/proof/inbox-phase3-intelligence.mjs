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
  console.log('── Phase 3 Intelligence Proof ──')

  assertContains('Phase 3 Data Fetcher', 'src/lib/data/inboxIntelligencePhase3.ts', [
    'fetchThreadPhase3Intelligence',
    'conversation_threads',
    'conversation_turns',
    'seller_state_snapshots'
  ])

  assertContains('Phase 3 Hook', 'src/modules/inbox/hooks/usePhase3Intelligence.ts', [
    'usePhase3Intelligence',
    'fetchThreadPhase3Intelligence',
    '.channel'
  ])

  assertContains('Intelligence Panel Integration', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    'usePhase3Intelligence',
    'MemoryActiveBadge',
    'SellerTemperatureIndicator',
    'NextBestActionChip'
  ])

  assertContains('Chat Thread Enrichment', 'src/modules/inbox/components/ChatThread.tsx', [
    'usePhase3Intelligence',
    'nx-turn-intel',
    'intent_detected',
    'confidence_score'
  ])

  assertContains('Premium Styles', 'src/modules/inbox/inbox-premium.css', [
    '.nx-memory-badge',
    '.nx-temp-indicator',
    '.nx-nba-chip',
    '.nx-turn-intel'
  ])

  console.log('✅ Phase 3 Intelligence Proof Complete')
}

runProof()
