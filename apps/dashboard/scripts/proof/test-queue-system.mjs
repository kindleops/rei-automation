import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8')
  envContent.split('\n').forEach(line => {
    const [key, ...value] = line.split('=')
    if (key && value && !key.startsWith('#')) {
      process.env[key.trim()] = value.join('=').trim().replace(/^"(.*)"$/, '$1')
    }
  })
}

const mockRes = {
  status: (code) => {
    console.log(`[Response Status]: ${code}`)
    return mockRes
  },
  json: (body) => {
    console.log(`[Response Body]:`, JSON.stringify(body, null, 2))
  }
}

async function test() {
  const { default: buildOutbound } = await import('../../api/internal/queue/build-outbound')
  const { default: buildReplies } = await import('../../api/internal/queue/build-replies')
  const { default: buildFollowups } = await import('../../api/internal/queue/build-followups')
  const { default: runQueue } = await import('../../api/internal/queue/run')
  const { default: reconcileQueue } = await import('../../api/internal/queue/reconcile')

  console.log('\n--- Testing Cleanup ---')
  const { cleanupBlankQueueRows } = await import('../../api/internal/queue/utils')
  const cleanedCount = await cleanupBlankQueueRows()
  console.log(`Cleaned up ${cleanedCount} blank queue rows.`)

  console.log('--- Testing Build Outbound ---')
  await buildOutbound({ method: 'POST' }, mockRes)

  console.log('\n--- Testing Build Replies ---')
  await buildReplies({ method: 'POST' }, mockRes)

  console.log('\n--- Testing Build Followups ---')
  await buildFollowups({ method: 'POST' }, mockRes)

  console.log('\n--- Testing Queue Run ---')
  await runQueue({ method: 'POST' }, mockRes)

  console.log('\n--- Testing Reconcile ---')
  await reconcileQueue({ method: 'POST' }, mockRes)

  console.log('\n--- Testing Blank Message Validation ---')
  const { renderMessage } = await import('../../api/internal/queue/utils')
  const blankResult = renderMessage({ templateText: '   ' }, {})
  console.log('Blank template result:', JSON.stringify(blankResult, null, 2))
  
  const missingVarResult = renderMessage({ templateText: 'Hi {{name}}' }, {})
  console.log('Missing variables result:', JSON.stringify(missingVarResult, null, 2))

  const validResult = renderMessage({ templateText: 'Hi there' }, {})
  console.log('Valid template result:', JSON.stringify(validResult, null, 2))
}

test().catch(console.error)
