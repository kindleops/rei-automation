import { fetchUnderwritingResearch } from '../../../src/lib/underwriting/gemini-service'
import { calculateWholesaleDeal } from '../../../src/lib/underwriting/calculator'

type ApiRequest = {
  method?: string
  body?: any
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: any) => void
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
    return
  }

  try {
    const { address, propertyType = 'sfh', askingPrice } = req.body

    if (!address) {
      res.status(400).json({ error: 'Address is required' })
      return
    }

    // 1. Fetch AI Research (Comps & Valuation Estimates)
    const research = await fetchUnderwritingResearch(address, propertyType, apiKey)

    // 2. Deterministic Financial Validation
    const financialAnalysis = calculateWholesaleDeal({
      propertyType: propertyType as any,
      arv: research.valuation.arv_estimate,
      repairs: research.valuation.repair_estimate,
      askingPrice: askingPrice ? parseFloat(askingPrice) : null
    })

    // 3. Construct Final Underwriting Payload
    const response = {
      address,
      property_info: research.property_info,
      valuation: {
        ...research.valuation,
        ...financialAnalysis
      },
      comps: research.comps,
      market_context: research.market_context,
      underwritten_at: new Date().toISOString(),
      version: '1.0.0'
    }

    res.status(200).json(response)
  } catch (error) {
    console.error('[Underwrite API Error]:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Underwriting failed'
    })
  }
}
