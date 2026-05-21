# Wholesale Deal Underwriter Skill

## Purpose
Run in-depth numbers and research comparables (comps) for SFR and Multifamily deals using a combination of Gemini-driven research and deterministic financial validation.

## When to Use
- When a new property lead is identified.
- When an inbound message includes an address or asking price.
- Before generating a formal cash offer.

## TRUTH SOURCE PRIORITY

### Preferred SFR Comp Sources:
1.  **Zillow Sold Listings**
2.  **Redfin Sold Listings**
3.  **Realtor.com Sold Listings**
4.  **County Assessor / County Recorder**
5.  **Google Maps / Street View**
6.  **Internal Supabase Property Data**

### Preferred Rental Sources:
1.  **Zillow Rentals**
2.  **Rentometer**
3.  **Apartments.com**
4.  **Realtor Rental Listings**

### Preferred Multifamily/Commercial Sources:
1.  **Crexi**
2.  **LoopNet**
3.  **Apartments.com**
4.  **County Records**
5.  **Local Broker Listings**

## Operational Rules
1.  **Sold > Active**: Sold comps always override active listing prices.
2.  **Public Records > Estimates**: County/public records override Zestimates or Redfin estimates.
3.  **No Estimate ARV**: Never use Zestimate or Redfin Estimate as the final ARV.
4.  **Recency & Proximity**:
    -   Prefer sold comps within **0.5 miles** and **6 months**.
    -   Expand to 1 mile and 12 months only if no other data is available.
5.  **Strict Matching**: Match property type, beds, baths, sqft, year built, and condition.
6.  **Deterministic MAO**: Gemini provides the research (ARV, Repairs, Comps). The final MAO is calculated by the system formula:
    -   **SFR**: `MAO = (ARV * 0.70) - Repairs - $20,000 (Min)`
    -   **Multifamily**: `MAO = (ARV * 0.70) - Repairs - $50,000 (Min)` (or 3-5% of purchase price).
7.  **Evidence Required**: Every comp must have a source URL.

## Failure Detection
-   Flag "Weak Comp" if the distance is > 1 mile or age is > 12 months.
-   Flag "High Variance" if comps vary by more than 20%.

## Anti-Patterns
-   Using active listings to justify a high ARV.
-   Ignoring proximity rules to find "better" numbers.
-   Accepting Gemini's MAO without running it through the deterministic calculator.
