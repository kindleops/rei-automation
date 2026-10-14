// Transports.
//
//   stdio            ENABLED (1.0). The principal is the host-configured operator.
//   Streamable HTTP  DESIGNED, DISABLED. startHttp() refuses unconditionally in 1.0.
//                    The 1.1 design (docs/LEADCOMMAND-MCP-1.0.md §Streamable HTTP):
//                    OAuth 2.1 resource server (RFC 9728 protected-resource metadata,
//                    audience-bound bearer tokens, no token passthrough), principal
//                    from the VERIFIED token per request, Origin allowlist + DNS-
//                    rebinding protection, loopback bind by default, per-session rate
//                    state in the shared store, MCP-Protocol-Version header check.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export const HTTP_ENABLED = false

export function createStdioTransport({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return new StdioServerTransport(stdin, stdout)
}

export function startHttp() {
  throw new Error('Streamable HTTP is designed but DISABLED in LeadCommand MCP 1.0 (stdio only)')
}
