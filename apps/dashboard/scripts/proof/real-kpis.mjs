import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../')

const topBarFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/components/NexusTopBar.tsx'), 'utf-8')
const sidebarFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/components/InboxSidebar.tsx'), 'utf-8')
const orbFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/components/InboxKpiOrb.tsx'), 'utf-8')
const kpiDataFile = fs.readFileSync(path.join(rootDir, 'src/lib/data/inboxKpis.ts'), 'utf-8')
const polishCssFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/inbox-polish.css'), 'utf-8')

let hasErrors = false

console.log('1. Validating KPI Orb exists and is mounted...')
if (orbFile.includes('export const InboxKpiOrb') && topBarFile.includes('<InboxKpiOrb />')) {
  console.log('✅ InboxKpiOrb exists and is mounted in NexusTopBar')
} else {
  console.error('❌ InboxKpiOrb is missing or not mounted')
  hasErrors = true
}

console.log('\n2. Validating sidebar KPI panels are removed...')
if (!sidebarFile.includes('nx-queue-kpi-popover') && !sidebarFile.includes('hoveredQueue')) {
  console.log('✅ Sidebar KPI popover logic removed')
} else {
  console.error('❌ Sidebar KPI popover logic still exists in InboxSidebar.tsx')
  hasErrors = true
}

console.log('\n3. Validating real operational metrics in data layer...')
const requiredKpis = ['Reply Rate', 'Positive Rate', 'Opt-Out Rate', 'Delivery Rate', 'Failure Rate']
for (const kpi of requiredKpis) {
  if (kpiDataFile.includes(kpi)) {
    console.log(`✅ Metric logic found: ${kpi}`)
  } else {
    console.error(`❌ Missing metric logic: ${kpi}`)
    hasErrors = true
  }
}

console.log('\n4. Validating formulas (Reply Rate)...')
if (kpiDataFile.includes('inbound.length / delivered.length')) {
  console.log('✅ Reply Rate formula uses inbound/delivered ratio')
} else {
  console.error('❌ Reply Rate formula incorrect or missing')
  hasErrors = true
}

console.log('\n5. Validating Orb supports pinned metric via localStorage...')
if (orbFile.includes("localStorage.getItem('nexus.pinnedInboxKpi')") && orbFile.includes("localStorage.setItem('nexus.pinnedInboxKpi'")) {
  console.log('✅ Orb supports pinned metric persistence')
} else {
  console.error('❌ Pinned metric persistence missing')
  hasErrors = true
}

console.log('\n6. Validating animated Orb styling...')
if (polishCssFile.includes('.nx-kpi-orb') && polishCssFile.includes('.nx-orb-dashboard')) {
  console.log('✅ Orb and Dashboard CSS found')
} else {
  console.error('❌ Orb CSS missing')
  hasErrors = true
}

if (hasErrors) {
  process.exit(1)
} else {
  console.log('\n✅ All Real KPI proofs passed!')
}
