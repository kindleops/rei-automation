/**
 * §10 — WHY THE INBOX'S REALTIME WAS DEAD.
 *
 * Supabase delivers postgres_changes only for tables in the `supabase_realtime`
 * publication. Binding an UNPUBLISHED table does not fail loudly: subscribe()
 * still reports SUBSCRIBED, and every OTHER binding on that channel silently
 * stops delivering.
 *
 * The Inbox bound seven tables on its list channel and three on its thread
 * channel; four were unpublished and one did not exist. Both channels reported
 * connected and received nothing, so the surface stayed current only through
 * polling.
 *
 * This is the A/B that establishes the mechanism. Run it before adding any
 * binding. It writes nothing but an updated_at touch on the sanctioned canary
 * row -- no message, no queue row, no send.
 */
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'
const rd=async p=>fs.readFile(p,'utf8').catch(()=> '')
const env=(await rd('.env.local'))+'\n'+(await rd('../api/.env.local'))
const pick=k=>(new RegExp(`^${k}=(.+)$`,'m').exec(env)?.[1]??'').trim()
const URL_=pick('VITE_SUPABASE_URL'), ANON=pick('VITE_SUPABASE_ANON_KEY'), SVC=pick('SUPABASE_SERVICE_ROLE_KEY')

async function trial(label, bindUnpublished){
  const sb=createClient(URL_,ANON)
  let n=0
  let ch=sb.channel('t-'+label)
    .on('postgres_changes',{event:'*',schema:'public',table:'inbox_thread_state'},()=>{n++})
  if(bindUnpublished){
    // Exactly what InboxPage does today: a third binding on a table that is
    // NOT in the supabase_realtime publication.
    ch=ch.on('postgres_changes',{event:'*',schema:'public',table:'operator_thread_state'},()=>{})
  }
  let err=null
  const status=await new Promise(res=>ch.subscribe((s,e)=>{ if(e) err=String(e.message||e).slice(0,70); if(s==='SUBSCRIBED'||s==='CHANNEL_ERROR'||s==='TIMED_OUT') res(s) }))
  await new Promise(r=>setTimeout(r,1500))
  const w=createClient(URL_,SVC)
  await w.from('inbox_thread_state').update({updated_at:new Date().toISOString()}).eq('canonical_e164','+13059807795')
  await new Promise(r=>setTimeout(r,9000))
  console.log(`  ${label.padEnd(34)} status=${status.padEnd(13)} events=${n}${err?'  err='+err:''}`)
  await sb.removeAllChannels()
}
await trial('inbox_thread_state only', false)
await trial('+ operator_thread_state (CONTROL: the trap, not what the app binds)', true)
process.exit(0)
