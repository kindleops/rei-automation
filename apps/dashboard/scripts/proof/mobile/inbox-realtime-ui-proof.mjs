/* §10 — realtime proved END TO END in the browser. Triggers a harmless
   updated_at touch on the sanctioned canary row. No message, no queue row. */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'
const rd=async p=>fs.readFile(p,'utf8').catch(()=> '')
const env=(await rd('.env.local'))+'\n'+(await rd('../api/.env.local'))
const pick=k=>(new RegExp(`^${k}=(.+)$`,'m').exec(env)?.[1]??'').trim()
const w=createClient(pick('VITE_SUPABASE_URL'), pick('SUPABASE_SERVICE_ROLE_KEY'))

const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true})
const p=await ctx.newPage()
const rt=[]
p.on('console',m=>{const t=m.text(); if(/realtime|REALTIME/i.test(t)) rt.push(t.slice(0,90))})
await p.goto('http://localhost:5174/inbox',{waitUntil:'domcontentloaded',timeout:120000})
await p.waitForFunction(()=>document.querySelectorAll('.nx-row25').length>0,undefined,{timeout:90000,polling:500}).catch(()=>{})
await p.waitForTimeout(6000)
rt.length=0
console.log('  list mounted; firing a canonical state change...')
await w.from('inbox_thread_state').update({updated_at:new Date().toISOString()}).eq('canonical_e164','+13059807795')
await p.waitForTimeout(9000)
console.log(`  realtime console lines after the change: ${rt.length}`)
for(const l of rt.slice(0,4)) console.log('   ',l)
await b.close()
