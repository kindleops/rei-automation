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
  console.log('── No Dossier Regression Proof ──')

  assertContains('Property Hero Card intact', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    '<PropertyHeroCard',
    'snapshot',
    'panelMode'
  ])

  assertContains('Offer Memo Card intact', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    '<OfferMemoCard',
    'thread={thread}'
  ])

  assertContains('Contact Intelligence Card intact', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    '<ContactIntelligenceCard',
    'snapshot={snapshot}',
    'intelligence={intelligence}'
  ])

  assertContains('Timeline Panel intact', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    '<TimelinePanel',
    'messages={messages}'
  ])

  assertContains('Linked Records Card intact', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    '<LinkedRecordsCard',
    'thread={thread}'
  ])

  console.log('✅ No Dossier Regression Proof Complete')
}

runProof()
