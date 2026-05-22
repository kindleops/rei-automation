import { hasSupabaseConfig, supabase as defaultSupabase } from "../src/lib/supabase/client.js";
import { calculateOwnerProspectAlignment } from "../src/lib/identity/ownerProspectAlignment.js";
import { normalizeCandidateRow } from "../src/lib/domain/outbound/supabase-candidate-feeder.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    limit: 1000,
    full: false,
    market: null,
    minScore: 0,
    json: false,
    csv: false,
  };

  args.forEach(arg => {
    if (arg.startsWith('--limit=')) options.limit = parseInt(arg.split('=')[1]);
    if (arg === '--full') options.full = true;
    if (arg.startsWith('--market=')) options.market = arg.split('=')[1];
    if (arg.startsWith('--min-score=')) options.minScore = parseInt(arg.split('=')[1]);
    if (arg === '--json') options.json = true;
    if (arg === '--csv') options.csv = true;
  });

  return options;
}

async function runAudit() {
  const options = parseArgs();

  if (!hasSupabaseConfig()) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const isQuiet = options.json || options.csv;

  if (!isQuiet) {
    console.log("=== Starting Identity Alignment Audit ===");
    console.log(`Options: limit=${options.full ? 'unlimited' : options.limit}, market=${options.market || 'all'}, minScore=${options.minScore}\n`);
  }

  // 1. Get total count first for progress reporting
  let countQuery = defaultSupabase
    .from("outbound_candidate_snapshot")
    .select("*", { count: 'exact', head: true })
    .eq("sms_eligible", true);

  if (options.market) {
    countQuery = countQuery.eq("market", options.market);
  }

  const { count: totalEligible, error: countError } = await countQuery;
  
  if (countError) {
    console.error("Error getting candidate count:", countError.message);
    process.exit(1);
  }

  const targetScanCount = options.full ? totalEligible : Math.min(options.limit, totalEligible);

  if (!isQuiet) {
    console.log(`Expected candidate count: ${totalEligible}`);
    console.log(`Target scan count:   ${targetScanCount}\n`);
  }

  const results = {
    totalScanned: 0,
    counts: {
      verified: 0,
      probable: 0,
      household_associated: 0,
      weak: 0,
      unknown: 0,
      mismatch: 0,
      hardBlock: 0,
    },
    marketContamination: {},
    sourceContamination: {},
    highRiskMismatches: [], // score >= 70 but mismatch
    mismatches: [],
    weak: [],
    household: [],
  };

  const PAGE_SIZE = 1000;
  let offset = 0;

  while (results.totalScanned < targetScanCount) {
    const currentLimit = Math.min(PAGE_SIZE, targetScanCount - results.totalScanned);
    const rangeStart = offset;
    const rangeEnd = offset + currentLimit - 1;

    let query = defaultSupabase
      .from("outbound_candidate_snapshot")
      .select("*")
      .eq("sms_eligible", true)
      .range(rangeStart, rangeEnd);

    if (options.market) {
      query = query.eq("market", options.market);
    }

    const { data: candidates, error } = await query;

    if (error) {
      console.error(`Error fetching candidates at offset ${offset}:`, error.message);
      process.exit(1);
    }

    if (!candidates || candidates.length === 0) break;

    candidates.forEach((row) => {
      const candidate = normalizeCandidateRow(row);
      const alignment = candidate.identity_alignment;

      results.counts[alignment.status]++;
      if (alignment.hardBlock) results.counts.hardBlock++;

      // Track market contamination
      const market = candidate.market || "Unknown";
      if (!results.marketContamination[market]) results.marketContamination[market] = { total: 0, mismatch: 0 };
      results.marketContamination[market].total++;
      if (alignment.status === 'mismatch') results.marketContamination[market].mismatch++;

      // Track source contamination
      const source = candidate.joined_property_source || "Unknown";
      if (!results.sourceContamination[source]) results.sourceContamination[source] = { total: 0, mismatch: 0 };
      results.sourceContamination[source].total++;
      if (alignment.status === 'mismatch') results.sourceContamination[source].mismatch++;

      const item = { candidate, alignment };
      if (alignment.status === 'mismatch') {
        results.mismatches.push(item);
        if (candidate.best_phone_score >= 70) {
          results.highRiskMismatches.push(item);
        }
      } else if (alignment.status === 'weak') {
        results.weak.push(item);
      } else if (alignment.status === 'household_associated') {
        results.household.push(item);
      }
      
      results.totalScanned++;
    });

    offset += candidates.length;

    if (!isQuiet) {
      process.stdout.write(`Processed ${results.totalScanned} / ${targetScanCount}...\r`);
    }

    if (candidates.length < currentLimit) break;
  }

  if (!isQuiet) {
    process.stdout.write('\n\n');
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (options.csv) {
    console.log("Property Address,Owner Name,Prospect Name,Status,Score,Best Phone Score,Source,Market,Reasons");
    results.mismatches.forEach(m => {
      console.log(`"${m.candidate.property_address_full}","${m.candidate.owner_display_name}","${m.candidate.prospect_full_name}","${m.alignment.status}",${m.alignment.score},${m.candidate.best_phone_score},"${m.candidate.joined_property_source}","${m.candidate.market}","${m.alignment.reasons.join('; ')}"`);
    });
    return;
  }

  console.log(`Scanned:    ${results.totalScanned}`);
  console.log(`Verified:   ${results.counts.verified}`);
  console.log(`Probable:   ${results.counts.probable}`);
  console.log(`Household:  ${results.counts.household_associated}`);
  console.log(`Weak:       ${results.counts.weak}`);
  console.log(`Unknown:    ${results.counts.unknown}`);
  console.log(`Mismatch:   ${results.counts.mismatch}`);
  console.log(`Hard Block: ${results.counts.hardBlock}`);
  console.log(`Rate:       ${((results.counts.mismatch / results.totalScanned) * 100).toFixed(2)}%\n`);

  const eligible = results.counts.verified + results.counts.probable + results.counts.household_associated;
  const held = results.counts.weak + results.counts.unknown;
  const quarantined = results.counts.mismatch;

  console.log("--- Default Policy Impact ---");
  console.log(`Eligible:    ${eligible} (Verified/Probable/Household)`);
  console.log(`Held:        ${held} (Weak/Unknown)`);
  console.log(`Quarantined: ${quarantined} (Mismatch)`);
  console.log("-----------------------------\n");

  console.log("Top Contaminated Markets:");
  Object.entries(results.marketContamination)
    .sort((a, b) => b[1].mismatch - a[1].mismatch)
    .slice(0, 5)
    .forEach(([market, data]) => {
      const rate = (data.mismatch / data.total) * 100;
      let recommendation = "Safe";
      if (rate > 25) recommendation = "⚠️ REVIEW SOURCE (CRITICAL CONTAMINATION)";
      else if (rate > 15) recommendation = "⚠️ REVIEW SOURCE (HIGH CONTAMINATION)";
      else if (rate > 5) recommendation = "Monitor Source";
      
      console.log(` - ${market}: ${data.mismatch} mismatches (${rate.toFixed(1)}%) -> ${recommendation}`);
    });

  console.log("\nTop Contaminated Sources:");
  Object.entries(results.sourceContamination)
    .sort((a, b) => b[1].mismatch - a[1].mismatch)
    .slice(0, 5)
    .forEach(([source, data]) => {
      console.log(` - ${source}: ${data.mismatch} mismatches (${((data.mismatch / data.total) * 100).toFixed(1)}%)`);
    });

  if (results.highRiskMismatches.length > 0) {
    console.log(`\n🔥 HIGH RISK MISMATCHES (Score >= 70 but Mismatch): ${results.highRiskMismatches.length}`);
    console.log("Recommendation: Hard Block & Quarantine");
    results.highRiskMismatches.slice(0, 10).forEach((m, i) => {
      console.log(`[${i + 1}] ${m.candidate.property_address_full}`);
      console.log(`    Owner:    ${m.candidate.owner_display_name}`);
      console.log(`    Prospect: ${m.candidate.prospect_full_name}`);
      console.log(`    Phone:    ${m.candidate.canonical_e164} (Score: ${m.candidate.best_phone_score})`);
    });
  }

  if (results.household.length > 0) {
    console.log(`\n🏠 HOUSEHOLD ASSOCIATED EXAMPLES: ${results.household.length}`);
    console.log("Recommendation: Proceed with Neutral/Household-Safe Messaging ONLY");
    results.household.slice(0, 5).forEach((m, i) => {
      console.log(`[${i + 1}] ${m.candidate.property_address_full}`);
      console.log(`    Owner:    ${m.candidate.owner_display_name}`);
      console.log(`    Prospect: ${m.candidate.prospect_full_name}`);
      console.log(`    Score:    ${m.alignment.score}`);
      console.log(`    Reasons:  ${m.alignment.reasons.join(", ")}`);
    });
  }

  if (results.weak.length > 0) {
    console.log(`\n⚠️ WEAK ALIGNMENT EXAMPLES: ${results.weak.length}`);
    console.log("Recommendation: Hold (Default) or Proceed with Owner-Derived Name Only");
    results.weak.slice(0, 5).forEach((m, i) => {
      console.log(`[${i + 1}] ${m.candidate.property_address_full}`);
      console.log(`    Owner:    ${m.candidate.owner_display_name}`);
      console.log(`    Prospect: ${m.candidate.prospect_full_name}`);
      console.log(`    Score:    ${m.alignment.score}`);
    });
  }

  if (results.mismatches.length > 0) {
    console.log(`\n❌ Top Mismatch Examples:`);
    console.log("Recommendation: Hard Block & Quarantine");
    results.mismatches.slice(0, 10).forEach((m, i) => {
      console.log(`[${i + 1}] ${m.candidate.property_address_full}`);
      console.log(`    Owner:    ${m.candidate.owner_display_name}`);
      console.log(`    Prospect: ${m.candidate.prospect_full_name}`);
      console.log(`    Result:   ${m.alignment.status} (Score: ${m.alignment.score})`);
      console.log(`    Reasons:  ${m.alignment.reasons.join(", ")}`);
    });
  }

  console.log("\n=== Audit Complete ===");
}

runAudit().catch(console.error);
