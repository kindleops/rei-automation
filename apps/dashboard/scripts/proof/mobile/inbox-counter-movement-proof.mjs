/**
 * §3 — CATEGORY COUNTERS MOVE ON A CANONICAL STATE CHANGE, WITHOUT A RELOAD.
 *
 * Archives the sanctioned canary thread, watches the badges, then restores it.
 * Writes only is_archived on that one row: no message, no queue row, no send.
 *
 * Two things had to be fixed before this could pass, and both are worth
 * knowing about if it ever regresses:
 *   1. The Inbox's realtime channels bound unpublished tables, which silently
 *      disabled every other binding (see inbox-realtime-binding-proof.mjs).
 *   2. /api/cockpit/inbox/counts is client-cached for 60s, so the refresh this
 *      triggers returned the cached value and no request left the browser.
 *
 * NOTE the first assertion this proof taught: is_read drives NONE of the nine
 * exposed chips, so flipping it proves nothing. is_archived moves three.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'
const rd=async p=>fs.readFile(p,'utf8').catch(()=> '')
const env=(await rd('.env.local'))+'\n'+(await rd('../api/.env.local'))
const pick=k=>(new RegExp(`^${k}=(.+)$`,'m').exec(env)?.[1]??'').trim()
const w=createClient(pick('VITE_SUPABASE_URL'), pick('SUPABASE_SERVICE_ROLE_KEY'))
const CANARY='+13059807795'

const readBadges = () => {
  const out={}
  for(const el of document.querySelectorAll('.nx-cat-nav__item')){
    const label=(el.querySelector('.nx-cat-nav__label')?.textContent||'').trim()
    const count=(el.querySelector('.nx-cat-nav__count')?.textContent||'').trim()
    out[label]=count
  }
  return out
}

const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})
const p=await ctx.newPage()
const reqs=[]
p.on('request',r=>{const u=r.url(); if(/inbox\/(counts|live)/.test(u)) reqs.push(u.split('/api/cockpit/')[1].slice(0,40))})
const logs=[]
const errs=[]
p.on('pageerror',e=>errs.push(String(e.message).slice(0,100)))
p.on('console',m=>{ if(m.type()==='error') errs.push('console:'+m.text().slice(0,90)) })
p.on('console',m=>{const t=m.text(); if(/REALTIME|realtime/i.test(t)) logs.push(t.slice(0,70))})
await p.goto('http://localhost:5174/inbox',{waitUntil:'domcontentloaded',timeout:120000})
await p.waitForFunction(()=>document.querySelectorAll('.nx-row25').length>0,undefined,{timeout:90000,polling:500}).catch(()=>{})
await p.waitForTimeout(5000)

// baseline
/* is_read drives NO exposed chip -- the nine on screen are bucket-based, so
   flipping it proves nothing. is_archived moves BOTH Archived and All. */
const {data:before}=await w.from('inbox_thread_state').select('is_archived').eq('canonical_e164',CANARY).single()
const b0=await p.evaluate(readBadges)
console.log('  canary is_archived before:', before.is_archived)
console.log('  badges before:', JSON.stringify(b0))

// flip read state on the sanctioned canary -- a canonical change, no message
await w.from('inbox_thread_state').update({is_archived: !before.is_archived}).eq('canonical_e164',CANARY)
reqs.length=0; logs.length=0
await p.waitForTimeout(12000)
const b1=await p.evaluate(readBadges)
console.log('  realtime logs after change:', logs.length, logs.slice(0,2))
console.log('  API calls after change    :', reqs.length, reqs.slice(0,4))
console.log('  page errors               :', errs.length, errs.slice(0,3))
console.log('  badges after :', JSON.stringify(b1))
const moved=Object.keys(b0).filter(k=>b0[k]!==b1[k])
console.log('  badges that MOVED without reload:', moved.length? moved.map(k=>`${k} ${b0[k]}->${b1[k]}`) : 'none')

// restore
await w.from('inbox_thread_state').update({is_archived: before.is_archived}).eq('canonical_e164',CANARY)
await p.waitForTimeout(6000)
const b2=await p.evaluate(readBadges)
console.log('  badges restored:', JSON.stringify(b2)===JSON.stringify(b0) ? 'yes (back to baseline)' : 'CHECK: '+JSON.stringify(b2))
await b.close()
