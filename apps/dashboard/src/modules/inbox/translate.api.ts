import { callBackend } from '../../lib/api/backendClient'

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
  // Through the operator session (Worker-gated cockpit route). The public
  // /api/translate is a 501 stub in production; only the dev server answered it.
  const res = await callBackend<Record<string, unknown>>('/api/cockpit/inbox/translate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  const body = res.ok ? res.data : null
  if (!res.ok || !body || body.ok === false) {
    const message = body && typeof body.error === 'string'
      ? body.error
      : `Translation failed (${res.status})`
    throw new Error(message)
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
