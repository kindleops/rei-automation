import pg from 'pg';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: './.env.local' });

const { Client } = pg;
const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_URL_NO_POOL || process.env.SUPABASE_DB_URL; // Whichever has postgres:// format
console.log("Available keys:", Object.keys(process.env).filter(k => k.includes('URL') || k.includes('DB') || k.includes('SUPABASE')));

if (!dbUrl) {
    console.error("No DATABASE_URL found.");
    process.exit(1);
}

const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function runMigration() {
    try {
        await client.connect();
        const filePath = process.argv[2] || './supabase/migrations/20260525165900_add_wrong_number_and_expanded_view.sql';
        const sql = fs.readFileSync(filePath, 'utf8');
        await client.query(sql);
        console.log("Migration applied successfully!");
    } catch (e) {
        console.error("Migration failed:", e);
    } finally {
        await client.end();
    }
}

runMigration();
