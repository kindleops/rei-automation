type ApiRequest = {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  setHeader: (name: string, value: string) => void
  send: (body: Buffer) => void
  json: (body: unknown) => void
}

const resolveBackendBaseUrl = (): string => (
  process.env.VITE_BACKEND_API_URL
  || process.env.REAL_ESTATE_AUTOMATION_BASE_URL
  || ''
).replace(/\/$/, '')

const forwardHeader = (req: ApiRequest, name: string): string | undefined => {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

export async function proxyBackendRequest(req: ApiRequest, res: ApiResponse): Promise<void> {
  const backend = resolveBackendBaseUrl()
  if (!backend) {
    res.status(503).json({ error: 'BACKEND_NOT_CONFIGURED', message: 'Set VITE_BACKEND_API_URL on the dashboard project.' })
    return
  }

  const incomingPath = (req.url || '/').split('?')[0] || '/'
  const query = (req.url || '').includes('?') ? req.url!.slice(req.url!.indexOf('?')) : ''
  const targetUrl = `${backend}${incomingPath}${query}`

  const headers: Record<string, string> = {}
  const secret = forwardHeader(req, 'x-ops-dashboard-secret')
  const auth = forwardHeader(req, 'authorization')
  const contentType = forwardHeader(req, 'content-type')
  const accept = forwardHeader(req, 'accept')
  const cookie = forwardHeader(req, 'cookie')

  if (secret) headers['x-ops-dashboard-secret'] = secret
  if (auth) headers.authorization = auth
  if (contentType) headers['content-type'] = contentType
  if (accept) headers.accept = accept
  if (cookie) headers.cookie = cookie

  const method = (req.method || 'GET').toUpperCase()
  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD' && req.body != null) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    if (!headers['content-type']) headers['content-type'] = 'application/json'
  }

  let upstream: Response
  try {
    upstream = await fetch(targetUrl, { method, headers, body })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(502).json({ error: 'BACKEND_PROXY_FAILED', message, targetUrl })
    return
  }

  res.status(upstream.status)
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'content-encoding') return
    res.setHeader(key, value)
  })

  const buffer = Buffer.from(await upstream.arrayBuffer())
  res.send(buffer)
}