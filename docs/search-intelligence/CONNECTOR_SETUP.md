# Search Intelligence — connector setup (for Ryan)

Status on 2026-10-04: **no connector is configured, and none is required for V1.** Every
property shows its plan; live surfaces say *Awaiting site launch* or *Search Console
not connected* until the steps below are done. This document names the secrets
Search Intelligence will look for. It never contains their values. Do not paste a key,
token or JSON file into chat, a ticket, a commit or a database row.

## How credentials work here

- Connectors run **server-side only** (`apps/api/src/lib/domain/search-intelligence/`).
  The browser bundle never sees a credential.
- A connection row (`search_property_connections`, proposed, not applied) stores a
  secret **reference**, which is a name like `SI_GSC_SERVICE_ACCOUNT`. It never stores the secret.
  The code rejects anything shaped like key material, and so does the proposed table
  check.
- Secret values live in the production runtime's secret store (Cloudflare Worker /
  Container secrets, set with `wrangler secret put <NAME>` or the Cloudflare dashboard).
- Every connector is read-only by scope.

## 1. Google Search Console (primary; needed once a site is live)

1. **Verify each domain property** in Search Console as a *Domain* property
   (`sc-domain:…`), using the DNS TXT record at the DNS host:
   - `sc-domain:prominentcashoffer.com`
   - `sc-domain:offerr.ai`
   - `sc-domain:reivesti.com`: a legacy property already exists (its exports were
     ingested by the Reivesti SEO lane). Check that it is a *Domain* property and not
     only the `www` URL-prefix one.
   - `sc-domain:leadcommand.ai`: **do not add `ops.leadcommand.ai`**. It is the operator
     app and is excluded.
2. **Create a Google Cloud project** for Search Intelligence, or reuse one you
   control. Enable the **Google Search Console API**.
3. **Create a service account** in that project (for example `search-intelligence-reader`).
   Create one JSON key for it.
4. In Search Console, **add the service-account email as a user with *Restricted*
   permission** on each property above. Restricted is read-only, and that is all the
   connector needs (`webmasters.readonly`).
5. Store the JSON key as the secret **`SI_GSC_SERVICE_ACCOUNT`** in the production
   runtime. Do this from your terminal or the Cloudflare dashboard, never through an
   agent. Delete the downloaded file afterwards.
6. Record each property identifier (`sc-domain:…`, which is not a secret) on its
   connection row as `provider_property`, and set `secret_ref = 'SI_GSC_SERVICE_ACCOUNT'`.

The connector's state then moves `NOT_CONFIGURED → AWAITING_ACCESS → VERIFYING`. It
becomes `CONNECTED` after its first successful read-only sync. Search Console reports
with a 2–3 day lag, and a day with no row is "not yet reported", never zero.

## 2. Google Analytics 4 (optional; only if a GA4 property exists)

GA4 is not assumed to exist. The Reivesti cutover notes reference a legacy GA4
property, and no other property is known.

1. In GA4 → Admin → Property access management, add the **same service-account email**
   as **Viewer**.
2. Record the numeric GA4 property ID (not a secret) as `provider_property`, and set
   `secret_ref = 'SI_GSC_SERVICE_ACCOUNT'` (the same key; scope `analytics.readonly`).
   Alternatively use a separate key stored as `SI_GA4_SERVICE_ACCOUNT`.

## 3. Cloudflare Web Analytics (optional; independent of Google)

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → *Custom*, with the
   permission **Account → Account Analytics → Read** only.
2. Store it as **`SI_CF_ANALYTICS_TOKEN`**. Record the site tag (not a secret) as
   `provider_property`.

## 4. External research (optional; none is required)

Choose at most one vendor if volume or difficulty context is wanted:

- DataForSEO: store as `SI_DATAFORSEO_LOGIN` and `SI_DATAFORSEO_PASSWORD`.
- Semrush: `SI_SEMRUSH_API_KEY`
- Ahrefs: `SI_AHREFS_API_KEY`

Results are dated and cached per keyword. Search Intelligence never ranks a cluster by
volume it does not have.

## 5. First-party telemetry and the LeadCommand bridge

These need no third-party credential, and V1 deploys neither. The event contract (13
events, opaque IDs, no contact data) is in
`apps/dashboard/src/modules/search-intelligence/domain/telemetry.ts`. The bridge contract
(an opaque attribution token in, aggregate outcomes out, no seller records) is in
`domain/bridge.ts`. Both need owner approval before any tracking or attribution is
wired.

## 6. Order of operations

1. Owner review and approval of
   `supabase/migrations/PROPOSED_20261004120000_search_intelligence_os_v1.sql` (with its
   rollback). It supersedes the unapplied 10-01 proposal.
2. Apply it through the normal migration channel. Then seed the planning snapshots as a
   separate, reviewed data migration.
3. Complete step 1 for each property **when its site is live**. Steps 2–4 are optional.
4. Approve the read-only sync job in `apps/api` (not built in V1).

## What not to do

- Do not create credentials through an agent session, and do not paste them into chat.
- Do not grant *Full* or *Owner* Search Console permission to the service account.
- Do not add `ops.leadcommand.ai` as a property.
- Do not store a key in a `search_property_connections` row. The row holds the name only.
