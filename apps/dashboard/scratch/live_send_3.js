import { runQueueBatch } from '../api/internal/queue/runner.ts';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
  console.log('--- STARTING LIVE RUN (LIMIT 3) ---');
  const result = await runQueueBatch({ dry_run: false, sends_per_run: 3 });
  console.log(JSON.stringify(result, null, 2));
  console.log('--- LIVE RUN COMPLETE ---');
}

test();
