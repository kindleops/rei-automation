type ApiRequest = {
  method?: string
  body?: unknown
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: unknown) => void
}

type TranslateBody = {
  text?: unknown
  targetLanguage?: unknown
  sourceLanguage?: unknown
}

const parsePayload = (body: unknown): TranslateBody => {
  if (!body) return {}
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as TranslateBody
    } catch {
      return {}
    }
  }
  if (typeof body === 'object') {
    return body as TranslateBody
  }
  return {}
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const parsed = parsePayload(req.body)
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    const targetLanguage = typeof parsed.targetLanguage === 'string' && parsed.targetLanguage.trim()
      ? parsed.targetLanguage.trim().toLowerCase()
      : 'en'
    const sourceLanguage = typeof parsed.sourceLanguage === 'string' && parsed.sourceLanguage.trim()
      ? parsed.sourceLanguage.trim().toLowerCase()
      : 'auto'

    if (!text) {
      res.status(400).json({ error: 'Missing text payload' })
      return
    }

    const upstream = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLanguage)}&tl=${encodeURIComponent(targetLanguage)}&dt=t&q=${encodeURIComponent(text)}`,
    )

    if (!upstream.ok) {
      res.status(502).json({ error: `Translation provider failed (${upstream.status})` })
      return
    }

    const payload = await upstream.json() as unknown
    const top = Array.isArray(payload) ? payload : []
    const sentenceRows = Array.isArray(top[0]) ? top[0] as unknown[] : []
    const translatedText = sentenceRows
      .map((row) => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : ''))
      .join('')
      .trim()
    const detectedLanguage = typeof top[2] === 'string' ? top[2] : null

    if (!translatedText) {
      res.status(502).json({ error: 'Empty translation response' })
      return
    }

    res.status(200).json({
      translatedText,
      detectedLanguage,
      targetLanguage,
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Translation failed',
    })
  }
}
