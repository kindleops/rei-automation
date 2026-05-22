import { calculateOwnerProspectAlignment, isIdentityEligibleForLiveOutbound } from "../src/lib/identity/ownerProspectAlignment.js";
import { resolveSellerIdentity } from "../src/lib/domain/outbound/supabase-candidate-feeder.js";

const testCases = [
  {
    name: "A. Lawndale Case (Re-evaluated): Kimberly Hart vs Susannah Mitchell (Potential Owner flag)",
    input: {
      masterOwnerName: "Kimberly C Hart",
      prospectFullName: "Susannah I Mitchell",
      matchingFlags: "Potential Owner",
      joinedPropertySource: "properties.master_owner_id",
      bestPhoneScore: 81
    },
    expected: { status: "household_associated", hardBlock: false, eligible: true, contactMode: "household_safe" }
  },
  {
    name: "B. Exact Owner Match: Kimberly C Hart vs Kimberly Hart",
    input: {
      masterOwnerName: "Kimberly C Hart",
      prospectFullName: "Kimberly Hart"
    },
    expected: { status: "verified", hardBlock: false, eligible: true, contactMode: "owner_verified" }
  },
  {
    name: "C. Same Last Name: Kimberly C Hart vs Michael Hart",
    input: {
      masterOwnerName: "Kimberly C Hart",
      prospectFullName: "Michael Hart"
    },
    expected: { status: "probable", hardBlock: false, eligible: true, contactMode: "owner_safe" }
  },
  {
    name: "D. Household Relative: Kimberly Hart vs Michael Hart (Relative flag)",
    input: {
      masterOwnerName: "Kimberly Hart",
      prospectFullName: "Michael Hart",
      personFlagsText: "Relative",
      joinedPropertySource: "properties.master_owner_id"
    },
    expected: { status: "household_associated", hardBlock: false, eligible: true, contactMode: "household_safe" }
  },
  {
    name: "E. Multi-Owner Spanish Intersection: Augustin Baca & Noelia Morales vs Agustin H Baca",
    input: {
      masterOwnerName: "Augustin Baca & Noelia Morales",
      prospectFullName: "Agustin H Baca"
    },
    expected: { status: "probable", hardBlock: false, eligible: true, contactMode: "owner_safe" }
  },
  {
    name: "F. Renter Contamination (No Linkage): Kimberly Hart vs Susannah Mitchell (Renter flag)",
    input: {
      masterOwnerName: "Kimberly Hart",
      prospectFullName: "Susannah Mitchell",
      personFlagsText: "Renter"
    },
    expected: { status: "mismatch", hardBlock: true, eligible: false, contactMode: "neutral" }
  },
  {
    name: "G. Corporate Owner Valid Contact: Hart Holdings LLC vs Kimberly Hart",
    input: {
      masterOwnerName: "Hart Holdings LLC",
      prospectFullName: "Kimberly Hart",
      likelyOwner: true
    },
    expected: { status: "verified", hardBlock: false, eligible: true, contactMode: "owner_verified" }
  },
  {
    name: "H. Corporate Owner Weak Contact: ABC Holdings LLC vs Susannah Mitchell",
    input: {
      masterOwnerName: "ABC Holdings LLC",
      prospectFullName: "Susannah Mitchell"
    },
    expected: { status: "weak", hardBlock: false, eligible: false, contactMode: "neutral" }
  },
  {
    name: "I. Random Mismatch (No Linkage): John Smith vs Jane Doe",
    input: {
      masterOwnerName: "John Smith",
      prospectFullName: "Jane Doe"
    },
    expected: { status: "mismatch", hardBlock: true, eligible: false, contactMode: "neutral" }
  },
  {
    name: "J. High Phone Score Mismatch (Should still block without linkage)",
    input: {
      masterOwnerName: "John Smith",
      prospectFullName: "Jane Doe",
      bestPhoneScore: 100
    },
    expected: { status: "mismatch", hardBlock: true, eligible: false, contactMode: "neutral" }
  },
  {
    name: "K. Household Spouse: Kimberly Hart vs John Hart (Spouse flag)",
    input: {
      masterOwnerName: "Kimberly Hart",
      prospectFullName: "John Hart",
      personFlagsText: "Spouse",
      joinedPropertySource: "properties.master_owner_id"
    },
    expected: { status: "household_associated", hardBlock: false, eligible: true, contactMode: "household_safe" }
  }
];

console.log("=== Running Identity Guard & Policy Proof Tests ===\n");

let failures = 0;

testCases.forEach((tc) => {
  const alignment = calculateOwnerProspectAlignment(tc.input);
  const policyDefault = isIdentityEligibleForLiveOutbound(alignment, {});
  const policyAllowWeak = isIdentityEligibleForLiveOutbound(alignment, { allow_weak_identity_outbound: true });

  const statusMatch = alignment.status === tc.expected.status;
  const blockMatch = alignment.hardBlock === tc.expected.hardBlock;
  const eligibleMatch = policyDefault.eligible === tc.expected.eligible;
  const modeMatch = alignment.contactMode === tc.expected.contactMode;

  if (statusMatch && blockMatch && eligibleMatch && modeMatch) {
    console.log(`✅ [PASS] ${tc.name}`);
  } else {
    failures++;
    console.log(`❌ [FAIL] ${tc.name}`);
    console.log(`   Expected: status=${tc.expected.status}, hardBlock=${tc.expected.hardBlock}, eligible=${tc.expected.eligible}, contactMode=${tc.expected.contactMode}`);
    console.log(`   Actual:   status=${alignment.status}, hardBlock=${alignment.hardBlock}, eligible=${policyDefault.eligible}, contactMode=${alignment.contactMode}`);
    console.log(`   Reasons:  ${alignment.reasons.join(", ")}`);
    console.log(`   Policy Reason: ${policyDefault.reason}`);
  }

  // Allow Weak Override Check
  if (alignment.status === "weak" || alignment.status === "unknown") {
    if (!policyAllowWeak.eligible) {
      console.log(`   ❌ [POLICY FAIL] Weak override failed for ${tc.name}`);
      failures++;
    } else {
      console.log(`   ✅ [POLICY PASS] Weak override allowed for ${tc.name}`);
    }
  }

  // Safe Hydration Guard Check
  const candidate = {
    ...tc.input,
    identity_alignment: alignment,
    seller_name_missing: false,
    owner_first_name: "Kimberly",
    prospect_first_name: "Susannah"
  };

  const resolved = resolveSellerIdentity(candidate);
  const isMismatch = alignment.status === 'mismatch';
  const isWeakOrUnknown = ['weak', 'unknown'].includes(alignment.status);
  const isHousehold = alignment.status === 'household_associated';

  if (isMismatch && resolved) {
     if (resolved.seller_first_name === "Susannah") {
       console.log(`   ❌ [SAFETY FAIL] Used mismatched prospect first name!`);
       failures++;
     }
  }

  if (isWeakOrUnknown || isHousehold) {
    if (resolved && resolved.seller_first_name === "Susannah") {
       console.log(`   ❌ [SAFETY FAIL] Used untrusted prospect first name for status: ${alignment.status}`);
       failures++;
    }
  }
});

console.log(`\n=== Tests Finished: ${testCases.length - failures}/${testCases.length} passed ===`);

if (failures > 0) {
  process.exit(1);
}
