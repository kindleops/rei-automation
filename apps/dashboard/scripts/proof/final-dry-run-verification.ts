
import dotenv from 'dotenv';
import path from 'path';

// Load env before ANY dynamic imports
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function runVerification() {
  console.log('--- Running Final Dry-Run Verification (Dynamic) ---');
  
  // Dynamic import after env is loaded
  const { default: buildOutbound } = await import('../../api/internal/queue/build-outbound');

  const mockRes = {
    status: (code: number) => {
      console.log(`[Response Status]: ${code}`);
      return mockRes;
    },
    json: (body: any) => {
      console.log(`\n--- Dry-Run Result ---`);
      console.log(`Processed: ${body.processedCount}`);
      console.log(`Created (Dry): ${body.createdCount}`);
      console.log(`Skipped: ${body.skippedCount}`);
      console.log(`Blocked: ${body.blockedCount}`);
      
      if (body.results) {
         // Cecilia's phone: +13025077311
         const cecilia = body.results.find((r: any) => r.phone === '+13025077311' || r.prospectId === 'ph_a7bd8783a84e9232283ba3c7');
         if (cecilia) {
           console.log(`\nCecilia result found in batch:`, JSON.stringify(cecilia, null, 2));
         } else {
           console.log(`\nCecilia was not in the processed result set.`);
         }

         const blockedReasons = body.results.filter((r: any) => r.status === 'blocked').reduce((acc: any, r: any) => {
           acc[r.reason] = (acc[r.reason] || 0) + 1;
           return acc;
         }, {});
         console.log(`\nBlocked Reasons Breakdown:`, JSON.stringify(blockedReasons, null, 2));

         const sampleSends = body.results.filter((r: any) => r.status === 'success' || r.status === 'created');
         console.log(`\nSample Created Queue Items (Top 3):`, JSON.stringify(sampleSends.slice(0, 3), null, 2));
      }
    }
  };

  const req = {
    method: 'POST',
    body: {
      limit: 25,
      scan_limit: 1000,
      dry_run: true,
      touch_number: 1,
      within_contact_window_now: true
    }
  };

  try {
    await buildOutbound(req as any, mockRes as any);
  } catch (error) {
    console.error('Execution Error:', error);
  }
}

runVerification();
