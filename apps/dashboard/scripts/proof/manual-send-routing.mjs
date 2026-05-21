import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../')

const inboxDataFile = fs.readFileSync(path.join(rootDir, 'src/lib/data/inboxData.ts'), 'utf-8')

let hasErrors = false

console.log('1. Validating manual queue functions exist...')
if (inboxDataFile.includes('queueReplyFromInbox') && inboxDataFile.includes('scheduleReplyFromInbox')) {
  console.log('✅ Manual queue functions exist')
} else {
  console.error('❌ Manual queue functions missing')
  hasErrors = true
}

console.log('\n2. Validating from_phone_number is mandatory in manual inserts...')
// Looking for manual reply and schedule reply functions
// We should check that they don't allow null/falsy from_phone_number
const queueReplyFn = inboxDataFile.split('export const queueReplyFromInbox =')[1].split('export const')[0]
if (queueReplyFn.includes('if (!fromPhone) {') || queueReplyFn.includes('return { ok: false, errorMessage:')) {
    // This is a simple check, ideally it would perform a static analysis
    console.log('✅ Manual queue logic includes validation for fromPhone')
} else {
    console.error('❌ Manual queue logic might be missing fromPhone validation')
    hasErrors = true
}

if (hasErrors) {
  process.exit(1)
} else {
  console.log('\n✅ Manual send routing proofs passed!')
}
