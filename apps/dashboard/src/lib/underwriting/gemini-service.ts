/**
 * Gemini Service Wrapper for Underwriting Research
 */

export interface GeminiUnderwriteResponse {
  property_info: {
    sqft: number
    beds: number
    baths: number
    year_built: number
    last_sale_price: number
    last_sale_date: string
  }
  valuation: {
    arv_estimate: number
    repair_estimate: number
    repair_confidence: 'high' | 'medium' | 'low'
    market_rent: number
  }
  comps: Array<{
    address: string
    price: number
    date_sold: string
    distance_miles: number
    sqft: number
    source_url: string
  }>
  market_context: {
    neighborhood_velocity: 'high' | 'medium' | 'low'
    cash_buyer_activity: 'high' | 'medium' | 'low'
    exit_strategy: string
  }
}

export async function fetchUnderwritingResearch(
  address: string,
  propertyType: string,
  apiKey: string
): Promise<GeminiUnderwriteResponse> {
  const prompt = `You are an expert Real Estate Acquisitions Analyst. Your goal is to provide deep-dive research and comparables for a property address.

ADDRESS: ${address}
PROPERTY TYPE: ${propertyType}

RESEARCH SOURCE PRIORITY:
- SFR Comps: 1. Zillow Sold, 2. Redfin Sold, 3. Realtor.com Sold, 4. County Assessor/Recorder, 5. Google Maps.
- Rental Comps: 1. Zillow Rentals, 2. Rentometer, 3. Apartments.com, 4. Realtor.
- Multifamily Comps: 1. Crexi, 2. LoopNet, 3. Apartments.com, 4. County Records, 5. Local broker listings.

STRICT RULES:
1. SOLD COMPS ONLY for ARV. Sold comps override active listings.
2. PUBLIC RECORDS override estimates. NEVER use Zestimate or Redfin Estimate as the final ARV.
3. PROXIMITY: Prefer comps within 0.5 miles and 6 months. Expand to 1 mile and 12 months ONLY if needed.
4. MATCHING: Match property type, beds, baths, sqft, year built, and condition.
5. EVIDENCE: Provide a source_url for EVERY comp.
6. WEAK COMPS: Flag any comp further than 1 mile or older than 12 months as a "Weak Comp" in the market_context.

Return ONLY a valid JSON object matching the requested schema.`

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt + '\n\nIMPORTANT: Return ONLY the JSON object. Do not include markdown formatting or preamble.' }] }]
      })
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gemini API failed: ${err}`)
  }

  const result = await response.json()
  let content = result.candidates?.[0]?.content?.parts?.[0]?.text
  
  if (!content) {
    throw new Error('Empty response from Gemini')
  }

  // Clean potential markdown backticks
  content = content.replace(/```json/g, '').replace(/```/g, '').trim()

  return JSON.parse(content) as GeminiUnderwriteResponse
}
