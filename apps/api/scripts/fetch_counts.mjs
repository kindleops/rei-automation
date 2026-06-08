import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

// Load .env.local
const envPath = path.resolve(process.cwd(), ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
envContent.split("\n").forEach((line) => {
  const match = line.match(/^([^#][^=]+)=(.*)$/);
  if (match) {
    process.env[match[1]] = match[2];
  }
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const { data, error } = await supabase
    .from("campaign_target_graph_refresh_runs")
    .select("metadata")
    .order("finished_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error fetching runs:", error);
    process.exit(1);
  }

  if (data && data.length > 0) {
    console.log("Latest Refresh Metadata:");
    console.log(JSON.stringify(data[0].metadata, null, 2));
  } else {
    console.log("No runs found.");
  }
}

main();
