import { chromium } from 'playwright'
const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})
const page=await ctx.newPage()
await page.goto('http://localhost:5174/inbox',{waitUntil:'domcontentloaded',timeout:180000})
await page.waitForSelector('.nx-row25',{timeout:120000}); await page.waitForTimeout(4000)
// One thread, no loop: re-entering the list mid-reorder is what made this flaky.
await page.locator('.nx-row25').first().click()
await page.waitForFunction(()=>{
  const l=document.querySelector('.nx-message-list')
  const ap=document.querySelector('.nx-active-prospect')
  return l&&l.getBoundingClientRect().height>100&&(!ap||!ap.innerText.includes('Loading'))
},undefined,{timeout:30000,polling:250}).catch(()=>{})
await page.waitForTimeout(1500)
const g=await page.evaluate(()=>{
  const box=(s)=>{const e=document.querySelector(s);return e?{t:Math.round(e.getBoundingClientRect().top),b:Math.round(e.getBoundingClientRect().bottom),h:Math.round(e.getBoundingClientRect().height)}:null}
  const list=document.querySelector('.nx-message-list')
  return {vh:window.innerHeight,
    list:box('.nx-message-list'), ap:box('.nx-active-prospect'), comp:box('.nx-composer'),
    contentH:list?Math.round(list.scrollHeight):0,
    chips:[...document.querySelectorAll('.nx-conv-property-strip .nx-intel-cell')].map(c=>c.innerText.trim()),
    sv:document.querySelectorAll('.nx-conv-mobile-identity__sv img').length,
    glow:getComputedStyle(document.querySelector('.nx-conv-header__liquid')||document.body).opacity}
})
console.log('  viewport', g.vh, '| list', g.list?.h, '| content', g.contentH, '| prospect', g.ap?.h, '| composer', g.comp?.h)
console.log('  chips:', g.chips.join(' / ') || '(none)')
console.log('  street view img:', g.sv, '| header liquid opacity:', g.glow)
await page.screenshot({path:'/tmp/geom.png'})
await b.close()
