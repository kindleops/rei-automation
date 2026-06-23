import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '/Users/ryankindle/rei-automation/apps/api/.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('--- 1. Audit raw message_events ---');
  const { data: auditData, error: auditError } = await supabase
    .from('message_events')
    .select('id, direction, type, event_type, delivery_status, provider_delivery_status, to_phone_number, from_phone_number, thread_key, message_body, created_at, received_at, sent_at, detected_intent, current_stage, auto_reply_status, safety_status, priority, risk')
    .order('created_at', { ascending: false })
    .limit(500);

  if (auditError) {
    console.error('Audit Error:', auditError);
  } else {
    console.log(`Fetched ${auditData.length} recent message_events`);
    // console.log(auditData.slice(0, 5));
  }

  console.log('\n--- 2. Count raw directions ---');
  const { data: allData, error: allDataErr } = await supabase
    .from('message_events')
    .select('id, direction, type');

  if (allDataErr) {
    console.error('Count Error:', allDataErr);
  } else {
    let inboundCount = 0;
    let outboundCount = 0;
    let nullDirectionCount = 0;
    let typeInboundDirOutboundCount = 0;
    let dirInboundTypeMismatchCount = 0;

    for (const row of allData) {
      if (row.direction === 'inbound') inboundCount++;
      else if (row.direction === 'outbound') outboundCount++;
      else nullDirectionCount++;

      if (row.type === 'inbound' && row.direction === 'outbound') typeInboundDirOutboundCount++;
      if (row.direction === 'inbound' && row.type !== 'inbound') dirInboundTypeMismatchCount++;
    }

    console.log(`Total Rows: ${allData.length}`);
    console.log(`Inbound Count: ${inboundCount}`);
    console.log(`Outbound Count: ${outboundCount}`);
    console.log(`Null/Invalid Direction Count: ${nullDirectionCount}`);
    console.log(`type=inbound but direction=outbound Count: ${typeInboundDirOutboundCount}`);
    console.log(`direction=inbound but type mismatch Count: ${dirInboundTypeMismatchCount}`);
  }

  console.log('\n--- 5. Backfill bad rows ---');

  // We fetch all rows and do it in JS to avoid needing raw SQL connection
  const { data: rowsToUpdate, error: fetchErr } = await supabase
    .from('message_events')
    .select('id, direction, type, event_type, received_at, sent_at');
    
  if (fetchErr) {
    console.error('Fetch for backfill error:', fetchErr);
    return;
  }

  const updatesInbound = [];
  const updatesOutbound = [];
  const updatesType = [];

  for (const row of rowsToUpdate) {
    const isEventTypeInbound = String(row.event_type || '').toLowerCase().includes('inbound');
    const isEventTypeOutbound = row.event_type === 'outbound_send';

    // Update 1
    if ((isEventTypeInbound || row.received_at !== null) && (row.direction === null || row.direction !== 'inbound')) {
      updatesInbound.push({ ...row, direction: 'inbound' });
    }
    // Update 2
    else if ((isEventTypeOutbound || row.sent_at !== null) && (row.direction === null || row.direction !== 'outbound') && row.received_at === null) {
      updatesOutbound.push({ ...row, direction: 'outbound' });
    }
  }

  console.log(`Found ${updatesInbound.length} rows to fix as inbound`);
  for (let i = 0; i < updatesInbound.length; i += 100) {
      const chunk = updatesInbound.slice(i, i + 100).map(r => ({id: r.id, direction: 'inbound'}));
      const { error } = await supabase.from('message_events').upsert(chunk);
      if (error) console.error('Upsert inbound error', error);
  }

  console.log(`Found ${updatesOutbound.length} rows to fix as outbound`);
  for (let i = 0; i < updatesOutbound.length; i += 100) {
      const chunk = updatesOutbound.slice(i, i + 100).map(r => ({id: r.id, direction: 'outbound'}));
      const { error } = await supabase.from('message_events').upsert(chunk);
      if (error) console.error('Upsert outbound error', error);
  }

  // Refetch for type updates
  const { data: rowsForType, error: typeFetchErr } = await supabase
    .from('message_events')
    .select('id, direction, type');

  for (const row of rowsForType) {
      if (['inbound', 'outbound'].includes(row.direction) && (row.type === null || row.type !== row.direction)) {
          updatesType.push({ ...row, type: row.direction });
      }
  }

  console.log(`Found ${updatesType.length} rows to fix type sync`);
  for (let i = 0; i < updatesType.length; i += 100) {
      const chunk = updatesType.slice(i, i + 100).map(r => ({id: r.id, type: r.direction}));
      const { error } = await supabase.from('message_events').upsert(chunk);
      if (error) console.error('Upsert type error', error);
  }

  console.log('Backfill complete!');
}

run();
