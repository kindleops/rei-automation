import { resolveOutboundTextgridNumber } from '../src/lib/data/textgridRouting'

async function run() {
  const tests = [
    { market: 'phoenix, az', property_address_state: 'AZ' },
    { market: 'las vegas, nv', property_address_state: 'NV' },
    { market: 'tulsa, ok', property_address_state: 'OK' },
    { market: 'nashville, tn', property_address_state: 'TN' },
    { market: 'seattle, wa', property_address_state: 'WA' }
  ]
  
  for (const t of tests) {
    const res = await resolveOutboundTextgridNumber({
      market: t.market,
      property_address_state: t.property_address_state,
      allow_cluster_routing: true
    } as any)
    console.log(`${t.market} -> tier: ${res.routing_tier}, cluster: ${res.routing_cluster}, from: ${res.from_phone_number}, reason: ${res.routing_reason}`)
  }
}
run().catch(console.error)