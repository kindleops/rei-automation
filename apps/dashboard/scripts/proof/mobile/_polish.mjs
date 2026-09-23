import { chromium } from 'playwright'
const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})
const p=await ctx.newPage()
await p.goto('http://localhost:5173/inbox',{waitUntil:'domcontentloaded',timeout:180000})
await p.waitForSelector('.nx-row25',{timeout:120000}); await p.waitForTimeout(4000)

// §1A — rail geometry + vertical stability under a horizontal swipe
const rail=await p.evaluate(()=>{
  const el=document.querySelector('.nx-cat-nav'); if(!el) return null
  const cs=getComputedStyle(el); const r=el.getBoundingClientRect()
  return {h:Math.round(r.height), top:Math.round(r.top), sw:el.scrollWidth, cw:el.clientWidth,
    overflowY:cs.overflowY, touchAction:cs.touchAction, overscrollX:cs.overscrollBehaviorX,
    transition:cs.transitionProperty}
})
console.log('  §1A rail:',JSON.stringify(rail))
if(rail){
  const before=await p.evaluate(()=>{const e=document.querySelector('.nx-cat-nav');return {top:Math.round(e.getBoundingClientRect().top),sy:Math.round(window.scrollY)}})
  await p.evaluate(()=>{document.querySelector('.nx-cat-nav').scrollLeft=200})
  await p.waitForTimeout(500)
  const after=await p.evaluate(()=>{const e=document.querySelector('.nx-cat-nav');return {top:Math.round(e.getBoundingClientRect().top),sy:Math.round(window.scrollY),sl:Math.round(e.scrollLeft)}})
  console.log(`  §1A after horizontal scroll: top ${before.top} -> ${after.top} | pageY ${before.sy} -> ${after.sy} | scrollLeft=${after.sl}`)
}

// §8 — seller tags on cards
const tags=await p.evaluate(()=>{
  const out=[]
  for(const row of [...document.querySelectorAll('.nx-row25')].slice(0,6)){
    const chips=[...row.querySelectorAll('.nx-prop-flags__badge')].map(e=>e.textContent.trim())
    const ovf=row.querySelector('.nx-prop-flags__overflow')?.textContent?.trim()??null
    const hidden=[...row.querySelectorAll('.nx-prop-flags__popover .nx-prop-flags__badge')].map(e=>e.textContent.trim())
    if(chips.length) out.push({visible:chips.filter(c=>!hidden.includes(c)).slice(0,3),ovf,hiddenCount:hidden.length})
  }
  return out
})
console.log('  §8 tags:'); for(const t of tags) console.log('   ',JSON.stringify(t))
await b.close()
