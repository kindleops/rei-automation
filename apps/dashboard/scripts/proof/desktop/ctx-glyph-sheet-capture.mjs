import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CONTEXT GLYPH SHEET (offline, no dev stack, no network). Renders the real
 * context-icons tiles (esbuild IIFE of src/views/map/desktop/context/context-icons.ts)
 * at the map's zoom sizes over dark / light / satellite / red-ops grounds, next to
 * a property-pin-sized dot for hierarchy, and next to the OLD camera/crime dots.
 *
 *   npx esbuild src/views/map/desktop/context/context-icons.ts --bundle --format=iife --global-name=CtxIcons --outfile=<dir>/context-icons.iife.js
 *   node scripts/proof/desktop/ctx-glyph-sheet-capture.mjs --iife=<dir>/context-icons.iife.js --out=<dir>
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const OUT = path.resolve(arg('out', 'artifacts/ctx-glyphs'))
const IIFE = path.resolve(arg('iife', 'artifacts/ctx-glyphs/context-icons.iife.js'))
await fs.mkdir(OUT, { recursive: true })
const js = await fs.readFile(IIFE, 'utf8')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:12px -apple-system,system-ui,sans-serif;background:#222;color:#ddd}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:0}
.p{position:relative;height:430px;overflow:hidden;padding:12px 14px}
.p h4{margin:0 0 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.8}
.row{display:flex;align-items:center;gap:10px;margin:6px 0}
.row span{width:64px;opacity:.75}
.dark{background:#10141b;color:#cfd6e2}
.light{background:#eceff2;color:#2a3342}
.sat{background:radial-gradient(circle at 30% 30%,#4c5a3a,#2b3424 40%,#55604a 70%,#3a3f33);color:#eef}
.red{background:#140c0d;color:#e8d6d6}
.road{position:absolute;left:0;right:0;height:5px;background:rgba(150,160,180,.35);top:210px}
.dark .road{background:#26303f}.light .road{background:#fff}
.pin{width:14px;height:14px;border-radius:50%;background:#ffb347;box-shadow:0 0 0 2px #10141b, 0 0 0 3px #ffb34788}
.old{border-radius:50%}
</style></head><body><div class="g" id="g"></div><script>${js}</script><script>
const I = CtxIcons
const grounds = [['dark','d','Dark map'],['light','l','Light map'],['sat','d','Satellite'],['red','d','Red Ops (dark ground)']]
const sizes = [['z9 (0.66)',0.66],['z12 (0.82)',0.82],['z15 (1.0)',1]]
const glyphs = I.ALL_GLYPHS
const g = document.getElementById('g')
for (const [cls, ground, label] of grounds) {
  const p = document.createElement('div'); p.className = 'p ' + cls
  p.innerHTML = '<div class="road"></div><h4>' + label + '</h4>'
  for (const [sl, s] of sizes) {
    const row = document.createElement('div'); row.className = 'row'
    row.innerHTML = '<span>' + sl + '</span>'
    for (const id of glyphs) {
      const img = I.drawTile(id, ground)
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      c.getContext('2d').putImageData(img, 0, 0)
      // an <img> of the tile (headless Chrome mis-composites CSS-scaled canvases)
      const el = new Image(); el.src = c.toDataURL('image/png')
      const css = I.TILE_PX * s
      el.style.width = css + 'px'; el.style.height = css + 'px'
      row.appendChild(el)
    }
    p.appendChild(row)
  }
  const cmp = document.createElement('div'); cmp.className = 'row'
  cmp.innerHTML = '<span>vs pin</span><div class="pin"></div><span style="width:auto">property pin (operational) · old camera dot:</span><div class="old" style="width:5px;height:5px;background:#5cc8ff;opacity:.9"></div><span style="width:auto">old crime dot:</span><div class="old" style="width:4px;height:4px;background:#8ea2ff;opacity:.72"></div>'
  p.appendChild(cmp)
  g.appendChild(p)
}
</script></body></html>`
const file = path.join(OUT, 'glyph-sheet.html')
await fs.writeFile(file, html)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 440 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.route('**/*', (r) => (r.request().url().startsWith('file://') ? r.continue() : r.abort()))
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 60_000)
await page.goto(`file://${file}`)
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(OUT, 'glyph-sheet.png'), fullPage: true })
clearTimeout(watchdog)
await browser.close()
console.log('wrote', path.join(OUT, 'glyph-sheet.png'))
