import { proxyBackendRequest } from '../_lib/backendProxy'

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

export default async function handler(req: ApiRequest, res: ApiResponse) {
  await proxyBackendRequest(req, res)
}