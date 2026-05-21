
import { checkRepeatContactAndBlacklist } from '../../api/internal/queue/utils';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function verify() {
  const phone = '+13025077311';
  const propertyId = '251122250';
  const masterOwnerId = 'mo_012f9cc52b87a2e91a726bfc';

  console.log('--- Verifying Cecilia Suppression Fix ---');
  console.log(`Checking suppression for Phone: ${phone}, Property: ${propertyId}, Owner: ${masterOwnerId}`);

  try {
    const result = await checkRepeatContactAndBlacklist({
      phone,
      prospectId: 'any_prospect',
      masterOwnerId,
      propertyId,
      stageCode: 'ownership_check',
      touchNumber: 1
    });

    console.log('\nSuppression Result:', JSON.stringify(result, null, 2));

    if (!result.safe) {
      console.log('\n✅ SUCCESS: Contact is suppressed.');
      console.log(`Reason: ${result.reason}`);
    } else {
      console.log('\n❌ FAILURE: Contact is NOT suppressed!');
    }
  } catch (error) {
    console.error('\nError during verification:', error);
  }
}

verify();
