
import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";
import { config } from "dotenv";
config();

async function main() {
  console.log("Starting manual queue run...");
  try {
    const result = await runSendQueue({ limit: 1 });
    console.log("Queue run result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Queue run failed:", error);
  }
}

main();
