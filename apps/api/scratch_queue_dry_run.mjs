import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";

async function main() {
  console.log("Starting manual queue run (DRY RUN)...");
  try {
    const result = await runSendQueue({ limit: 10, dry_run: true });
    console.log("Queue run result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Queue run failed:", error);
    console.error("Error Stack:", error.stack);
  }
}

main();