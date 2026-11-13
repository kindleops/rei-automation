// A provider for createConversationModelClient that reaches the production models (claude-haiku-5-5 default,
// claude-sonnet-5-5 escalation) through the Claude Code CLI of the operator's own authorized session, for EVALUATION
// ONLY: no API key is read, nothing is sent to a seller, and the call is the same structured decision the worker makes
// (the tool's input_schema is enforced with --json-schema). The CLI runs with no tools, no settings, no MCP and a
// throwaway config directory, and with a minimal environment (never the enclosing session's own variables).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEEP = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE']

export function createCliModelProvider({ bin = 'claude', models = ['claude-haiku-5-5', 'claude-sonnet-5-5'], log = null, timeoutMs = 180_000 } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-eval-cli-'))
  const env = Object.fromEntries(KEEP.filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
  env.CLAUDE_CONFIG_DIR = configDir
  const ledger = { calls: 0, cli_cost_usd: 0, by_model: {} }
  return {
    ledger,
    async listModels() { return models.map((id) => ({ id, display_name: id, created_at: '2026-09-01T00:00:00Z' })) },
    async createMessage(params, { signal } = {}) {
      const system = (params.system || []).map((b) => b.text).join('\n\n')
      const user = (params.messages || []).map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('\n'))).join('\n\n')
      const tool = params.tools?.[0]
      const args = ['-p', '--model', params.model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-chrome',
        '--system-prompt', `${system}\n\nAnswer only through the structured output (the ${tool?.name} record).`, '--json-schema', JSON.stringify(tool?.input_schema || {})]
      const t0 = Date.now()
      const out = await new Promise((resolve, reject) => {
        const p = spawn(bin, args, { env, cwd: configDir, stdio: ['pipe', 'pipe', 'pipe'] })
        let so = '', se = ''
        const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
        signal?.addEventListener?.('abort', () => p.kill('SIGKILL'), { once: true })
        p.stdout.on('data', (d) => { so += d }); p.stderr.on('data', (d) => { se += d })
        p.on('close', (code) => { clearTimeout(timer); if (code !== 0 && !so) reject(Object.assign(new Error(`CLI_EXIT_${code}: ${se.slice(0, 200)}`), { code: 'PROVIDER_ERROR', billed: 'unknown' })); else resolve(so) })
        p.stdin.end(user)
      })
      let j
      try { j = JSON.parse(out) } catch { throw Object.assign(new Error('CLI_UNREADABLE'), { code: 'PROVIDER_ERROR', billed: 'unknown' }) }
      const cost = Number(j.total_cost_usd) || 0
      ledger.calls++; ledger.cli_cost_usd += cost; ledger.by_model[params.model] = (ledger.by_model[params.model] || 0) + 1
      log?.({ model: params.model, tool: tool?.name, ms: Date.now() - t0, cost_usd: cost, is_error: j.is_error || false })
      if (j.is_error) throw Object.assign(new Error(`CLI_ERROR: ${String(j.result || '').slice(0, 200)}`), { code: 'PROVIDER_ERROR', billed: 'unknown' })
      const input = j.structured_output && typeof j.structured_output === 'object' ? j.structured_output : null
      const u = j.usage || {}
      return {
        content: input ? [{ type: 'tool_use', id: `cli_${ledger.calls}`, name: tool?.name, input }] : [{ type: 'text', text: String(j.result || '') }],
        stop_reason: input ? 'tool_use' : 'end_turn',
        usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 },
      }
    },
  }
}
