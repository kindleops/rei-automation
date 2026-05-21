export interface TranslateRequest {
  text: string
  targetLanguage: string
  sourceLanguage?: string
  mode?: 'thread' | 'draft'
}

export interface TranslateResponse {
  translatedText: string
  detectedLanguage: string | null
  targetLanguage: string
}

export const translateText = async (payload: TranslateRequest): Promise<TranslateResponse> => {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body.error === 'string'
      ? body.error
      : `Translation failed (${response.status})`
    throw new Error(message)
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Invalid translation response')
  }

  const translatedText = typeof (body as { translatedText?: unknown }).translatedText === 'string'
    ? (body as { translatedText: string }).translatedText
    : ''

  if (!translatedText.trim()) {
    throw new Error('Empty translation response')
  }

  return {
    translatedText,
    detectedLanguage: typeof (body as { detectedLanguage?: unknown }).detectedLanguage === 'string'
      ? (body as { detectedLanguage: string }).detectedLanguage
      : null,
    targetLanguage: typeof (body as { targetLanguage?: unknown }).targetLanguage === 'string'
      ? (body as { targetLanguage: string }).targetLanguage
      : payload.targetLanguage,
  }
}
