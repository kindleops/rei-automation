import { chromium } from 'playwright'
const B='http://localhost:5173'
const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})
const p=await ctx.newPage()
await p.goto(`${B}/inbox`,{waitUntil:'domcontentloaded',timeout:180000})
await p.waitForSelector('.nx-row25',{timeout:120000}); await p.waitForTimeout(2500)

const res = await p.evaluate(() => {
  const card = (linked, name) => `
    <section class="nx-active-prospect">
      <div class="nx-active-prospect__card is-selected">
        <div class="nx-active-prospect__identity-line">
          <span class="nx-active-prospect__name">${name}</span>
          <span class="nx-active-prospect__dot">·</span>
          <span class="nx-active-prospect__rank">#1</span>
          <span class="nx-active-prospect__dot">·</span>
          <span class="nx-active-prospect__relationship">Likely Owner</span>
        </div>
        <div class="nx-active-prospect__sub-line">
          <span class="nx-active-prospect__phone">(305) 980-7795</span>
          <span class="nx-active-prospect__ownership is-neutral"><span>Ownership unverified</span></span>
          ${linked > 1 ? `<button class="nx-active-prospect__expand"><span>${linked} linked</span></button>` : ''}
        </div>
      </div>
    </section>`
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:390px;z-index:-1;'
  document.body.appendChild(host)
  const out = []
  for (const [n, name] of [[1,'Jose Rodriguez'],[2,'Jose Rodriguez'],[4,'Jose Rodriguez'],[7,'Bartholomew Fitzgerald-Whitmore']]) {
    host.innerHTML = card(n, name)
    const el = host.querySelector('.nx-active-prospect')
    const sub = host.querySelector('.nx-active-prospect__sub-line')
    const exp = host.querySelector('.nx-active-prospect__expand')
    out.push({ n, h: Math.round(el.getBoundingClientRect().height),
      subH: Math.round(sub.getBoundingClientRect().height),
      expandVisible: exp ? exp.getBoundingClientRect().width > 0 : null,
      expandRight: exp ? Math.round(exp.getBoundingClientRect().right) : null })
  }
  host.remove()
  return out
})
for (const r of res) console.log(`  ${r.n} prospect(s): card=${r.h}px subLine=${r.subH}px expandVisible=${r.expandVisible} expandRight=${r.expandRight}`)
console.log('  distinct card heights:', JSON.stringify([...new Set(res.map(r=>r.h))]))
await b.close()
