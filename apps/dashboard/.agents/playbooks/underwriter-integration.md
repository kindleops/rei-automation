# Underwriter Integration Playbook

## Overview
This playbook outlines how to integrate the Gemini Underwriter into the Nexus Dashboard UI.

## 1. Persistence Layer (Supabase)
Add a `comps_snapshot` column to the `offer_profiles` table to store the research data.

```sql
ALTER TABLE public.offer_profiles 
ADD COLUMN IF NOT EXISTS comps_snapshot jsonb;
```

## 2. API Endpoint
The endpoint is live at `/api/internal/offers/underwrite`.
It requires:
- `address`: string
- `propertyType`: 'sfh' | 'multifamily_small' | 'multifamily_large'
- `askingPrice`: number (optional)

## 3. UI Integration (Intelligence Panel)
1.  **File**: `src/modules/inbox/components/IntelligencePanel.tsx`
2.  **State**: Add `isUnderwriting` and `underwritingData` states.
3.  **Action**: Create a `handleUnderwrite` function.
    ```typescript
    const handleUnderwrite = async () => {
      setIsUnderwriting(true);
      try {
        const res = await fetch('/api/internal/offers/underwrite', {
          method: 'POST',
          body: JSON.stringify({ address: thread.subject, propertyType: thread.property_type })
        });
        const data = await res.json();
        setUnderwritingData(data);
      } finally {
        setIsUnderwriting(false);
      }
    }
    ```
4.  **Button**: Add a "Run AI Comps" button in the "EQUITY / VALUATION" section.

## 4. UI Integration (Acquisition Page)
1.  **File**: `src/modules/acquisition/AcquisitionPage.tsx`
2.  **Action**: Wire the "Underwrite" button to the same API.

## 5. Verification
- Run `npm run proof:system` to ensure no regressions.
- Verify the `GEMINI_API_KEY` is set in the environment.
