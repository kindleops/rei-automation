#!/usr/bin/env node
// LeadCommand MCP entry point.
//   stdio (default)            stdout carries ONLY the MCP protocol; diagnostics and audit lines go
//                              to stderr (or LEADCOMMAND_MCP_AUDIT_FILE).
//   streamable-http (1.x)      LEADCOMMAND_MCP_TRANSPORT=streamable-http: loopback-only listener
//                              (protocol/http.mjs); audit lines as above.
import '../src/loader/register.mjs'

const { buildApp } = await import('../src/app.mjs')
const { createStdioTransport, startHttp } = await import('../src/protocol/transports.mjs')

let app
try {
  app = await buildApp()
} catch (e) {
  // config errors name the variable, never a value
  process.stderr.write(`${JSON.stringify({ event: 'server_boot_failed', message: String(e?.message || e).slice(0, 300) })}\n`)
  process.exit(2)
}

if (app.cfg.transport === 'streamable-http') {
  let listener
  try {
    listener = await startHttp({ app })
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ event: 'server_boot_failed', message: String(e?.code || e?.message || e).slice(0, 300) })}\n`)
    await app.close().catch(() => {})
    process.exit(2)
  }
  const shutdown = async (code = 0) => {
    await listener.close().catch(() => {})
    await app.close().catch(() => {})
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
} else {
  const transport = createStdioTransport()
  const shutdown = async (code = 0) => {
    await app.close().catch(() => {})
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.stdin.on('end', () => shutdown(0)) // client disconnected
  await app.server.connect(transport)
}
