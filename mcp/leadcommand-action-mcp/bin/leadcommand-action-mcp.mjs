#!/usr/bin/env node
// LeadCommand ACTION MCP entry point.
//   stdio (default)            one process = one agent (LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE); stdout carries
//                              ONLY the MCP protocol; audit lines go to stderr or LEADCOMMAND_ACTION_MCP_AUDIT_FILE
//   streamable-http            LEADCOMMAND_ACTION_MCP_TRANSPORT=streamable-http: loopback only, one bearer credential per agent
import '../src/loader/register.mjs'

const { buildApp } = await import('../src/app.mjs')
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
const { startHttp } = await import('../src/protocol/http.mjs')

let app
try {
  app = await buildApp()
} catch (e) {
  process.stderr.write(`${JSON.stringify({ event: 'server_boot_failed', message: String(e?.message || e).slice(0, 300) })}\n`)
  process.exit(2)
}
app.startRecovery(Number(process.env.LEADCOMMAND_ACTION_MCP_RECOVERY_INTERVAL_MS) || 30_000)

if (app.cfg.transport === 'streamable-http') {
  let listener
  try {
    listener = await startHttp({ app })
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ event: 'server_boot_failed', message: String(e?.code || e?.message || e).slice(0, 300) })}\n`)
    await app.close().catch(() => {})
    process.exit(2)
  }
  const shutdown = async (code = 0) => { await listener.close().catch(() => {}); await app.close().catch(() => {}); process.exit(code) }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
} else {
  const shutdown = async (code = 0) => { await app.close().catch(() => {}); process.exit(code) }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.stdin.on('end', () => shutdown(0))
  await app.server.connect(new StdioServerTransport(process.stdin, process.stdout))
}
