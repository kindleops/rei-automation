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

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectId = "lcppdrmrdfblstpcbgpf";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20260606041905_campaign_sender_coverage_safe_route_lockin.sql");
const sql = fs.readFileSync(migrationPath, "utf-8");

async function applyMigration() {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: sql })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Failed to execute SQL:", response.status, errorText);
    process.exit(1);
  }

  console.log("Migration executed successfully!");
}

applyMigration();
