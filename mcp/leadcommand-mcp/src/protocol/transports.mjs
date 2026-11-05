// Transports.
//
//   stdio            ENABLED. One process = one client; the principal is the host-configured operator.
//   streamable-http  ENABLED in 1.x for LOCAL clients only (protocol/http.mjs): binds 127.0.0.1 or
//                    ::1 (anything else refuses to boot), bearer token from a 0600 file (constant-time
//                    compare), Host + Origin validation (DNS-rebinding protection), shared gateway
//                    limits plus a per-session concurrency cap. The principal is STILL the
//                    host-configured operator, never derived from the token.
//                    Not designed for remote / multi-user exposure: that is the OAuth 2.1 resource-
//                    server design in docs/LEADCOMMAND-MCP-1.0.md §10 (not built).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export const HTTP_ENABLED = true
export const HTTP_PUBLIC_EXPOSURE = false

export function createStdioTransport({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return new StdioServerTransport(stdin, stdout)
}

export { startHttp } from './http.mjs'
