export type PipelineErrorCategory =
  | 'network'
  | 'backend'
  | 'timeout'
  | 'validation'
  | 'unknown'

export interface PipelineOperatorError {
  message: string
  category: PipelineErrorCategory
  traceId?: string
  retryable: boolean
}

const FILESYSTEM_PATTERNS = [
  /cannot find module/i,
  /require stack/i,
  /apps\/api\/\.next/i,
  /node_modules/i,
  /ENOENT/i,
  /vendor-chunks/i,
]

export function sanitizePipelineError(raw: unknown, traceId?: string): PipelineOperatorError {
  const text = raw instanceof Error ? raw.message : String(raw ?? 'unknown_error')
  const isFilesystemLeak = FILESYSTEM_PATTERNS.some((re) => re.test(text))
  const isTimeout = /timed out|timeout|abort/i.test(text)
  const isNetwork = /failed to fetch|network|ECONNREFUSED/i.test(text)

  if (isTimeout) {
    return {
      message: 'Request timed out. Try again.',
      category: 'timeout',
      traceId,
      retryable: true,
    }
  }

  if (isFilesystemLeak) {
    return {
      message: 'Pipeline service is temporarily unavailable. Retry or restart the local API server.',
      category: 'backend',
      traceId,
      retryable: true,
    }
  }

  if (isNetwork) {
    return {
      message: 'Cannot reach the pipeline API. Check your connection and retry.',
      category: 'network',
      traceId,
      retryable: true,
    }
  }

  const cleaned = text
    .replace(/\[(\d{3})\]\s*/g, '')
    .replace(/\s*—\s*http\S+/g, '')
    .replace(/\(body:.*\)/gi, '')
    .replace(/\(trace: [^)]+\)/gi, '')
    .trim()

  return {
    message: cleaned.length > 0 && cleaned.length < 200 ? cleaned : 'Pipeline request failed.',
    category: 'unknown',
    traceId,
    retryable: true,
  }
}