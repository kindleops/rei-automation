const fs = require('fs')

const file = '/Users/ryankindle/rei-automation/apps/dashboard/src/lib/data/fetchQueueModel.ts'
let content = fs.readFileSync(file, 'utf8')

// Fix chunked fetcher to support concurrent limits and custom sizes
content = content.replace(
  `  const fetchChunked = async (arr: string[], fetcher: (chunk: string[]) => Promise<{ data: any[] | null }>) => {`,
  `  const fetchChunked = async (arr: string[], fetcher: (chunk: string[]) => Promise<{ data: any[] | null }>, chunkSize = 100) => {`
)

content = content.replace(
  `    const chunks = chunkArray(arr, 15)
    const results = await Promise.all(chunks.map(fetcher))`,
  `    const chunks = chunkArray(arr, chunkSize)
    const results = []
    // Execute with limited concurrency (e.g. 5 at a time)
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5)
      results.push(...await Promise.all(batch.map(fetcher)))
    }`
)

content = content.replace(
  `    fetchChunked(pArr, chunk => supabase.from('properties').select('property_id,owner_id,master_owner_id,property_address,property_address_city,property_address_state,property_address_zip,market').in('property_id', chunk).limit(3000)),`,
  `    fetchChunked(pArr, chunk => supabase.from('properties').select('property_id,owner_id,master_owner_id,property_address,property_address_city,property_address_state,property_address_zip,market').in('property_id', chunk).limit(3000), 100),`
)

content = content.replace(
  `    fetchChunked(qArr, chunk => supabase.from('message_events').select('*').in('queue_id', chunk.map(v => \`"\${v}"\`)).limit(5000)),`,
  `    fetchChunked(qArr, chunk => supabase.from('message_events').select('*').in('queue_id', chunk.map(v => \`"\${v}"\`)).limit(5000), 30),`
)

content = content.replace(
  `    fetchChunked(cArr, chunk => supabase.from('sms_campaigns').select('id,campaign_name').in('id', chunk).limit(500)),`,
  `    fetchChunked(cArr, chunk => supabase.from('sms_campaigns').select('id,campaign_name').in('id', chunk).limit(500), 100),`
)

content = content.replace(
  `    fetchChunked(oArr, chunk => supabase.from('master_owners').select('master_owner_id,display_name,first_name,entity_name').in('master_owner_id', chunk).limit(3000)),`,
  `    fetchChunked(oArr, chunk => supabase.from('master_owners').select('master_owner_id,display_name,first_name,entity_name').in('master_owner_id', chunk).limit(3000), 100),`
)

content = content.replace(
  `      const qChunks = chunkArray(qArr, 15)
      const tChunks = chunkArray(tArr, 15)
      const maxLen = Math.max(qChunks.length, tChunks.length)
      const results = await Promise.all(Array.from({ length: maxLen }).map((_, i) => 
        fetchTargetChunked(qChunks[i] || [], tChunks[i] || [])
      ))`,
  `      const qChunks = chunkArray(qArr, 30)
      const tChunks = chunkArray(tArr, 30)
      const maxLen = Math.max(qChunks.length, tChunks.length)
      const results = []
      for (let i = 0; i < maxLen; i += 5) {
        const batch = Array.from({ length: Math.min(5, maxLen - i) }).map((_, j) => {
          const idx = i + j
          return fetchTargetChunked(qChunks[idx] || [], tChunks[idx] || [])
        })
        results.push(...await Promise.all(batch))
      }`
)

fs.writeFileSync(file, content)
