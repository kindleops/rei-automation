import { calculateWholesaleDeal } from '../src/lib/underwriting/calculator.js'

async function testCalculator() {
  console.log('🧪 Testing Deterministic MAO Calculator...\n')
  
  // Test Case 1: Standard SFR
  const sfrInput = {
    propertyType: 'sfh',
    arv: 200000,
    repairs: 30000,
    askingPrice: 80000
  }
  const sfrResult = calculateWholesaleDeal(sfrInput)
  
  console.log('--- SFR Deal ($200k ARV, $30k Repairs, $80k Asking) ---')
  console.log('MAO:', sfrResult.mao)
  console.log('Target Fee:', sfrResult.assignmentFee)
  console.log('Verdict:', sfrResult.verdict)
  console.log('Score:', sfrResult.score)
  
  if (sfrResult.mao === 90000 && sfrResult.assignmentFee === 20000) {
    console.log('✅ SFR MAO Calculation Correct')
  } else {
    console.error('❌ SFR MAO Calculation Failed. Got:', sfrResult.mao)
    process.exit(1)
  }

  // Test Case 2: Multifamily
  const mfInput = {
    propertyType: 'multifamily_small',
    arv: 2000000,
    repairs: 200000,
    askingPrice: 1200000
  }
  const mfResult = calculateWholesaleDeal(mfInput)
  
  console.log('\n--- Multifamily Deal ($2M ARV, $200k Repairs) ---')
  console.log('MAO:', mfResult.mao)
  console.log('Target Fee (5%):', mfResult.assignmentFee)
  
  // (2M * 0.7) - 200k - 100k = 1.1M
  if (mfResult.mao === 1100000 && mfResult.assignmentFee === 100000) {
    console.log('✅ Multifamily MAO Calculation Correct')
  } else {
    console.error('❌ Multifamily MAO Calculation Failed. Got:', mfResult.mao)
    process.exit(1)
  }

  console.log('\n✨ All Underwriting Calculator Proofs Passed!')
}

testCalculator()
