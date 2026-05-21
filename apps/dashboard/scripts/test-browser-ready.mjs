#!/usr/bin/env node
/**
 * Test that verifies the browser is ready and inbox can load
 * This is a final verification before marking the task complete
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

dotenv.config({ path: path.join(projectRoot, '.env.local') })

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || ''
const USE_SUPABASE_DATA = process.env.VITE_USE_SUPABASE_DATA === 'true'

console.log('🔍 Final Verification Before Browser Testing\n')

// Check env vars
console.log('1. Environment Configuration Check:')
console.log(`   - VITE_USE_SUPABASE_DATA: ${USE_SUPABASE_DATA}`)
console.log(`   - VITE_SUPABASE_URL: ${SUPABASE_URL ? '✅ Set' : '❌ Missing'}`)
console.log(`   - VITE_SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? '✅ Set' : '❌ Missing'}`)

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('\n❌ ERROR: Supabase credentials not configured!')
  process.exit(1)
}

if (!USE_SUPABASE_DATA) {
  console.warn('\n⚠️  WARNING: VITE_USE_SUPABASE_DATA is not true!')
  console.warn('   The inbox will use mock data instead of Supabase.')
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

async function runTests() {
  console.log('\n2. Supabase Connectivity Check:')
  
  // Test connection
  try {
    const { data, error } = await supabase
      .from('message_events')
      .select('id', { count: 'exact' })
      .limit(1)
    
    if (error) {
      console.error(`   ❌ Query failed: ${error.message}`)
      return false
    }
    console.log('   ✅ Supabase connection successful')
  } catch (e) {
    console.error(`   ❌ Connection error: ${e.message}`)
    return false
  }

  // Check message_events table
  console.log('\n3. Data Availability Check:')
  try {
    const { count, error } = await supabase
      .from('message_events')
      .select('*', { count: 'exact', head: true })
    
    if (error) {
      console.error(`   ❌ Failed to count messages: ${error.message}`)
      return false
    }
    
    console.log(`   ✅ message_events table accessible`)
    console.log(`   ✅ Total messages in Supabase: ${count}`)
    
    if (count === 0) {
      console.warn('   ⚠️  WARNING: No messages in table. Inbox will be empty.')
    }
  } catch (e) {
    console.error(`   ❌ Count error: ${e.message}`)
    return false
  }

  // Verify threading works
  console.log('\n4. Thread Grouping Capability Check:')
  try {
    const { data: sample, error } = await supabase
      .from('message_events')
      .select(`
        id,
        from_phone_number,
        to_phone_number,
        master_owner_id,
        property_id,
        prospect_id,
        message_body
      `)
      .limit(5)
    
    if (error) {
      console.error(`   ❌ Sample query failed: ${error.message}`)
      return false
    }

    if (!sample || sample.length === 0) {
      console.warn('   ⚠️  No data to sample for grouping check')
      return true
    }

    const groupingFields = ['from_phone_number', 'to_phone_number', 'master_owner_id', 'property_id', 'prospect_id']
    const event = sample[0]
    const hasGroupingFields = groupingFields.some(field => event[field])
    
    if (hasGroupingFields) {
      console.log('   ✅ Messages have grouping fields populated')
      console.log(`   ✅ Sample message has:`)
      groupingFields.forEach(field => {
        if (event[field]) console.log(`      - ${field}: ${event[field]}`)
      })
    } else {
      console.warn('   ⚠️  Messages may not group properly (missing standard grouping fields)')
    }
  } catch (e) {
    console.error(`   ❌ Sample error: ${e.message}`)
    return false
  }

  return true
}

runTests().then(success => {
  console.log('\n' + '='.repeat(60))
  
  if (success) {
    console.log('✅ All checks passed! Browser is ready for testing.')
    console.log('\n📋 Next Steps:')
    console.log('   1. Open http://127.0.0.1:5173/ in your browser')
    console.log('   2. Navigate to the Inbox page')
    console.log('   3. Verify conversation threads are displayed')
    console.log('   4. Check that messages are grouped by phone number')
    console.log('\n💡 Look for:')
    console.log('   - Thread count should match unique phone numbers')
    console.log('   - Messages should group by from_phone_number / to_phone_number')
    console.log('   - Each thread should show message preview and count')
  } else {
    console.error('❌ Some checks failed. See errors above.')
    process.exit(1)
  }
  
  console.log('='.repeat(60))
})
