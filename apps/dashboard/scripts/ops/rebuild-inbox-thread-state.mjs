import 'dotenv/config'

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

async function run() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const dryRun = !apply
  const onlyInconsistent = !args.includes('--all')
  const includeSuppressed = args.includes('--include-suppressed')
  
  let limit = 100
  const limitArg = args.find(a => a.startsWith('--limit='))
  if (limitArg) limit = parseInt(limitArg.split('=')[1], 10)

  let batchSize = limit
  const batchSizeArg = args.find(a => a.startsWith('--batch-size='))
  if (batchSizeArg) batchSize = parseInt(batchSizeArg.split('=')[1], 10)

  let maxBatches = 1
  const maxBatchesArg = args.find(a => a.startsWith('--max-batches='))
  if (maxBatchesArg) maxBatches = parseInt(maxBatchesArg.split('=')[1], 10)

  let sleepMs = 1000
  const sleepMsArg = args.find(a => a.startsWith('--sleep-ms='))
  if (sleepMsArg) sleepMs = parseInt(sleepMsArg.split('=')[1], 10)

  let threadKey = null
  const tkArg = args.find(a => a.startsWith('--thread='))
  if (tkArg) threadKey = tkArg.split('=')[1]

  let cliBaseUrl = null
  const baseUrlArg = args.find(a => a.startsWith('--base-url='))
  if (baseUrlArg) cliBaseUrl = baseUrlArg.split('=')[1]

  const BASE_URL = cliBaseUrl || process.env.REBUILD_BASE_URL || process.env.LOCAL_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:3000'
  const endpointUrl = `${BASE_URL}/api/internal/inbox/rebuild-thread-state`

  console.log(`🚀 Triggering Inbox Thread State Rebuild...`)
  console.log(`Target URL: ${endpointUrl}`)
  
  let currentBatch = 0
  let offset = 0
  let totalUpdated = 0
  let totalInspected = 0

  while (currentBatch < maxBatches) {
    const payload = {
      apply,
      dry_run: dryRun,
      only_inconsistent: onlyInconsistent,
      include_suppressed: includeSuppressed,
      limit: batchSize,
      offset,
      thread_key: threadKey
    }

    console.log(`\n📦 Batch ${currentBatch + 1}/${maxBatches} (offset: ${offset}, limit: ${batchSize})`)
    
    try {
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      
      if (!res.ok) {
        const text = await res.text()
        console.error(`\n❌ Error Response (${res.status} ${res.statusText}):`)
        console.error(`URL: ${endpointUrl}`)
        try {
          console.error(JSON.stringify(JSON.parse(text), null, 2))
        } catch {
          console.error(text)
        }
        process.exit(1)
      }
      
      const data = await res.json()
      
      console.log(`✅ Batch complete! Inspected: ${data.inspected_threads}, Updated: ${data.updated_threads}, Skipped: ${data.skipped_threads}`)
      if (data.examples && data.examples.length > 0) {
        console.log(`Examples:\n`, JSON.stringify(data.examples.slice(0, 2), null, 2))
      }

      totalUpdated += data.updated_threads
      totalInspected += data.inspected_threads

      if (data.inspected_threads === 0) {
        console.log("No more threads to inspect. Stopping.")
        break
      }

      // If we didn't update anything in apply mode, we must advance the offset to avoid getting stuck
      // If we are in dry_run mode, we always advance the offset to keep scanning.
      if (data.updated_threads === 0 || dryRun) {
        offset += batchSize
      }

    } catch (err) {
      console.error(`\n❌ Fetch Exception:`)
      console.error(`Name: ${err.name}`)
      console.error(`Message: ${err.message}`)
      console.error(`Cause: ${err.cause}`)
      console.error(`Stack:\n${err.stack}`)
      process.exit(1)
    }

    currentBatch++
    if (currentBatch < maxBatches) {
      console.log(`Sleeping ${sleepMs}ms before next batch...`)
      await new Promise(r => setTimeout(r, sleepMs))
    }
  }

  console.log(`\n🎉 Rebuild job finished! Total Inspected: ${totalInspected}, Total Updated: ${totalUpdated}`)
}

run()