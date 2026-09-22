import { chromium } from 'playwright'
const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})
const p=await ctx.newPage()
await p.goto('http://localhost:5174/inbox',{waitUntil:'domcontentloaded',timeout:120000})
await p.waitForFunction(()=>document.querySelectorAll('.nx-row25').length>0,undefined,{timeout:90000,polling:500}).catch(()=>{})
await p.waitForTimeout(2000)
// the funnel control in the search bar
const info=await p.evaluate(()=>({
  icons:[...document.querySelectorAll('.nx-sidebar__icon-button')].map(x=>({
    aria:x.getAttribute('aria-label'), title:x.getAttribute('title'), txt:(x.innerText||'').trim().slice(0,12)})),
  cats:[...document.querySelectorAll('.nx-cat-nav__item')].map(x=>(x.innerText||'').replace(/\s+/g,' ').trim().slice(0,22)),
}))
console.log('icon buttons:', JSON.stringify(info.icons))
console.log('categories  :', JSON.stringify(info.cats))
const funnel=p.locator('.nx-sidebar__icon-button').first()
await funnel.click({timeout:15000}).catch(e=>console.log('  click failed:',e.message.slice(0,50)))
await p.waitForTimeout(2000)
console.log(JSON.stringify(await p.evaluate(()=>{
  const modal=document.querySelector('.nx-ifm, [class*="AdvancedFilters"], [class*="filters-modal"], [class*="ifm"]')
  const sheet=document.querySelector('.nx-mobile-sheet')
  const r=modal?.getBoundingClientRect()
  return {modalPresent:!!modal, modalClass:modal?.className?.toString().slice(0,50)||null,
    modalBox:r?`${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`:null,
    isMobileSheet:!!sheet,
    overflowX:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),
    viewport:`${innerWidth}x${innerHeight}`}
}),null,2))
await p.screenshot({path:'artifacts/filters-before.png'})
await b.close()
