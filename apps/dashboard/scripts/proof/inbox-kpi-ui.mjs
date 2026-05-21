import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../')

const topBarFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/components/NexusTopBar.tsx'), 'utf-8')
const sidebarFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/components/InboxSidebar.tsx'), 'utf-8')
const polishCssFile = fs.readFileSync(path.join(rootDir, 'src/modules/inbox/inbox-polish.css'), 'utf-8')

let hasErrors = false

console.log('1. Validating top KPI strip is not mounted...')
if (!topBarFile.includes('InboxKpiHoverStrip') && !topBarFile.includes('buildInboxKpis')) {
  console.log('✅ Top KPI strip removed from NexusTopBar')
} else {
  console.error('❌ Top KPI strip or related functions still exist in NexusTopBar')
  hasErrors = true
}

console.log('\n2. Validating sidebar bucket hover KPI exists...')
if (sidebarFile.includes('nx-queue-kpi-popover') && sidebarFile.includes('onMouseEnter={() => setHoveredQueue')) {
  console.log('✅ Sidebar bucket hover KPI logic found')
} else {
  console.error('❌ Sidebar bucket hover KPI logic is missing')
  hasErrors = true
}

console.log('\n3. Validating search/composer width alignment...')
if (topBarFile.includes('inbox-center-width') && polishCssFile.includes('.inbox-center-width')) {
  console.log('✅ Width alignment token inbox-center-width still exists')
} else {
  console.error('❌ Width alignment token missing')
  hasErrors = true
}

console.log('\n4. Validating old placeholder labels are removed from header...')
if (!topBarFile.includes('nx-topbar-workflow-chips')) {
  console.log('✅ Old workflow chips removed')
} else {
  console.error('❌ Old workflow chips still exist')
  hasErrors = true
}

console.log('\n5. Validating sidebar KPI CSS exists...')
if (polishCssFile.includes('.nx-queue-kpi-popover')) {
  console.log('✅ Sidebar KPI CSS found in inbox-polish.css')
} else {
  console.error('❌ Sidebar KPI CSS not found')
  hasErrors = true
}

if (hasErrors) {
  process.exit(1)
} else {
  console.log('\n✅ All KPI UI proofs passed!')
}
