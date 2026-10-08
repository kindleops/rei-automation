// QA screenshots go to QA_OUT (default /tmp/staging-qa). Needs a headless Chrome with --remote-debugging-port=9333.
// Minimal CDP client for the Chrome on :9333. One tab per connect(); closed on exit.
import { writeFileSync } from "node:fs"
const PORT = process.env.CDP_PORT || 9333
export async function connect() {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0; const wait = new Map(); const events = []
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id) } else if (m.method) events.push(m) }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const ev = async (expression) => { const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || "eval failed"); return m.result?.result?.value }
  const c = {
    send, ev, sleep, events,
    async open(W, H, url, ms = 3000) {
      await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable")
      const mobile = W < 720
      await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile })
      if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
      await send("Page.navigate", { url }); await sleep(ms)
    },
    async go(url, ms = 2500) { await send("Page.navigate", { url }); await sleep(ms) },
    async shot(file, full = false) { const m = await send("Page.captureScreenshot", { format: "jpeg", quality: 86, captureBeyondViewport: full }); writeFileSync(file, Buffer.from(m.result.data, "base64")) },
  }
  const exit = process.exit.bind(process)
  process.exit = (code) => { fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {}).finally(() => exit(code)) }
  return c
}
