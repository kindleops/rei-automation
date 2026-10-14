#!/usr/bin/env node
// LeadCommand MCP 1.0 — stdio entry point. stdout carries ONLY the MCP protocol;
// diagnostics and audit lines go to stderr (or LEADCOMMAND_MCP_AUDIT_FILE).
import '../src/loader/register.mjs'

const { buildApp } = await import('../src/app.mjs')
const { createStdioTransport } = await import('../src/protocol/transports.mjs')

let app
try {
  app = await buildApp()
} catch (e) {
  // config errors name the variable, never a value
  process.stderr.write(`${JSON.stringify({ event: 'server_boot_failed', message: String(e?.message || e).slice(0, 300) })}\n`)
  process.exit(2)
}

const transport = createStdioTransport()
const shutdown = async (code = 0) => {
  await app.close().catch(() => {})
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.stdin.on('end', () => shutdown(0)) // client disconnected
await app.server.connect(transport)
