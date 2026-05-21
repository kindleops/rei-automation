import { runQueueBatch } from '../api/internal/queue/runner.ts';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
  const result = await runQueueBatch({ dry_run: true, sends_per_run: 5 });
  console.log(JSON.stringify(result, null, 2));
}

test();
